/**
 * 用户登录：Claude / Codex 的 OAuth 授权码 + PKCE 流程，以及 Qoder 的设备码流程。
 *
 * 授权码流程有两条完成路径，同时可用：
 *
 * 1. **本地监听**。Codex 注册的回调地址就是 `http://localhost:1455/auth/callback`，
 *    所以浏览器和本程序在同一台机器上时，可以直接把回调接住，用户点完授权就结束了。
 * 2. **手动粘贴**。端口被占用（比如官方 CLI 正在登录）、或者程序跑在服务器/容器里而
 *    界面开在另一台机器上时，监听就没有意义。这时用户把浏览器最终停留的地址粘回来。
 *
 * 监听只绑回环地址，且仍然校验 state，因此不会替别人的授权收尾。
 * Claude 走不了第一条：它注册的回调是 platform.claude.com 上的一个页面，
 * 换成 localhost 会被授权服务器直接拒掉，所以 Claude 始终是手动粘贴。
 *
 * Qoder 是第三条路：它的回调是 `qoder://` 自定义协议，本机监听接不住，也没有 code
 * 可粘贴。改由服务端在后台按秒轮询上游，用户在浏览器里点完就好——对界面来说，
 * 这和“本地监听”是同一种体验，因此复用了同一个 listening 字段和同一套轮询接口。
 *
 * Codex 另有一条设备码通道（mode='device'）。上面两条都要求浏览器和这个进程之间存在
 * 某种联系——要么同机以便接住回调，要么用户能把地址栏里那一长串复制回来。服务端跑在
 * 远端、用户手边只有手机时两者都不成立。设备码把方向反过来：先问上游要一串短验证码，
 * 用户在任意设备上打开官方页面输入它，服务端在后台轮询，授权一完成就取回授权码和
 * 配套的 code_verifier，再走同一个令牌端点收尾。因此它同样是“等着就行”的体验。
 *
 * 待完成的授权只放在内存里。它的生命周期是几分钟量级，重启后重新点一次登录即可，
 * 把 code_verifier 写到磁盘反而多出一份可被读取的敏感数据。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request } from './http.js';
import {
  CLAUDE_CLIENT_ID,
  CLAUDE_TOKEN_URL,
  CODEX_CLIENT_ID,
  CODEX_TOKEN_URL,
  accountIdMismatch,
  emailOf,
  findClaim,
  decodeJwt,
  saveAccount,
  tokenExpiresAt,
} from './creds.js';
import { claudeOAuthHeaders } from './headers.js';
import {
  QODER_DEVICE_REDIRECT_URI,
  buildQoderLoginUrl,
  fetchQoderLoginProfile,
  pollQoderDeviceToken,
  qoderLoginMachineId,
  readQoderMachine,
  type QoderDeviceToken,
} from './qoder.js';
import type { QoderMachine } from './headers.js';
import type { LoginMode, LoginStart, LoginStatus, Provider } from '../shared/types.js';

const CLAUDE_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
/** Claude 的“手动回调”页面：授权完成后会把 code 显示出来，不需要本地监听。 */
const CLAUDE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const CLAUDE_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
].join(' ');
const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';

const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
/** 与官方 CLI 注册的回调地址保持一致；换成别的值会被授权服务器拒绝。 */
const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CODEX_SCOPES = 'openid profile email offline_access';
const CODEX_CALLBACK_PORT = 1455;
const CODEX_CALLBACK_PATH = '/auth/callback';
/** 只绑回环。localhost 在不同系统上可能解析成 IPv4 或 IPv6，两个都试一遍。 */
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];

/** 设备码流程的三个端点：要码、轮询、以及给用户看的输入页。 */
const CODEX_DEVICE_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const CODEX_DEVICE_POLL_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const CODEX_DEVICE_VERIFY_URL = 'https://auth.openai.com/codex/device';
/** 设备码换来的授权码是上游代签的，兑换时要报它自己那个回调地址，而不是 1455。 */
const CODEX_DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
/** 上游没给 interval 时的兜底轮询间隔。 */
const CODEX_DEVICE_POLL_MS = 5000;

