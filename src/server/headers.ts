/**
 * 出站请求头的统一构建，以及 HTTP 失败时的诊断信息提取。
 *
 * 两家上游都按“调用方身份”区别对待请求，混用会被拒，因此这里逐个端点还原它在真实
 * 客户端里的线上形态。**同一个端点在官方客户端里由哪个 HTTP 栈发出，这里就照哪个发**：
 *
 *   - `api.anthropic.com/v1/models`：Claude Code 走 @anthropic-ai/sdk，带 x-stainless-* 一族。
 *   - `api.anthropic.com/api/oauth/*` 和令牌端点：Claude Code 走的是 **axios**，不是 SDK。
 *     它的 UA 就是 `axios/1.15.2`，头也是 axios 的默认那几个，和 CLI 身份完全不同。
 *   - `chatgpt.com/backend-api/codex/*`：Codex 的 CLI 身份（originator + 版本化 UA）。
 *   - `chatgpt.com/backend-api/wham/*`、accounts/check、subscriptions：Codex 桌面端的浏览器
 *     身份——缺少 Referer 或浏览器 UA 时，边缘节点会在到达业务层之前就把请求挡掉。
 *
 * 取值来自 cockpit-tools 及其内置的 CLIProxyAPI：那里记录的是抓下来的真实客户端流量。
 */
import { randomUUID } from 'node:crypto';

/** Claude Code 的版本号，UA 里报的就是它。 */
export const CLAUDE_VERSION = '2.1.220';

/**
 * 进程级的会话 ID。
 *
 * 真实 CLI 一个会话内所有请求共用一个 session_id，每条请求换一个反而更可疑。
 * 这个程序的定位就是长期挂着定时发送，因此“一次运行 = 一个会话”是最贴近的映射。
 */
let sessionId = '';
export function currentSessionId(): string {
  if (sessionId === '') sessionId = randomUUID();
  return sessionId;
}

/**
 * 所有身份共用的设备画像。
 *
 * 三套身份声称的是**同一台机器**：Apple Silicon 的 macOS 加 iTerm2。这一点必须守住——
 * 同一个账户上，Claude 报 MacOS/arm64 而 Codex 报 Linux/x86_64，本身就是个破绽。
 */
const DEVICE_OS = 'Mac OS 26.5.0';
const DEVICE_ARCH = 'arm64';
const DEVICE_TERMINAL = 'iTerm.app/3.6.10';

/** Codex 桌面端访问 chatgpt.com/backend-api 时使用的浏览器身份。 */
const CHATGPT_REFERER = 'https://chatgpt.com/';
const CHATGPT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

/**
 * Claude Code CLI 的设备指纹。
 *
 * UA 里的版本号、@anthropic-ai/sdk 的包版本、Node 运行时版本、以及 SDK 上报的
 * 系统与架构。它们必须彼此自洽——一个 MacOS/arm64 的机器不会跑在 Linux 的 Node 上。
 */
export const CLAUDE_UA = `claude-cli/${CLAUDE_VERSION} (external, cli)`;
const SDK_PACKAGE_VERSION = '0.94.0';
const SDK_RUNTIME_VERSION = 'v26.3.0';
const SDK_OS = 'MacOS';
const SDK_ARCH = DEVICE_ARCH;

/** OAuth 令牌路径必须带的 beta 标记；缺了它 /v1/* 会以 401 拒绝。 */
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';

/**
 * Claude Code 内嵌的 axios 版本。
 *
 * OAuth 控制面（`/api/oauth/profile`、`/api/oauth/usage`、`/api/oauth/roles`）和令牌端点
 * 都不走 @anthropic-ai/sdk，而是 CLI 直接用 axios 发的，所以这些请求在上游看来根本
 * 不带 claude-cli 身份。之前这里统一用 CLI 的 UA 去发，反而是个只有我们才有的特征。
 */
const CLAUDE_AXIOS_UA = 'axios/1.15.2';

/**
 * Claude OAuth 控制面与令牌端点的请求头（axios 形态）。
 *
 * `accessToken` 留空表示这是换/刷令牌的请求——令牌端点本来就不带 Authorization。
 * `beta` 只在 usage 上出现：参照实现在那条路径上额外声明了 OAuth beta。
 */
export function claudeOAuthHeaders(accessToken = '', beta = ''): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'user-agent': CLAUDE_AXIOS_UA,
    // axios 的默认压缩协商，和 SDK 那条路径不一样：没有 zstd
    'accept-encoding': 'gzip, compress, deflate, br',
    // axios 在 Node 下对这类一次性请求不复用连接
    connection: 'close',
  };
  if (accessToken) {
    h.authorization = `Bearer ${accessToken}`;
    h['cache-control'] = 'no-cache';
  }
  if (beta) h['anthropic-beta'] = beta;
  return h;
}

