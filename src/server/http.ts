/**
 * 所有出站 HTTP 的统一入口，并在这里为每个请求留下日志。
 *
 * Node 自带 fetch 不暴露 ProxyAgent，因此代理能力通过 undici dispatcher 提供。
 * 由于代理可以在界面里动态修改，所以这里按需重建 agent，而不是要求重启进程。
 *
 * 这里用的是 undici 的低层 `request` 而不是 `fetch`，原因只有一个：**请求头必须逐字可控**。
 * `fetch` 遵循浏览器语义，会强行补上 `sec-fetch-mode: cors`、缺省的 `accept-language`
 * 之类的头——真实的 Claude Code / codex CLI 绝不会发这些，而上游正是按这套指纹识别调用方的。
 * 代价是 `request` 不会自动解压，所以下面要自己按 content-encoding 解一层。
 */
import { Readable, Transform, type Duplex } from 'node:stream';
import { createBrotliDecompress, createGunzip, createUnzip } from 'node:zlib';
import * as zlib from 'node:zlib';
import {
  Agent,
  fetch as undiciFetch,
  ProxyAgent,
  interceptors,
  request as undiciRequest,
  type Dispatcher,
} from 'undici';
import { shouldBypassProxy, validateProxy } from '../shared/proxy.js';
import { maskSecrets, maskText, redactCredentials, type Secrets } from '../shared/curl.js';
import type { RequestRecord } from '../shared/types.js';

export { validateProxy };

let currentProxy = '';
let currentBypass: string[] = [];
/**
 * undici 的低层 request 默认不跟随跳转，而上游偶尔会用 30x 换路径。
 * 跨源跳转时这个拦截器会自行摘掉 authorization，所以跟随几跳不会外泄令牌。
 */
function agent(proxy: string): Dispatcher {
  const base = proxy ? new ProxyAgent(proxy) : new Agent();
  return base.compose(interceptors.redirect({ maxRedirections: 3 }));
}

let dispatcher: Dispatcher = agent('');
/** 与代理 dispatcher 并存的直连 dispatcher，供命中忽略规则的主机直接出站。 */
const direct: Dispatcher = agent('');

/** 当前实际生效的代理；空字符串表示直连。 */
export function getProxy(): string {
  return currentProxy;
}

/** 当前正在绕过代理直连的主机规则列表。 */
export function getBypass(): string[] {
  return [...currentBypass];
}

/** 代理非法时直接抛错，而不是悄悄回退到直连。 */
export function setProxy(proxy: string, bypass: readonly string[] = []): void {
  const next = proxy.trim();
  const nextBypass = bypass.map((r) => r.trim()).filter(Boolean);

  // 即使代理 URL 不变，忽略代理列表也可能单独变化
  if (next === currentProxy && nextBypass.join(',') === currentBypass.join(',')) return;
  currentBypass = nextBypass;
  if (next === currentProxy) return;

  const err = validateProxy(next);
  if (err) throw new Error(err);

  // 先把新的 dispatcher 建好；若先关旧的而新建失败，后续请求都会指向已关闭 dispatcher
  const created: Dispatcher = agent(next);
  const previous = dispatcher;
  dispatcher = created;
  currentProxy = next;
  previous.close().catch(() => {});
}

/* ── 请求日志 ───────────────────────────────────────────────────────────── */

/**
 * 记账所需的上下文。带上它的请求会被完整记录下来，因此**凡是代表某个账户
 * 发给上游的请求都应该带**——这样界面上的日志才是全的，而不只有发送那一条。
 */
export interface Audit {
  accountId: string;
  /** 落库前要从请求里抹掉的凭证原文。 */
  secrets: Secrets;
  /** request() 回填的日志行号，供调用方随后补写上游返回的错误详情。 */
  rowId?: number;
}

export interface AuditSink {
  /** 返回新日志行的 id。 */
  record(
    accountId: string,
    sentAt: number,
    req: RequestRecord,
    status: number,
    durationMs: number,
    error: string,
  ): number;
  update(rowId: number, error: string): void;
  /** 流结束后补写上游返回的正文。 */
  updateResponse(rowId: number, response: string): void;
}

let sink: AuditSink | null = null;