/** Qoder 设备令牌的轮询间隔。官方客户端是 1 秒，这里放宽一倍：这一步在等人点鼠标。 */
const QODER_POLL_MS = 2000;

/** 授权链接的有效期，与官方客户端一致。 */
const LOGIN_TTL_MS = 10 * 60 * 1000;
/** 设备码的有效期比授权链接长：用户要换一台设备、手敲一串验证码。 */
const DEVICE_TTL_MS = 15 * 60 * 1000;
/** 登录完成后结果再留一会儿，等前端轮询取走。 */
const RESULT_TTL_MS = 60 * 1000;

interface Pending {
  controller: AbortController;
  signal: AbortSignal;
  loginId: string;
  provider: Provider;
  verifier: string;
  /** 授权码流程里的 state；Qoder 复用它存 nonce，两者作用相同。 */
  state: string;
  /** 兑换令牌时要报的回调地址。设备码与授权码用的不是同一个，且必须与发起时一致。 */
  redirectUri: string;
  expiresAt: number;
  /** 监听路径要自己把账户落盘，因此在发起时就把目录记下来。 */
  accountsDir: string;
  servers: Server[];
  /** Qoder 轮询要带的机器标识，发起时读一次就够。 */
  machine: QoderMachine | null;
  /** 设备码流程里上游分配的会话标识，轮询时要连同验证码一起报上去。 */
  deviceAuthId: string;
  /** 给用户手敲的那串验证码；非设备码流程为空。 */
  userCode: string;
  result: LoginStatus;
  /** 监听路径没有对应的 HTTP 请求可以借力，落盘后由它去通知前端。 */
  onDone: () => void;
}

const pending = new Map<string, Pending>();

function closeListeners(p: Pending): void {
  for (const s of p.servers) s.close();
  p.servers = [];
}

function sweep(): void {
  const now = Date.now();
  for (const [id, p] of pending) {
    if (p.expiresAt > now) continue;
    p.controller.abort();
    closeListeners(p);
    pending.delete(id);
  }
}

/** RFC 7636 的 S256 挑战码。 */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** 页面内容很短，因为用户只需要知道“可以关掉了”。 */
function replyPage(res: ServerResponse, title: string, detail: string, ok: boolean): void {
  const body = `<!doctype html><meta charset="utf-8"><title>QuotaHot</title>
<body style="font-family:system-ui;background:#16181d;color:#e6e8ee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center">
<h2 style="color:${ok ? '#4ec9a0' : '#e06c6c'}">${title}</h2>
<p style="color:#8b90a0;font-size:14px">${detail}</p>
</div>`;
  res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

/**
 * 起本地回调监听。绑不上就返回失败原因，由调用方退回手动粘贴，
 * 而不是让整个登录流程失败——端口被占用是很常见的情况。
 */
async function listen(p: Pending): Promise<string> {
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== CODEX_CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    // 用户在授权页上点了拒绝，或者上游自己报错
    const denied = url.searchParams.get('error');
    if (denied) {
      p.result = { ...p.result, state: 'error', error: `授权被拒绝: ${denied}` };
      replyPage(res, '授权未完成', p.result.error, false);
      return;
    }
    if (p.result.state !== 'pending') {
      // 浏览器可能重放同一个回调（刷新页面），直接回上一次的结论，不重复换令牌
      replyPage(res, '这次授权已经处理过了', '回到 QuotaHot 查看结果。', p.result.state === 'done');
      return;
    }
    try {
      const id = await finishLogin(p, url.searchParams.get('code') ?? '', url.searchParams.get('state') ?? '');
      p.onDone();
      replyPage(res, '登录成功', `已添加 ${id}，可以关掉这个页面了。`, true);
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      // 也要写进 result，否则前端会一直转圈等到会话过期
      p.result = { ...p.result, state: 'error', error: message };
      replyPage(res, '登录失败', message, false);
    }
  };

  const bind = (host: string): Promise<Server | string> =>
    new Promise((resolve) => {
      const server = createServer((req, res) => void handler(req, res));
      server.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
      server.listen(CODEX_CALLBACK_PORT, host, () => {
        server.removeAllListeners('error');
        // 监听socket 不应该拖住进程退出
        server.unref();
        resolve(server);
      });
    });

  const results = await Promise.all(LOOPBACK_HOSTS.map(bind));
  for (const r of results) if (typeof r !== 'string') p.servers.push(r);
  const errors = results.filter((r): r is string => typeof r === 'string');

  // 只要有一个回环地址被别人占着就整体放弃：浏览器可能连的正是那一个，
  // 回调会被送进另一个进程，我们却在这边空等。IPv6 不可用之类的错误则无所谓。
  if (errors.includes('EADDRINUSE')) {
    closeListeners(p);
    return `本机 ${CODEX_CALLBACK_PORT} 端口已被占用（多半是官方 CLI 正在登录）`;
  }
  if (p.servers.length > 0) return '';
  return `无法监听本机 ${CODEX_CALLBACK_PORT} 端口: ${errors[0] ?? 'unknown'}`;
}

