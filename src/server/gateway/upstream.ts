/**
 * 把一次归一化后的请求真正发给某个账户对应的上游。
 *
 * 这一层只管「发」和「把响应变成 Anthropic 事件流」，不认识账号池、重试和鉴权。
 * 出站统一走 server/http.ts：代理、超时和请求日志都在那里，转发的每一条请求因此和
 * 保活、额度查询出现在同一份日志里，排障时不必分两处看。
 */
import { randomBytes } from 'node:crypto';
import { auditOf, type Account } from '../creds.js';
import { claudeMessagesHeaders, codexResponsesHeaders, diagnose } from '../headers.js';
import { noteError, request, type HttpResponse } from '../http.js';
import { parseSse } from './sse.js';
import { toCodexRequest } from './codex.js';
import { fromCodexStream } from './codex.js';
import { fromQoderStream, qoderTierFor, toQoderBody } from './qoder.js';
import { assertQoderIdentity, getJobToken, getUid, QoderAuthError } from './qoder-auth.js';
import { cosyVersion } from './qoder-version.js';
import { signer } from './qoder-signer.js';
import type { AnthropicRequest, EventStream } from './anthropic.js';

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';
/** Qoder 推理端点的上游主机;api1/2/3 是等价镜像,官方默认 api3。 */
const QODER_INFER_BASE = 'https://api3.qoder.sh';
/** Qoder 原生 CLI 走的 User-Agent;签名器不产生它,转发时补上。 */
const QODER_INFER_USER_AGENT = 'Bun/1.3.14';

/**
 * 转发请求的超时。
 *
 * 比保活那条长得多：真实对话可以跑很久，尤其是带工具调用的长回合。但仍然要有上限——
 * 挂死的连接会一直占着这个账户的在飞计数，界面上看就是一个永远「忙碌」的账户。
 */
const FORWARD_TIMEOUT_MS = 10 * 60_000;

/**
 * Claude Code 的身份前缀。
 *
 * OAuth 令牌是签给 Claude Code 的，上游据此校验调用方：system 的第一段不是这句话时，
 * `/v1/messages` 会直接拒掉这次请求。所以转发时要把它插到客户端自己的 system 前面，
 * 而不是替换——客户端的提示词一个字都不能丢。
 */
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 这次失败该不该记到账户头上，由 pool.blamesAccount 判定后填进来。 */
    readonly body = '',
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/** system 前面补上 Claude Code 那一段；已经有了就不重复加。 */
function withClaudeIdentity(system: AnthropicRequest['system']): unknown[] {
  const prefix = { type: 'text', text: CLAUDE_CODE_SYSTEM };
  if (system === undefined || system === '') return [prefix];
  if (typeof system === 'string') {
    return system.startsWith(CLAUDE_CODE_SYSTEM) ? [{ type: 'text', text: system }] : [prefix, { type: 'text', text: system }];
  }
  const blocks = Array.isArray(system) ? system : [];
  const first = blocks[0];
  if (first && first.type === 'text' && String(first.text ?? '').startsWith(CLAUDE_CODE_SYSTEM)) return blocks;
  return [prefix, ...blocks];
}

/** 客户端在 anthropic-beta 里声明的实验特性，原样带给上游。 */
export function betasFrom(header: string | undefined): string[] {
  return (header ?? '')
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);
}

async function failure(account: Account, resp: HttpResponse, audit: ReturnType<typeof auditOf>): Promise<never> {
  const body = await resp.text();
  const detail = `${body.slice(0, 500)}${diagnose(resp.headers, body)}`;
  noteError(audit, detail);
  throw new UpstreamError(resp.status, `${account.email} 上游返回 ${resp.status}: ${detail}`, body);
}

export interface ForwardOptions {
  /** 实际要发给上游的模型名，已按目标 provider 解析过。 */
  model: string;
  /** 客户端自己声明的 anthropic-beta，只对 Claude 上游有意义。 */
  betas?: string[];
  /**
   * Qoder 转发的凭证:账户页面单独设的 PAT 与本账户固定的 machine_id。
   * 只在目标是 Qoder 账户时给,由 service 层从库里那一行读出来。
   */
  qoder?: { pat: string; machineId: string; userId: string };
  signal?: AbortSignal;
}

/**
 * 发给 Claude 账户。
 *
 * 请求体基本原样透传：它出自真实客户端，我们只改三处——模型名（可能要落到本程序配置的
 * 那个）、身份前缀，以及强制流式。强制流式是为了让上层只有一条代码路径，非流式响应由
 * 我们自己攒（见 anthropic.collect）。
 */