/** 由 main.ts 接到 Store 上；未接时所有记账都是空操作，测试因此不需要数据库。 */
export function setAuditSink(next: AuditSink | null): void {
  sink = next;
}

/**
 * 补写这条请求的错误详情。
 *
 * 状态码在 request() 里就能拿到，但“错在哪”藏在响应体里，而响应体只有调用方
 * 读得动（流式请求尤其如此）。所以分两步：先落行，再由调用方回填。
 */
export function noteError(audit: Audit | undefined, error: string): void {
  if (audit?.rowId === undefined || error === '') return;
  sink?.update(audit.rowId, error);
}

/**
 * 记下一次不走 HTTP 的出站——目前只有 Claude 那条路：发送交给本机的官方 CLI。
 *
 * 它和 request() 里的记账写进同一张表，界面因此不必分两处看；分成两个入口是因为
 * 那条路没有响应流可以边读边攒：进程退了输出才齐，所以请求和响应一次写完。
 */
export function recordOutbound(
  audit: Audit,
  sentAt: number,
  req: RequestRecord,
  status: number,
  durationMs: number,
  error: string,
  output: string,
): void {
  if (!sink) return;
  const rowId = sink.record(
    audit.accountId,
    sentAt,
    maskSecrets(req, audit.secrets),
    status,
    durationMs,
    error,
  );
  if (output !== '') sink.updateResponse(rowId, redactCredentials(maskText(output, audit.secrets)));
}

/* ── 响应体留痕 ─────────────────────────────────────────────────────────── */

/**
 * 每条日志最多留多少响应体。
 *
 * 够看清一段报错或一份限额 JSON，又不至于让一次长回答把库撑起来。
 */
const RESPONSE_CAP = 64 * 1024;

/**
 * 边转发边攒响应体：调用方照常读流，我们顺手留一份。
 *
 * 不能等调用方读完再问它要——流式那条路径读到需要的事件就 destroy 了，
 * 完整正文根本不存在。所以在管道上挂一层，读到多少就记多少。
 */
function tap(src: Readable, done: (text: string) => void): Readable {
  const kept: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let flushed = false;

  const flush = (): void => {
    if (flushed) return;
    flushed = true;
    const text = Buffer.concat(kept).toString('utf8');
    try {
      done(truncated ? `${text}\n…（响应体过长，只保留了前 ${RESPONSE_CAP / 1024} KB）` : text);
    } catch (err) {
      // 记账失败只是少一条日志，不能让它把正在读的响应流打断
      console.error(`记录响应体失败: ${String(err)}`);
    }
  };

  const out = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (size < RESPONSE_CAP) {
        const slice = chunk.subarray(0, RESPONSE_CAP - size);
        if (slice.length < chunk.length) truncated = true;
        kept.push(Buffer.from(slice));
        size += slice.length;
      } else {
        truncated = true;
      }
      cb(null, chunk);
    },
  });

  src.on('error', (err: Error) => out.destroy(err));
  src.pipe(out);
  // 提前掐断时把上游那截也关掉，否则连接会一直挂在那里
  out.on('close', () => {
    src.destroy();
    flush();
  });
  out.on('end', flush);
  return out;
}

/* ── 解压 ───────────────────────────────────────────────────────────────── */

/**
 * content-encoding 可以是逗号分隔的多层编码，且要按**逆序**解开。
 * 认不出来的编码原样返回：宁可让调用方看到一段乱码，也好过整条链路抛异常。
 */
function decode(stream: Readable, encoding: string): Readable {
  const layers = encoding
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .reverse();

  let out = stream;
  for (const layer of layers) {
    const decoder = decoderFor(layer);
    if (decoder === null) break;
    // 上游截断时 pipe 不会自动传播错误，这里显式转发，否则 text() 会一直挂着
    out.on('error', (err: Error) => decoder.destroy(err));
    out = out.pipe(decoder);
  }
  return out;
}

function decoderFor(layer: string): Duplex | null {
  switch (layer) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'deflate':
      // 有的上游发的是裸 deflate 而不是 zlib 包装，createUnzip 两种都认
      return createUnzip();
    case 'br':
      return createBrotliDecompress();
    case 'zstd': {
      // Node 23.8 起才有；缺失时按“不认识的编码”处理，即原样返回
      const make = (zlib as unknown as Record<string, unknown>).createZstdDecompress;
      return typeof make === 'function' ? ((make as () => Duplex)()) : null;
    }
    default:
      // identity 以及任何没见过的编码都走这里：不动它
      return null;
  }
}