/**
 * accountsDir 为空时不起监听：没有落盘目标，接住回调也没法收尾。
 * 测试正是靠这一点在不占端口的情况下检查授权链接。
 */
export async function startLogin(
  provider: Provider,
  accountsDir = '',
  onDone: () => void = () => {},
  mode: LoginMode = 'redirect',
): Promise<LoginStart> {
  sweep();
  // 设备码的 verifier 由上游连同授权码一起下发，本地这份用不上
  const device = mode === 'device';
  const { verifier, challenge } = pkce();
  // Qoder 的 nonce 要求是无分隔符的 uuid，与授权码流程的随机串格式不同
  const state =
    provider === 'qoder' ? randomUUID().replace(/-/g, '') : randomBytes(16).toString('base64url');
  const loginId = randomUUID();
  const ttl = device ? DEVICE_TTL_MS : LOGIN_TTL_MS;
  const expiresAt = Date.now() + ttl;
  const controller = new AbortController();
  const p: Pending = {
    controller,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(ttl)]),
    loginId,
    provider,
    verifier,
    state,
    redirectUri: provider === 'claude' ? CLAUDE_REDIRECT_URI : CODEX_REDIRECT_URI,
    expiresAt,
    accountsDir,
    servers: [],
    machine: null,
    deviceAuthId: '',
    userCode: '',
    result: { state: 'pending', accountId: '', error: '', listening: false },
    onDone,
  };
  pending.set(loginId, p);

  if (device) {
    if (provider !== 'codex') {
      pending.delete(loginId);
      throw new Error('只有 Codex 支持设备码登录');
    }
    return startCodexDeviceLogin(p);
  }
  if (provider === 'qoder') return startQoderLogin(p, challenge);

  // Claude 的回调落在 platform.claude.com 上，本地监听接不到，也不该假装能接到
  let listenError = '';
  if (provider === 'codex' && accountsDir) {
    listenError = await listen(p);
    p.result.listening = p.servers.length > 0;
  }

  const url = new URL(provider === 'claude' ? CLAUDE_AUTHORIZE_URL : CODEX_AUTHORIZE_URL);
  const q = url.searchParams;
  q.set('response_type', 'code');
  q.set('code_challenge', challenge);
  q.set('code_challenge_method', 'S256');
  q.set('state', state);
  if (provider === 'claude') {
    // code=true 让授权页在结束时把 code 直接显示出来，而不是只做一次跳转
    q.set('code', 'true');
    q.set('client_id', CLAUDE_CLIENT_ID);
    q.set('redirect_uri', CLAUDE_REDIRECT_URI);
    q.set('scope', CLAUDE_SCOPES);
  } else {
    q.set('client_id', CODEX_CLIENT_ID);
    q.set('redirect_uri', CODEX_REDIRECT_URI);
    q.set('scope', CODEX_SCOPES);
    // 没有这个参数，id_token 里就不会带 chatgpt_account_id，后续请求无从指定账户
    q.set('id_token_add_organizations', 'true');
    q.set('codex_cli_simplified_flow', 'true');
  }

  return {
    loginId,
    provider,
    authorizeUrl: url.toString(),
    redirectUri: p.redirectUri,
    userCode: '',
    expiresAt,
    listening: p.result.listening,
    listenError,
  };
}