export async function forwardToClaude(
  account: Account,
  body: AnthropicRequest,
  opts: ForwardOptions,
): Promise<EventStream> {
  const payload = { ...body, model: opts.model, stream: true, system: withClaudeIdentity(body.system) };
  const audit = auditOf(account, 'gateway');
  const resp = await request(CLAUDE_URL, {
    method: 'POST',
    headers: claudeMessagesHeaders(account.accessToken, opts.betas ?? []),
    body: JSON.stringify(payload),
    timeoutMs: FORWARD_TIMEOUT_MS,
    signal: opts.signal,
    audit,
  });
  if (!resp.ok) await failure(account, resp, audit);
  // Claude 的流本来就是 Anthropic 事件，解析出来直接就是 IR
  return parseSse(resp.body);
}

/** 发给 Codex 账户：请求要翻译成 Responses 方言，回来的事件再翻回 Anthropic。 */
export async function forwardToCodex(
  account: Account,
  body: AnthropicRequest,
  opts: ForwardOptions,
): Promise<EventStream> {
  const audit = auditOf(account, 'gateway');
  const resp = await request(CODEX_URL, {
    method: 'POST',
    headers: codexResponsesHeaders(account.accessToken, account.accountId),
    body: JSON.stringify(toCodexRequest(body, opts.model)),
    timeoutMs: FORWARD_TIMEOUT_MS,
    signal: opts.signal,
    audit,
  });
  if (!resp.ok) await failure(account, resp, audit);
  return fromCodexStream(resp.body, opts.model);
}

/** W3C traceparent，Qoder 原生传输每条请求都带一个;签名器不产生它,转发时补上。 */
function traceparent(): string {
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
}

/**
 * 发给 Qoder 账户。
 *
 * 和 Claude / Codex 最大的不同在于它必须**先本地签名**:请求体连同一份原生签名一起发,上游据此
 * 校验调用方(见 qoder-signer.ts)。流程是——PAT 换 job token、取 uid,把 Anthropic 请求摊成 Qoder
 * 的 body,交给进程内的 WASM 签名器算出最终的 URL/头/体,补上几个传输层固定头后发出去。响应是
 * 加密的 OpenAI 风格 SSE,交给 fromQoderStream 边解密边翻成 Anthropic 事件。
 */
export async function forwardToQoder(
  account: Account,
  body: AnthropicRequest,
  opts: ForwardOptions,
): Promise<EventStream> {
  const creds = opts.qoder;
  if (!creds || !creds.pat) throw new UpstreamError(401, `${account.email} 未设置 Qoder PAT`);

  let jt: string;
  let uid: string;
  try {
    jt = await getJobToken(creds.pat);
    uid = await getUid(creds.pat);
    assertQoderIdentity(uid, creds.userId);
  } catch (err) {
    // 401/403 是 PAT 本身的问题,交给上层记到账户头上;其余当基础设施抖动(状态置 0 不追责)
    const status = err instanceof QoderAuthError ? err.status : 0;
    const blamed = status === 401 || status === 403 ? status : 0;
    throw new UpstreamError(blamed, err instanceof Error ? err.message : String(err));
  }

  const tier = qoderTierFor(opts.model);
  const version = cosyVersion();
  const bodyJson = toQoderBody(body, tier, { cosyVersion: version, maxTokens: body.max_tokens });

  let signed;
  try {
    signed = signer().prepareInfer({
      jt,
      uid,
      machineId: creds.machineId,
      baseUrl: QODER_INFER_BASE,
      bodyJson,
      modelKey: tier.key,
      modelSource: 'system',
      cosyVersion: version,
    });
  } catch (err) {
    // 签名失败是本地问题,不是这份凭证的错——状态置 0,不让账户因此进冷却
    throw new UpstreamError(0, `Qoder 签名失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  const headers = { ...signed.headers };
  headers['Cosy-Version'] ??= version;
  headers['Cosy-ClientType'] ??= '5';
  headers['Cosy-MachineOS'] ??= 'x86_64_linux';
  headers['User-Agent'] ??= QODER_INFER_USER_AGENT;
  headers['traceparent'] ??= traceparent();

  const audit = auditOf(account, 'gateway');
  const resp = await request(signed.url, {
    method: 'POST',
    headers,
    // 落库记明文 body_json,发出去的是签名后的字节
    body: bodyJson,
    bodyBytes: signed.body,
    timeoutMs: FORWARD_TIMEOUT_MS,
    signal: opts.signal,
    audit,
  });
  if (!resp.ok) await failure(account, resp, audit);
  const sign = signer();
  return fromQoderStream(resp.body, (payload) => sign.decrypt(payload), opts.model);
}

/** 按账户的 provider 选一条路；provider 不支持转发时不该走到这里。 */
export function forward(account: Account, body: AnthropicRequest, opts: ForwardOptions): Promise<EventStream> {
  if (account.provider === 'claude') return forwardToClaude(account, body, opts);
  if (account.provider === 'codex') return forwardToCodex(account, body, opts);
  if (account.provider === 'qoder') return forwardToQoder(account, body, opts);
  return Promise.reject(new UpstreamError(400, `${account.provider} 账户不支持 API 转发`));
}