/* ── 请求 ───────────────────────────────────────────────────────────────── */

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  audit?: Audit;
  transport?: 'undici' | 'fetch';
}

/**
 * 对外只暴露调用方真正用到的那几样，形状与 fetch 的 Response 保持一致，
 * 这样底层从 fetch 换到 request 时上层一行都不用改。
 */
export class HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  /** 已解压的响应流。 */
  readonly body: Readable;
  private consumed = '';
  private read = false;

  constructor(status: number, headers: Headers, body: Readable) {
    this.status = status;
    this.headers = headers;
    this.body = body;
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  async text(): Promise<string> {
    if (this.read) return this.consumed;
    this.read = true;
    const chunks: Buffer[] = [];
    for await (const chunk of this.body) chunks.push(Buffer.from(chunk as Buffer));
    this.consumed = Buffer.concat(chunks).toString('utf8');
    return this.consumed;
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
}

/** undici 返回的头是 `string | string[] | undefined`，统一成 Headers 便于上层取用。 */
function toHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
  }
  return h;
}

export async function request(url: string, opts: FetchOptions = {}): Promise<HttpResponse> {
  const { timeoutMs = 120_000, audit, method = 'GET', headers = {}, body, transport = 'undici' } = opts;
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const via = currentProxy && shouldBypassProxy(url, currentBypass) ? direct : dispatcher;
  const sentAt = Date.now();

  // 记录的是这一刻真正要发出去的东西，不是事后重建的近似值
  const record: RequestRecord = { method, url, headers, body: body ?? '' };
  const log = (status: number, error: string): void => {
    if (!audit || !sink) return;
    audit.rowId = sink.record(
      audit.accountId,
      sentAt,
      maskSecrets(record, audit.secrets),
      status,
      Date.now() - sentAt,
      error,
    );
  };

  let resp: Dispatcher.ResponseData | { statusCode: number; headers: Headers; body: Readable };
  try {
    if (transport === 'fetch') {
      // OpenCode 的 Headroom shim 会把全局 fetch 路由到本地代理；它对外部
      // http2.connect 直接拒绝而不转发，因此额度查询要走这个受支持的入口。
      const init = {
        method,
        headers,
        body,
        signal,
        dispatcher: via,
      } satisfies RequestInit & { dispatcher: Dispatcher };
      // Node 24 的全局 fetch 使用内置 undici，不能接收本项目安装的 v8 dispatcher；
      // 有应用代理时改用同版本 fetch，未配置代理时仍保留 OpenCode 的 Headroom shim。
      const fetcher = currentProxy ? undiciFetch : fetch;
      const response = await fetcher(url, init);
      const responseBody = response.body;
      const responseHeaders = new Headers();
      response.headers.forEach((value, key) => responseHeaders.set(key, value));
      resp = {
        statusCode: response.status,
        headers: responseHeaders,
        body: responseBody
          ? Readable.from((async function* () {
              const reader = responseBody.getReader();
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) return;
                if (chunk.value) yield chunk.value;
              }
            })())
          : Readable.from([]),
      };
    } else {
      resp = await undiciRequest(url, {
          method: method as Dispatcher.HttpMethod,
          headers,
          body,
          signal,
          dispatcher: via,
        });
    }
  } catch (err) {
    log(0, `network: ${String((err as Error).cause ?? err)}`);
    throw err;
  }

  log(resp.statusCode, '');
  const headersOut = resp.headers instanceof Headers ? resp.headers : toHeaders(resp.headers);
  let stream = resp.headers instanceof Headers
    ? resp.body
    : decode(resp.body, headersOut.get('content-encoding') ?? '');

  const rowId = audit?.rowId;
  if (audit && sink && rowId !== undefined) {
    const target = sink;
    const secrets = audit.secrets;
    stream = tap(stream, (text) => {
      // 请求侧抹的是我们发出去的凭证，响应侧还得防住上游新签发的那一份
      target.updateResponse(rowId, redactCredentials(maskText(text, secrets)));
    });
  }

  return new HttpResponse(resp.statusCode, headersOut, stream);
}