/**
 * Qoder 的设备码登录。
 *
 * 与授权码流程的差别只在收尾：这里没有回调可接，链接发出去之后由服务端自己去问
 * “好了没有”。accountsDir 为空（测试构造链接时）就不起轮询，免得空转到过期。
 */
async function startQoderLogin(p: Pending, challenge: string): Promise<LoginStart> {
  p.machine = await readQoderMachine();
  const machineId = await qoderLoginMachineId(p.machine);
  const authorizeUrl = buildQoderLoginUrl(p.state, challenge, machineId);

  // listening 在界面上的含义是“不用你粘贴，等着就行”，轮询满足的正是这一条
  p.result.listening = Boolean(p.accountsDir);
  if (p.accountsDir) void pollQoder(p);

  return {
    loginId: p.loginId,
    provider: 'qoder',
    authorizeUrl,
    redirectUri: QODER_DEVICE_REDIRECT_URI,
    userCode: '',
    expiresAt: p.expiresAt,
    listening: p.result.listening,
    listenError: '',
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * 后台轮询，直到拿到令牌、会话被取消或超时。
 *
 * 单次失败只记下来接着试：这条链路要跨过用户读邮件、切账号的几分钟，
 * 期间一次网络抖动就判整场登录失败太苛刻了。真到超时才把最后那条错误报出去。
 */
async function pollQoder(p: Pending): Promise<void> {
  let lastError = '';
  while (pending.get(p.loginId) === p && p.result.state === 'pending') {
    if (Date.now() > p.expiresAt) {
      p.result = {
        ...p.result,
        state: 'error',
        error: lastError || 'Qoder 登录已超时，请重新发起',
      };
      return;
    }
    await delay(QODER_POLL_MS);
    // 等待期间用户可能已经点了取消
    if (pending.get(p.loginId) !== p || p.result.state !== 'pending') return;

    let token: QoderDeviceToken | null;
    try {
      token = await pollQoderDeviceToken(p.state, p.verifier, p.signal);
    } catch (err) {
      lastError = String(err instanceof Error ? err.message : err);
      continue;
    }
    if (!token) continue;

    // 令牌已经到手，轮询阶段就结束了：后面这些是一次性的收尾，失败就是失败，
    // 再重试只会对着同一个坏账户反复打上游接口，用户还要干等到超时才看见原因
    try {
      await finishQoderLogin(p, token);
      p.onDone();
    } catch (err) {
      p.result = {
        ...p.result,
        state: 'error',
        error: String(err instanceof Error ? err.message : err),
      };
    }
    return;
  }
}

/** 补齐身份、落盘，并把结果留给前端轮询取走。与授权码流程的收尾一一对应。 */
async function finishQoderLogin(p: Pending, token: QoderDeviceToken): Promise<string> {
  p.signal.throwIfAborted();
  const profile = await fetchQoderLoginProfile(token, p.machine, p.signal);
  const email = profile.email || profile.displayName || profile.userId;
  if (!email) throw new Error('没能识别该 Qoder 账户的标识，请改用从 Qoder IDE 导入');

  await saveAccount(p.accountsDir, {
    provider: 'qoder',
    email,
    accountId: profile.userId,
    userId: profile.userId,
    plan: profile.plan,
    accessToken: profile.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: profile.expiresAt,
    source: 'oauth',
    // Qoder 没有可用的 refresh 端点：这份令牌失效后只能重新登录，或改从 IDE 导入
    autoRefresh: false,
  }, p.signal);

  const accountId = `qoder:${email}`;
  p.result = { state: 'done', accountId, error: '', listening: p.result.listening };
  p.expiresAt = Date.now() + RESULT_TTL_MS;
  return accountId;
}

/**
 * Codex 的设备码登录。
 *
 * 先问上游要一串验证码交给用户，随后在后台轮询。收尾和授权码流程是同一段逻辑：
 * 用户输完验证码后，上游交还的正是一个授权码和它配套的 code_verifier。
 */
async function startCodexDeviceLogin(p: Pending): Promise<LoginStart> {
  let device: Awaited<ReturnType<typeof requestCodexDeviceCode>>;
  try {
    device = await requestCodexDeviceCode(p);
  } catch (err) {
    // 连码都没要到，这个会话没有任何意义，不必留着等 sweep
    pending.delete(p.loginId);
    throw err;
  }
  p.deviceAuthId = device.deviceAuthId;
  p.userCode = device.userCode;
  p.redirectUri = CODEX_DEVICE_REDIRECT_URI;

  // 与 Qoder 同理：轮询就是这条路上的“监听”，用户没有东西要粘
  p.result.listening = Boolean(p.accountsDir);
  if (p.accountsDir) void pollCodexDevice(p, device.intervalMs);

  return {
    loginId: p.loginId,
    provider: 'codex',
    authorizeUrl: CODEX_DEVICE_VERIFY_URL,
    redirectUri: CODEX_DEVICE_REDIRECT_URI,
    userCode: device.userCode,
    expiresAt: p.expiresAt,
    listening: p.result.listening,
    listenError: '',
  };
}

/** 申请一组设备码。interval 由上游给，单位是秒，且不一定是数字类型。 */
async function requestCodexDeviceCode(
  p: Pending,
): Promise<{ deviceAuthId: string; userCode: string; intervalMs: number }> {
  const resp = await request(CODEX_DEVICE_CODE_URL, {
    signal: p.signal,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    timeoutMs: 25_000,
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`申请设备码失败 HTTP ${resp.status}: ${body.slice(0, 200)}`);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error('申请设备码的响应不是 JSON');
  }
  const deviceAuthId = String(payload.device_auth_id ?? '').trim();
  const userCode = String(payload.user_code ?? payload.usercode ?? '').trim();
  if (!deviceAuthId || !userCode) throw new Error('上游没有返回设备码，请稍后重试');

  const interval = Number(payload.interval ?? 0);
  return {
    deviceAuthId,
    userCode,
    intervalMs: interval > 0 ? interval * 1000 : CODEX_DEVICE_POLL_MS,
  };
}

type DevicePoll =
  | { state: 'pending' }
  | { state: 'ready'; code: string; verifier: string }
  | { state: 'failed'; error: string };

/**
 * 问一次“输完了没有”。
 *
 * 还没输完时上游回 403/404，这是常态而不是错误。其余状态码说明这串码已经不作数了
 * （被用过、被撤销），继续问下去也不会变，因此直接判失败，让用户重新发起。
 */
async function pollCodexDeviceOnce(p: Pending): Promise<DevicePoll> {
  const resp = await request(CODEX_DEVICE_POLL_URL, {
    signal: p.signal,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ device_auth_id: p.deviceAuthId, user_code: p.userCode }),
    timeoutMs: 25_000,
  });
  const body = await resp.text();
  if (resp.status === 403 || resp.status === 404) return { state: 'pending' };
  if (!resp.ok) {
    return { state: 'failed', error: `设备码授权失败 HTTP ${resp.status}: ${body.slice(0, 200)}` };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { state: 'failed', error: '设备码授权的响应不是 JSON' };
  }
  const code = String(payload.authorization_code ?? '').trim();
  // verifier 这次由上游给：PKCE 挑战是它在授权页那边生成的，本地那份对不上
  const verifier = String(payload.code_verifier ?? '').trim();
  if (!code || !verifier) return { state: 'failed', error: '设备码授权没有返回可用的授权码' };
  return { state: 'ready', code, verifier };
}