/**
 * `api.anthropic.com/v1/*` 的通用 SDK 请求头。
 *
 * 这些头来自 @anthropic-ai/sdk 0.94.0：真实 CLI 通过官方 SDK 发请求，它们必然存在，
 * 缺了反而显眼。现在这条路径只剩 `/v1/models`——保活文本改由本机的 claude CLI 发送，
 * 见 claudecli.ts。
 *
 * 已知无法对齐的一点：header 名称的大小写。参照实现是 Go，能把 `x-stainless-OS`
 * 这类原始大小写写到线上；这里的头会按我们给出的字面量发出去，因此统一用小写，
 * 与 HTTP/2 下的形态一致。
 */
export function claudeSdkHeaders(accessToken: string, betas: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    'anthropic-beta': betas,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    'content-type': 'application/json',
    accept: 'application/json',
    'accept-encoding': 'gzip, deflate, br, zstd',
    connection: 'keep-alive',
    'user-agent': CLAUDE_UA,
    'x-app': 'cli',
    // 同一次运行内保持不变，与请求体里的 metadata.session_id 是同一个值
    'x-claude-code-session-id': currentSessionId(),
    // 每条请求一个，官方 SDK 用它做端到端追踪
    'x-client-request-id': randomUUID(),
    'x-stainless-arch': SDK_ARCH,
    'x-stainless-lang': 'js',
    'x-stainless-os': SDK_OS,
    'x-stainless-package-version': SDK_PACKAGE_VERSION,
    'x-stainless-retry-count': '0',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': SDK_RUNTIME_VERSION,
    'x-stainless-timeout': '600',
  };
}

/** `/v1/models` 用的请求头：SDK 形态，但只需要声明 OAuth beta。 */
export function claudeModelsHeaders(accessToken: string): Record<string, string> {
  return claudeSdkHeaders(accessToken, CLAUDE_OAUTH_BETA);
}

/** chatgpt.com/backend-api 下 JSON 接口的浏览器身份请求头。 */
export function codexWebHeaders(accessToken: string, accountId: string): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
    'content-type': 'application/json',
    referer: CHATGPT_REFERER,
    'user-agent': CHATGPT_UA,
    'openai-beta': 'codex-1',
    'oai-language': 'zh-CN',
    originator: 'Codex Desktop',
    // 桌面端是从渲染进程发起的，这几个 Fetch Metadata 头缺失时会被当成非浏览器流量
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-dest': 'empty',
    priority: 'u=4, i',
  };
  if (accountId) h['chatgpt-account-id'] = accountId;
  return h;
}

/**
 * accounts/check 与 subscriptions 这类“订阅族”接口额外需要目标路径头：
 * 它们走的是另一条边缘路由，缺少这两个头会返回 HTML 403 而不是 JSON。
 */
export function codexSubscriptionHeaders(
  accessToken: string,
  accountId: string,
  targetPath: string,
): Record<string, string> {
  return {
    ...codexWebHeaders(accessToken, accountId),
    'x-openai-target-path': targetPath,
    'x-openai-target-route': targetPath,
  };
}

/* ── Codex CLI 身份 ──────────────────────────────────────────────────────── */

/**
 * Codex 客户端版本。
 *
 * 同时用在三处，必须是同一个值：UA、`version` 头、以及模型目录的 `client_version`
 * 查询串。上游按版本裁剪返回内容，三处对不上本身就是异常流量。
 */
export const CODEX_CLIENT_VERSION = '0.146.0';

/**
 * 当前的 Codex CLI 身份。
 *
 * 早期版本自称 `codex_cli_rs`，现在线上的是 `codex-tui`——UA 尾部还会把 originator 和
 * 版本再重复一遍，这是它自己的格式，不是我们拼错了。参照实现对所有 Codex 上游请求
 * 统一按这个身份发，新模型（gpt-5.6-*）更是只认它。
 */
const CODEX_ORIGINATOR = 'codex-tui';
const CODEX_CLI_UA =
  `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION} (${DEVICE_OS}; ${DEVICE_ARCH})` +
  ` ${DEVICE_TERMINAL} (${CODEX_ORIGINATOR}; ${CODEX_CLIENT_VERSION})`;

/** 两个 CLI 端点共用的身份部分。 */
function codexCliIdentity(accessToken: string, accountId: string): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    originator: CODEX_ORIGINATOR,
    'user-agent': CODEX_CLI_UA,
    version: CODEX_CLIENT_VERSION,
    'content-type': 'application/json',
  };
  if (accountId) h['chatgpt-account-id'] = accountId;
  return h;
}

/** /backend-api/codex/responses 用的 CLI 身份请求头。 */
export function codexResponsesHeaders(
  accessToken: string,
  accountId: string,
): Record<string, string> {
  return {
    ...codexCliIdentity(accessToken, accountId),
    'openai-beta': 'responses=experimental',
    // 每轮对话一个；上游用它把同一次会话的请求串起来
    session_id: randomUUID(),
    'x-client-request-id': randomUUID(),
    accept: 'text/event-stream',
    'accept-encoding': 'gzip, br',
    connection: 'Keep-Alive',
  };
}