/**
 * 后台轮询，直到用户输完验证码、会话被取消或设备码过期。
 *
 * 单次网络失败只记下来接着试：这条链路要跨过用户换设备、手敲验证码的几分钟。
 * 真到超时才把最后那条错误报出去。
 */
async function pollCodexDevice(p: Pending, intervalMs: number): Promise<void> {
  let lastError = '';
  while (pending.get(p.loginId) === p && p.result.state === 'pending') {
    if (Date.now() > p.expiresAt) {
      p.result = {
        ...p.result,
        state: 'error',
        error: lastError || '设备码已过期，请重新发起登录',
      };
      return;
    }
    await delay(intervalMs);
    // 等待期间用户可能已经点了取消
    if (pending.get(p.loginId) !== p || p.result.state !== 'pending') return;

    let poll: DevicePoll;
    try {
      poll = await pollCodexDeviceOnce(p);
    } catch (err) {
      lastError = String(err instanceof Error ? err.message : err);
      continue;
    }
    if (poll.state === 'pending') continue;
    if (poll.state === 'failed') {
      p.result = { ...p.result, state: 'error', error: poll.error };
      return;
    }

    // 授权码已经到手，后面是一次性收尾，失败就是失败，重试只会拿着同一个码反复碰壁
    p.verifier = poll.verifier;
    try {
      await finishLogin(p, poll.code, '');
      p.onDone();
    } catch (err) {
      p.result = {
        ...p.result,
        state: 'error',
        error: String(err instanceof Error ? err.message : err),
      };
    }
    return;
  }
}

export function cancelLogin(loginId: string): void {
  const p = pending.get(loginId);
  if (p) {
    p.controller.abort();
    closeListeners(p);
  }
  pending.delete(loginId);
}

/** 供前端轮询：开了监听之后，登录是在浏览器那边收尾的，请求方拿不到返回值。 */
export function loginStatus(loginId: string): LoginStatus {
  sweep();
  const p = pending.get(loginId);
  if (!p) return { state: 'expired', accountId: '', error: '', listening: false };
  return p.result;
}

/**
 * 用户可能粘回三种东西：完整回调地址、`code#state` 这种拼接串，或者干净的 code。
 * 三种都接受，因为让用户自己从地址栏里挑出正确的一段，是这一步最容易出错的地方。
 */
export function parseCallbackInput(input: string): { code: string; state: string } {
  const trimmed = input.trim();
  if (!trimmed) return { code: '', state: '' };

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      // 授权入口链接本身也带 code 参数（值是字符串 "true"），要把它和真正的授权码区分开
      const code = url.searchParams.get('code') ?? '';
      if (code && code !== 'true') {
        return { code, state: url.searchParams.get('state') ?? '' };
      }
    } catch {
      /* 不是合法 URL，按裸 code 继续处理 */
    }
  }

  // Claude 的回调页给出的形式是 `code#state`
  const [beforeHash, afterHash] = trimmed.split('#');
  const code = beforeHash.split('&')[0].trim();
  return { code, state: (afterHash ?? '').trim() };
}

async function exchangeClaude(p: Pending, code: string): Promise<Record<string, unknown>> {
  const resp = await request(CLAUDE_TOKEN_URL, {
    signal: p.signal,
    method: 'POST',
    headers: claudeOAuthHeaders(),
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLAUDE_CLIENT_ID,
      code,
      redirect_uri: CLAUDE_REDIRECT_URI,
      code_verifier: p.verifier,
      state: p.state,
    }),
    timeoutMs: 30_000,
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`交换令牌失败 HTTP ${resp.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body) as Record<string, unknown>;
}

async function exchangeCodex(p: Pending, code: string): Promise<Record<string, unknown>> {
  // OpenAI 的令牌端点只接受表单编码，发 JSON 会被拒
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    // 设备码和授权码报的回调地址不同，必须与发起这次授权时用的那个一致
    redirect_uri: p.redirectUri,
    client_id: CODEX_CLIENT_ID,
    code_verifier: p.verifier,
  });
  const resp = await request(CODEX_TOKEN_URL, {
    signal: p.signal,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
    timeoutMs: 30_000,
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`交换令牌失败 HTTP ${resp.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body) as Record<string, unknown>;
}