/**
 * /backend-api/codex/models 用的请求头。
 *
 * 身份同上，但它是普通 JSON 接口而不是流式对话，因此不带 openai-beta 和 session_id。
 */
export function codexModelsHeaders(
  accessToken: string,
  accountId: string,
): Record<string, string> {
  return {
    ...codexCliIdentity(accessToken, accountId),
    accept: 'application/json',
    'accept-encoding': 'gzip, br',
  };
}

/* ── Qoder 身份 ──────────────────────────────────────────────────────────── */

/**
 * Qoder IDE 写在 SharedClientCache/cache/machine_token.json 里的机器标识。
 *
 * 上游按这些头识别“是不是官方客户端在请求”，缺了大多只是少几个字段、并不会直接 401，
 * 因此每一项都是可选：读不到就不发，绝不自己编一个。
 */
export interface QoderMachine {
  token: string;
  machineType: string;
  machineCode: string;
  machineId: string;
  machineHostname: string;
  machineOS: string;
  cosyVersion: string;
}

/**
 * Cosy-MachineOS 的取值形如 `x86_64_linux`、`aarch64_darwin`。
 * Node 的 arch/platform 命名与 Qoder 用的那套（Rust 的 ARCH/OS）不一样，这里对齐它。
 */
export function qoderMachineOS(): string {
  const arch =
    process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch;
  return `${arch}_${process.platform}`;
}

/** Qoder OpenAPI 的请求头；machine 为空时只发 Authorization 与本机 OS 标识。 */
export function qoderHeaders(
  accessToken: string,
  machine: QoderMachine | null = null,
): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
    'Cosy-MachineOS': machine?.machineOS || qoderMachineOS(),
    // 0 = IDE 本体；官方客户端固定发这个值
    'Cosy-ClientType': '0',
  };
  const optional: [string, string | undefined][] = [
    ['Cosy-Version', machine?.cosyVersion],
    ['Cosy-MachineToken', machine?.token],
    ['Cosy-MachineType', machine?.machineType],
    ['Cosy-MachineCode', machine?.machineCode],
    ['Cosy-MachineId', machine?.machineId],
    ['Cosy-MachineHostname', machine?.machineHostname],
  ];
  for (const [name, value] of optional) if (value) h[name] = value;
  return h;
}

/**
 * 任何长得像 Headers 的对象：undici 的 Headers、全局 Headers 或普通对象都行。
 * 这里和 ratelimit.ts 一样采用鸭子类型；写成 `instanceof Headers` 会对 undici 自己的
 * Headers 类判 false，从而悄悄什么都读不到。
 */
export type HeaderLike = { get?(name: string): string | null } | Record<string, unknown>;

function headerValue(headers: HeaderLike | undefined, name: string): string {
  if (!headers) return '';
  const get = (headers as { get?: (n: string) => string | null }).get;
  if (typeof get === 'function') return get.call(headers, name) ?? '';
  const hit = Object.entries(headers as Record<string, unknown>).find(
    ([k]) => k.toLowerCase() === name,
  );
  return hit ? String(hit[1]) : '';
}

/**
 * 上游把机器可读的原因藏在响应体里，字段名随接口而异；这里按已知的几个位置找一遍。
 * 例如 429 会带 `detail.code = "usage_limit_reached"`，它比状态码本身有用得多。
 */
export function detailCodeOf(body: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return '';
  }
  if (payload === null || typeof payload !== 'object') return '';
  const root = payload as Record<string, unknown>;
  for (const container of [root.detail, root.error, root]) {
    if (container === null || typeof container !== 'object') continue;
    const code = (container as Record<string, unknown>).code;
    if (typeof code === 'string' && code) return code;
  }
  if (typeof root.detail === 'string' && root.detail) return root.detail.slice(0, 80);
  return '';
}

/**
 * 把排障需要的线索拼成一行：请求 ID 让上游侧能查到同一条记录，cf-ray 则能区分
 * “边缘节点拒绝”和“业务层拒绝”——两者的状态码常常一样。
 */
export function diagnose(headers: HeaderLike | undefined, body: string): string {
  const parts: string[] = [];
  const requestId =
    headerValue(headers, 'request-id') || headerValue(headers, 'x-request-id');
  if (requestId) parts.push(`req:${requestId}`);
  const cfRay = headerValue(headers, 'cf-ray');
  if (cfRay) parts.push(`cf:${cfRay}`);
  const code = detailCodeOf(body);
  if (code) parts.push(`code:${code}`);
  return parts.length === 0 ? '' : ` [${parts.join(' ')}]`;
}