/** Claude 的令牌不是 JWT，邮箱只能通过官方 profile 接口拿。 */
async function claudeEmail(accessToken: string, signal: AbortSignal): Promise<string> {
  try {
    const resp = await request(CLAUDE_PROFILE_URL, {
      signal,
      headers: claudeOAuthHeaders(accessToken),
      timeoutMs: 15_000,
    });
    if (resp.status !== 200) return '';
    const payload = (await resp.json()) as Record<string, unknown>;
    const account = payload.account;
    if (account && typeof account === 'object') {
      const rec = account as Record<string, unknown>;
      const email = rec.email_address ?? rec.email;
      if (typeof email === 'string') return email;
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * 换令牌并落盘。手动粘贴和本地监听两条路径都汇到这里，
 * 因此两种方式产出的账户文件完全一致。
 */
async function finishLogin(p: Pending, code: string, state: string): Promise<string> {
  p.signal.throwIfAborted();
  if (!code) throw new Error('没能从粘贴的内容里认出授权码');
  // state 不匹配意味着这个回调不是本次授权产生的，必须拒绝
  if (state && state !== p.state) throw new Error('授权状态不匹配，请重新登录');

  const accountsDir = p.accountsDir;
  const token =
    p.provider === 'claude' ? await exchangeClaude(p, code) : await exchangeCodex(p, code);

  const accessToken = String(token.access_token ?? '');
  if (!accessToken) throw new Error('上游没有返回 access_token');
  const refreshToken = String(token.refresh_token ?? '');
  const idToken = String(token.id_token ?? '');

  const mismatch = accountIdMismatch(idToken, accessToken);
  if (mismatch) throw new Error(mismatch);

  const claims = decodeJwt(idToken);
  const accountFromClaims = claims
    ? findClaim(claims, (k) => k === 'chatgpt_account_id' || k === 'account_id')
    : undefined;

  const email =
    (p.provider === 'claude' ? await claudeEmail(accessToken, p.signal) : emailOf(idToken || accessToken)) ||
    '';
  if (!email) throw new Error('没能识别该账户的邮箱，请改用导入本地账户');

  const expiresIn = Number(token.expires_in ?? 0);
  await saveAccount(accountsDir, {
    provider: p.provider,
    email,
    accountId: typeof accountFromClaims === 'string' ? accountFromClaims : '',
    accessToken,
    refreshToken,
    idToken,
    expiresAt:
      expiresIn > 0 ? Date.now() + expiresIn * 1000 : tokenExpiresAt(accessToken) || Date.now(),
    source: 'oauth',
  }, p.signal);

  const accountId = `${p.provider}:${email}`;
  closeListeners(p);
  // 结果先留一会儿，好让前端轮询到；随后由 sweep 清掉
  p.result = { state: 'done', accountId, error: '', listening: p.result.listening };
  p.expiresAt = Date.now() + RESULT_TTL_MS;
  return accountId;
}

/** 手动粘贴路径：用户把浏览器最终停留的地址（或授权码）交回来。 */
export async function completeLogin(
  accountsDir: string,
  loginId: string,
  input: string,
): Promise<string> {
  sweep();
  const p = pending.get(loginId);
  if (!p) throw new Error('这次授权已过期或已完成，请重新点击登录');
  if (p.result.state === 'done') return p.result.accountId;
  // Qoder 的授权页不会把 code 交到用户手里，粘什么都没用
  if (p.provider === 'qoder') {
    throw new Error('Qoder 登录不需要粘贴，在浏览器里完成授权后这里会自动写入');
  }
  // 设备码同理：授权码是服务端轮询取回来的，用户那边只有一串验证码
  if (p.userCode) {
    throw new Error('设备码登录不需要粘贴，输入验证码后这里会自动写入');
  }

  // 发起时没记下目录（比如旧的登录会话），就用这次请求带来的
  if (!p.accountsDir) p.accountsDir = accountsDir;
  const { code, state } = parseCallbackInput(input);
  return finishLogin(p, code, state);
}
