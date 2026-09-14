/**
 * 凭证的加载、刷新与落盘。
 *
 * 账户文件放在程序自己的目录里（见 config.ACCOUNTS_DIR），不再原地读写别人的认证目录——
 * 那样一旦刷新出错，会连带把其他客户端的登录状态一起弄坏。
 * 文件结构沿用通用凭证字段名，便于导入导出。
 */
import { readdir, readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { withCredentialLock } from './credential-lock.js';
import { followSourceOf, readClientTokens, type ClientTokens } from './clientfile.js';
import { request, type Audit, type HttpResponse } from './http.js';
import { claudeOAuthHeaders, diagnose } from './headers.js';
import type { Provider } from '../shared/types.js';

// 两家上游公开的 OAuth client ID，与官方 CLI 保持一致
export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/**
 * 刷新与授权码交换都走 platform.claude.com。
 * 老的 console.anthropic.com 仍然可用，但官方客户端已经迁到这里，跟着它走出问题最少。
 */
export const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
/**
 * 刷新时申报的 scope，与官方 CLI 一致。
 * 它是授权时那一组的子集（少了 offline_access），按 OAuth 规范收窄是允许的。
 */
const CODEX_REFRESH_SCOPE = 'openid profile email';

/** 提前 10 分钟刷新，避免长时间运行中途撞上 401。 */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export interface Account {
  id: string;
  provider: Provider;
  email: string;
  path: string;
  /** Codex 必填，Claude 为空。 */
  accountId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  disabled: boolean;
  /** 以下字段都直接从 token 内部声明中读取，见 readClaims。 */
  plan: string;
  /** 付费周期结束时间，毫秒时间戳；token 未提供时为 0。 */
  subscriptionEndsAt: number;
  /** 上游自己的用户 ID。 */
  userId: string;
  /** 账户登录方式，例如 'Google'、'Apple'、'Password'。 */
  loginMethod: string;
  /** 凭证来源，例如 'codex-cli'、'claude-cli'、'oauth'。 */
  source: string;
  /**
   * 是否由本程序自己刷新令牌。
   *
   * 关掉之后就是“跟随客户端”：本程序只拿同步过来的令牌查接口，续期完全交给原客户端
   * （比如 Claude Code 自己）。两个程序各自拿同一个 refresh_token 去刷新时，后写的那次
   * 会让先写的失效，跟随模式正是为了避免把用户正在用的客户端顶掉。
   */
  autoRefresh: boolean;
  /** 跟随模式下去哪个文件取新令牌；为空表示没有可同步的来源。 */
  syncPath: string;
  /** 同步来源的格式标识，决定 syncPath 怎么解析；缺省沿用 source。 */
  syncSource: string;
  /** 身份令牌原文；刷新响应没带新的时保留旧值，一致性校验也要用到。 */
  idToken: string;
}

/** 把 JWT 的 Base64url JSON payload 解出来；如果根本不是 JWT，就返回 null。 */
export function decodeJwt(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/** 深度优先查找第一个键名满足 `match` 的字段。 */
export function findClaim(node: unknown, match: (key: string) => boolean, depth = 0): unknown {
  if (depth > 4 || node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (match(k) && v !== null && v !== '') return v;
  }
  for (const v of Object.values(obj)) {
    const found = findClaim(v, match, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Auth0 会把身份提供方放在 subject 前缀里，例如 'google-oauth2|123'、
 * 'apple|123'；邮箱密码登录则通常是 'auth0|123'。
 */
function loginMethodOf(sub: unknown): string {
  const s = String(sub ?? '');
  const provider = s.includes('|') ? s.split('|')[0] : '';
  if (!provider) return '';
  if (provider.startsWith('google')) return 'Google';
  if (provider.startsWith('apple')) return 'Apple';
  if (provider.startsWith('windowslive') || provider.startsWith('microsoft')) return 'Microsoft';
  if (provider === 'auth0' || provider.startsWith('email')) return 'Password';
  return provider;
}

/**
 * 从已存储 token 中读取套餐、订阅到期时间、用户 ID 和登录方式。
 * 两家上游签发的 JWT 声明里本来就带有这些信息，因此不需要额外请求；整个过程也不会把 token
 * 发往新的地方，只是在本机解码。
 *
 * 声明字段按“形状”匹配，而不是硬编码完整键名：OpenAI 会把某些键挂在 URL 命名空间下
 * （例如 'https://api.openai.com/auth' -> chatgpt_plan_type），而且这个前缀以前变过。
 */
function readClaims(data: Record<string, unknown>, acct: Account): void {
  const claims =
    decodeJwt(String(data.id_token ?? '')) ?? decodeJwt(String(data.access_token ?? ''));
  if (!claims) return;

  const plan = findClaim(claims, (k) => k.endsWith('plan_type') || k === 'plan');
  if (typeof plan === 'string') acct.plan = plan;

  const until = findClaim(
    claims,
    (k) => k.includes('subscription') && /(until|end|expires)/.test(k),
  );
  if (until !== undefined) {
    // 不同上游有的给 epoch 秒，有的给 ISO 时间串，这里都兼容
    const n = Number(until);
    const ts = Number.isFinite(n) && n > 0 ? n * 1000 : Date.parse(String(until));
    if (!Number.isNaN(ts) && ts > 0) acct.subscriptionEndsAt = ts;
  }

  const userId = findClaim(claims, (k) => k === 'user_id' || k === 'chatgpt_user_id');
  if (typeof userId === 'string') acct.userId = userId;

  acct.loginMethod = loginMethodOf(claims.sub);
}

/**
 * 取出令牌里的 ChatGPT 账户 ID。
 * OpenAI 把它挂在 URL 命名空间下（'https://api.openai.com/auth' -> chatgpt_account_id），
 * 而这个前缀历史上变过，所以仍然按键名匹配而不是按完整路径取。
 */
function accountIdOf(token: string): string {
  const claims = decodeJwt(token);
  if (!claims) return '';
  const v = findClaim(claims, (k) => k === 'chatgpt_account_id' || k === 'account_id');
  return typeof v === 'string' ? v : '';
}

/**
 * 校验 id_token 与 access_token 指向同一个账户。
 *
 * 多账户切换时，如果 refresh_token 与本地记录的 id_token 不是同一个人，上游会照常签发
 * 一个能用的 access_token——只是它属于另一个账户。此时若直接写回，界面上仍显示原邮箱，
 * 实际却在给别的账户刷额度；这类错配从日志里几乎看不出来，因此必须在写盘前挡住。
 * 只有两边都能读出账户 ID 时才判定，读不出就放行（Claude 的令牌本来就不带这个声明）。
 */
export function accountIdMismatch(idToken: string, accessToken: string): string {
  const fromId = accountIdOf(idToken);
  const fromAccess = accountIdOf(accessToken);
  if (!fromId || !fromAccess || fromId === fromAccess) return '';
  return `id_token 与 access_token 的账户不一致（${fromId} ≠ ${fromAccess}）`;
}

/** 从令牌自带的 exp 声明推出到期时间；不是 JWT 或没有 exp 时返回 0。 */
export function tokenExpiresAt(token: string): number {
  const claims = decodeJwt(token);
  const exp = Number(claims?.exp ?? 0);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
}

/** 取出令牌里的邮箱声明。 */
export function emailOf(token: string): string {
  const claims = decodeJwt(token);
  if (!claims) return '';
  const v = findClaim(claims, (k) => k === 'email' || k === 'email_address');
  return typeof v === 'string' ? v : '';
}

function parseExpiry(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

export async function loadAccounts(authDir: string): Promise<Account[]> {
  let files: string[];
  try {
    files = (await readdir(authDir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }

  // 并发读：这个函数在每次快照和每次发送前都要跑一遍，串行读会把账户数乘进延迟里。
  // files 已排序，map 保序，所以结果顺序和一个个读时一致。
  const parsed = await Promise.all(files.map((f) => parseAccountFile(join(authDir, f), f)));
  return parsed.filter((a): a is Account => a !== null);
}

/** 读一个凭证文件；解析不了或不是本程序认得的 provider 时返回 null。 */
async function parseAccountFile(path: string, file: string): Promise<Account | null> {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null; // 跳过无法解析的凭证文件
  }

  const provider = String(data.type ?? '').toLowerCase();
  if (provider !== 'claude' && provider !== 'codex' && provider !== 'qoder') return null;

  const email = String(data.email ?? file);
  const account: Account = {
    id: `${provider}:${email}`,
    provider: provider as Provider,
    email,
    path,
    accountId: String(data.account_id ?? ''),
    accessToken: String(data.access_token ?? ''),
    refreshToken: String(data.refresh_token ?? ''),
    expiresAt: parseExpiry(data.expired),
    disabled: Boolean(data.disabled),
    // 文件里记着的是上一次查询到的值；能从令牌声明里解出更新的，readClaims 会覆盖掉
    plan: String(data.plan ?? ''),
    subscriptionEndsAt: 0,
    userId: String(data.user_id ?? ''),
    loginMethod: '',
    source: String(data.source ?? ''),
    // 老账户文件里没有这个字段，默认仍是本程序自己刷新，行为与升级前一致
    autoRefresh: data.auto_refresh === undefined ? true : Boolean(data.auto_refresh),
    syncPath: String(data.sync_path ?? ''),
    syncSource: String(data.sync_source ?? data.source ?? ''),
    idToken: String(data.id_token ?? ''),
  };
  // 账户 ID 缺失时，用令牌声明补上：官方 CLI 的 auth.json 就没有单独的顶层字段
  if (!account.accountId) account.accountId = accountIdOf(account.idToken || account.accessToken);
  readClaims(data, account);
  return account;
}

/** 按 ID 取单个账户；找不到时返回 null，由调用方决定怎么报错。 */
export async function loadAccount(authDir: string, accountId: string): Promise<Account | null> {
  return (await loadAccounts(authDir)).find((a) => a.id === accountId) ?? null;
}

/** 邮箱直接当文件名不安全，这里只保留可安全落盘的字符。 */
function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 80) || 'account';
}

/** 待写入账户目录的凭证。 */
export interface AccountInput {
  provider: Provider;
  email: string;
  accountId?: string;
  /** 上游自己的用户 ID；令牌声明里读不到时（Qoder）靠它区分账户。 */
  userId?: string;
  /** 套餐名；同上，令牌里没有就存一份导入时看到的。 */
  plan?: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: number;
  source: string;
  /** 省略时为 true，即由本程序自己刷新。 */
  autoRefresh?: boolean;
  /** 跟随模式下的同步来源文件；导入时记下，之后每次续期都回到它。 */
  syncPath?: string;
}

/**
 * 把一个账户写进程序自己的目录。同一个 provider + email 会落到同一个文件名上，
 * 因此重复导入或重新登录都是覆盖，而不是不断堆出新文件。
 */
export async function saveAccount(dir: string, input: AccountInput, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${input.provider}-${slug(input.email)}.json`);
  const data = {
    type: input.provider,
    email: input.email,
    account_id: input.accountId ?? '',
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
    id_token: input.idToken ?? '',
    user_id: input.userId ?? '',
    plan: input.plan ?? '',
    expired: new Date(input.expiresAt).toISOString(),
    last_refresh: new Date().toISOString(),
    source: input.source,
    auto_refresh: input.autoRefresh !== false,
    sync_path: input.syncPath ?? '',
    sync_source: input.source,
  };
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    // 取消检查与提交之间不能让出事件循环，否则取消完成后仍可能 rename。
    signal?.throwIfAborted();
    renameSync(tmp, path);
  } finally {
    await unlink(tmp).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    });
  }
  return path;
}

export async function deleteAccount(path: string): Promise<void> {
  await unlink(path);
}

/** 原子写：先落临时文件再 rename，避免别人读到写了一半的凭证。 */
async function writeJson(path: string, data: Record<string, unknown>): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

/** 读回账户文件原文；读不动时返回空对象，由调用方重建最必要的字段。 */
async function readAccountFile(path: string): Promise<Record<string, unknown>> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 把新 token 合并回原始文件，同时保留其他字段。
 * 通过原子 rename，避免读到一半写入的坏文件。
 */
async function writeBack(acct: Account): Promise<void> {
  const data = await readAccountFile(acct.path);
  data.access_token = acct.accessToken;
  if (acct.refreshToken) data.refresh_token = acct.refreshToken;
  if (acct.idToken) data.id_token = acct.idToken;
  if (acct.accountId) data.account_id = acct.accountId;
  data.expired = new Date(acct.expiresAt).toISOString();
  data.last_refresh = new Date().toISOString();
  await writeJson(acct.path, data);
}

/** 一次「能不能跟随这个客户端」的核对结果。 */
export interface FollowCheck {
  /** 允许改为跟随。 */
  ok: boolean;
  /** 不允许的理由，可以直接给用户看；ok 时为空串。 */
  reason: string;
  /** 核对的是哪个客户端，例如 'Claude Code'；本机没有可跟随的客户端时为空串。 */
  label: string;
  /** 核对通过后要跟随的来源标识与文件，切换时一并记进账户文件。 */
  source: string;
  path: string;
}

/**
 * 客户端凭证文件里的那个登录，和手里这个账户是不是同一个。
 *
 * 判据按可信度排：令牌一模一样就是同一份登录，不必再问；否则比账户 ID，再比邮箱。
 * 各来源能拿到的身份不一样——Claude 的 access_token 不是 JWT，凭证文件里也没有邮箱，
 * 只有 ~/.claude.json 记着它当前登录的是谁；Codex 的 id_token 里 account_id 和邮箱都有。
 * 一项都比不出来就是 'unknown'：确认不了是同一个，就不能当成是。
 *
 * 两个方向都用它，问的其实是同一件事：checkFollowClient 拿着账户问「这个客户端还是它吗」，
 * inuse.ts 拿着客户端问「它现在用的是哪个账户」。判据只能有一套，否则会出现「跟随核对不
 * 放行、界面却把它标成本机在用」这种自相矛盾。
 */
export type IdentityVerdict = {
  kind: 'same' | 'other-id' | 'other-email' | 'unknown';
  /** 客户端那边登录的是谁，邮箱优先、退到账户 ID；认不出来时为空串。 */
  who: string;
};

/** 客户端凭证里那个登录是谁：邮箱优先，退到账户 ID；两样都认不出来时为空串。 */
export function whoOf(tokens: ClientTokens): string {
  return (
    tokens.email ||
    emailOf(tokens.idToken || tokens.accessToken) ||
    tokens.accountId ||
    accountIdOf(tokens.idToken || tokens.accessToken)
  );
}

export function identityOf(tokens: ClientTokens, acct: Account): IdentityVerdict {
  const theirId = tokens.accountId || accountIdOf(tokens.idToken || tokens.accessToken);
  const myId = acct.accountId || accountIdOf(acct.idToken || acct.accessToken);
  const theirEmail = tokens.email || emailOf(tokens.idToken || tokens.accessToken);
  const who = whoOf(tokens);

  // 手里这份就是它那份，是同一个登录无疑
  if (tokens.accessToken && tokens.accessToken === acct.accessToken) return { kind: 'same', who };
  if (theirId && myId && theirId !== myId) return { kind: 'other-id', who };
  // 占位名（'claude-code'、'qoder' 这类）不是邮箱，拿它比只会得出假结论
  if (isEmail(theirEmail) && isEmail(acct.email) && !sameEmail(theirEmail, acct.email)) {
    return { kind: 'other-email', who: theirEmail };
  }
  const compared = (theirId && myId) || (isEmail(theirEmail) && isEmail(acct.email));
  return { kind: compared ? 'same' : 'unknown', who };
}

/**
 * 「改为跟随客户端」之前的身份核对：本机那个客户端现在登录的还是这个账户吗。
 *
 * 跟随模式的全部内容就是「过期了就回客户端的凭证文件里取一份新令牌」，所以核对的对象只能是
 * **这台机器上那个客户端此刻登录的账户**：Claude 比 ~/.claude/.credentials.json 那份登录，
 * Codex 比 ~/.codex/auth.json（导入时记过来源文件的则比它自己那份）。客户端要是已经换了账号，
 * 跟随就会一路把别人的令牌同步进来：卡片上还写着 A 的邮箱，查的却是 B 的额度。
 *
 * 比身份的那套判据在 identityOf 里，与账户列表上的「本机在用」标记共用。
 * 一项都比不出来时同样不放行：确认不了是不是同一个账户，跟随的就可能是别人。
 */
export async function checkFollowClient(acct: Account): Promise<FollowCheck> {
  const src = followSourceOf(acct.provider, acct.syncSource || acct.source, acct.syncPath);
  if (!src) {
    return { ok: false, reason: '这个账户没有可跟随的客户端', label: '', source: '', path: '' };
  }

  const deny = (reason: string): FollowCheck => ({ ok: false, reason, label: src.label, source: '', path: '' });
  const allow = (): FollowCheck => ({
    ok: true,
    reason: '',
    label: src.label,
    source: src.source,
    path: src.path,
  });

  const tokens = await readClientTokens(src.source, src.path);
  if (!tokens) return deny(`没能从 ${src.label} 的 ${src.path} 读出令牌，确认不了它登录的是哪个账户`);

  const verdict = identityOf(tokens, acct);
  if (verdict.kind === 'same') return allow();
  if (verdict.kind === 'other-id') {
    return deny(`${src.label} 现在登录的是另一个账户（${verdict.who}），不是 ${acct.email}`);
  }
  if (verdict.kind === 'other-email') {
    return deny(`${src.label} 现在登录的是 ${verdict.who}，不是 ${acct.email}`);
  }
  return deny(`认不出 ${src.label} 现在登录的是哪个账户，无法确认与 ${acct.email} 是同一个`);
}

/** 占位名（'claude-code'、'qoder' 等）不是邮箱，不能拿来判断身份。 */
function isEmail(v: string): boolean {
  return v.includes('@');
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * 切换某个账户的续期方式，并把结果落盘。
 *
 * 关掉自动刷新即“跟随客户端”：本程序从此只用同步过来的令牌查接口，不再拿 refresh_token
 * 去换新的。原客户端（Claude Code 等）刷新后写进自己的凭证文件，我们下次临近过期时再去取。
 */
export async function setAutoRefresh(
  acct: Account,
  autoRefresh: boolean,
  follow?: { source: string; path: string },
): Promise<void> {
  const data = await readAccountFile(acct.path);
  data.auto_refresh = autoRefresh;
  // 记下核对时定位到的那个文件：早期导入的账户没有 sync_path，不补上的话一开跟随就没处可取
  if (follow) {
    data.sync_source = follow.source;
    data.sync_path = follow.path;
  } else if (!data.sync_source) {
    // 沿用 source 至少还有机会认出格式
    data.sync_source = acct.syncSource || acct.source;
  }
  await writeJson(acct.path, data);
  acct.autoRefresh = autoRefresh;
  acct.syncSource = String(data.sync_source ?? '');
  acct.syncPath = String(data.sync_path ?? '');
}

/**
 * 这个账户的请求日志上下文。
 *
 * 凡是代表账户发给上游的请求都该带上它：日志才是完整的，而不是只有发送那一条。
 * 两个令牌都要交出去，因为落库前是按**值**把它们从请求里抹掉的。
 */
export function auditOf(acct: Account): Audit {
  return {
    accountId: acct.id,
    secrets: { accessToken: acct.accessToken, refreshToken: acct.refreshToken },
  };
}

/** 令牌离过期还远，可以直接用。 */
function stillFresh(acct: Account): boolean {
  return acct.expiresAt - Date.now() > REFRESH_MARGIN_MS;
}

/**
 * 跟随模式下的续期：不走 OAuth，只回到原客户端的凭证文件里取一份新令牌。
 *
 * 这里刻意不发任何网络请求。用同一个 refresh_token 去刷新会把客户端手里那份顶掉——
 * 用户下次打开 Claude Code 就得重新登录，而这正是同步进来的账户最不该造成的副作用。
 * 客户端还没续期时就如实报错等下一轮，而不是自作主张替它刷新。
 */
async function syncFromClient(
  acct: Account,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): Promise<boolean> {
  if (stillFresh(acct)) return true;
  if (!acct.syncPath) {
    log('error', 'token 已过期，且没有记录同步来源；请重新导入该账户，或改回自动刷新');
    return false;
  }

  const tokens = await readClientTokens(acct.syncSource, acct.syncPath);
  if (!tokens) {
    log('error', `没能从 ${acct.syncPath} 读出令牌，请确认该客户端仍是登录状态`);
    return false;
  }
  if (tokens.accessToken === acct.accessToken) {
    log('error', `${acct.syncPath} 里还是同一个 token，等客户端自己续期后会自动同步`);
    return false;
  }

  // 客户端可能刚好也过期了（比如很久没打开），这时同步过来也是白搭
  const expiresAt = tokens.expiresAt || tokenExpiresAt(tokens.accessToken);
  if (expiresAt > 0 && expiresAt <= Date.now()) {
    log('error', `${acct.syncPath} 里的 token 同样已过期，请在该客户端里用一次让它续期`);
    return false;
  }

  const idToken = tokens.idToken || acct.idToken;
  const mismatch = accountIdMismatch(idToken, tokens.accessToken);
  if (mismatch) {
    // 客户端那边可能已经换了账号，同步过来会让这张卡片显示 A 却在查 B 的额度
    log('error', `同步结果被拒绝：${mismatch}，请重新导入该账户`);
    return false;
  }

  const theirId = tokens.accountId || accountIdOf(tokens.idToken || tokens.accessToken);
  const theirEmail = tokens.email || emailOf(tokens.idToken || tokens.accessToken);
  const sameId = Boolean(theirId && acct.accountId && theirId === acct.accountId);
  const comparableEmail = isEmail(theirEmail) && isEmail(acct.email);
  if ((theirId && acct.accountId && theirId !== acct.accountId) ||
      (comparableEmail && !sameEmail(theirEmail, acct.email)) ||
      (!sameId && !comparableEmail)) {
    log('error', '同步结果被拒绝：客户端身份与当前账户不一致或无法确认，请重新导入');
    return false;
  }

  acct.accessToken = tokens.accessToken;
  acct.idToken = idToken;
  if (tokens.refreshToken) acct.refreshToken = tokens.refreshToken;
  if (!acct.accountId) acct.accountId = tokens.accountId || accountIdOf(idToken || tokens.accessToken);
  // 客户端文件没写到期时间、令牌本身也不是 JWT 时无从得知，按上游常见的一小时估一个：
  // 估短了只是下一轮再同步一次，估长了才会撞上 401
  acct.expiresAt = expiresAt || Date.now() + 60 * 60 * 1000;
  await writeBack(acct);
  log('info', `已从 ${acct.syncPath} 同步到新 token，有效期至 ${new Date(acct.expiresAt).toLocaleString()}`);
  return true;
}

/**
 * Qoder 的“续期”：回到 IDE 的 state.vscdb 里重读一遍令牌。
 *
 * 与 syncFromClient 的差别都来自 Qoder 自身：
 * - 令牌不一定是 JWT，IDE 也不写到期时间，所以 expiresAt 常年为 0，`stillFresh` 永远为假。
 *   这意味着每次用之前都会重读一次本地 SQLite——代价很小，而且总能拿到 IDE 手里最新的那份。
 * - 因此“读到的还是同一个 token”是常态而非错误，不能像 syncFromClient 那样报错拦下。
 *
 * 唯一会拦的是身份对不上：用户在 IDE 里换了账号时，重读会把另一个账户的令牌拿回来，
 * 这张卡片就会显示着 A 的邮箱去查 B 的额度。
 */
async function syncQoder(
  acct: Account,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): Promise<boolean> {
  if (stillFresh(acct)) return true;
  // 在本程序里登录进来的账户没有可回读的库，也没有 refresh 端点：手里这份能用就用，
  // 真失效了由接口的 401 说明白，比在这里提前判死刑准确
  if (!acct.syncPath) {
    if (acct.accessToken === '') return false;
    if (acct.expiresAt > 0 && acct.expiresAt <= Date.now()) {
      log('warn', 'Qoder 令牌已过期且无处续期，请在账户弹窗里重新登录一次');
    }
    return true;
  }

  const tokens = await readClientTokens('qoder-ide', acct.syncPath);
  if (!tokens) {
    // 读不出来时先用手里这份：真失效了，接口会以 401 说明白，比这里猜一个理由准确
    log('warn', `没能从 ${acct.syncPath} 读出 Qoder 令牌，仍沿用上次同步到的那份`);
    return acct.accessToken !== '';
  }
  if (tokens.accountId && acct.userId && tokens.accountId !== acct.userId) {
    log('error', `Qoder IDE 里当前登录的是另一个账户（${tokens.accountId} ≠ ${acct.userId}），已跳过同步`);
    return false;
  }
  if (tokens.accessToken !== acct.accessToken) {
    acct.accessToken = tokens.accessToken;
    acct.expiresAt = tokens.expiresAt || tokenExpiresAt(tokens.accessToken);
    await writeBack(acct);
    log('info', `已从 ${acct.syncPath} 同步到新的 Qoder 令牌`);
  }
  return true;
}

/**
 * 拿 refresh_token 向上游换一份新的 access_token，并写回账户文件。
 *
 * 从 ensureFresh 里单独拆出来，是为了让界面上的「强制刷新」能绕开 stillFresh 那道判断：
 * 手动点它的场景恰恰是令牌名义上还没过期、实际却已经不好使了（比如被另一个客户端顶掉），
 * 这时「还早着呢」正是要跳过的那一句。
 *
 * 换来的旧 refresh_token 会被上游作废，因此这条路径对「跟随客户端」的账户是禁区，
 * 拦截放在调用方：这里只管换，不判断该不该换。
 */
async function performOAuthRefresh(
  acct: Account,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): Promise<boolean> {
  if (!acct.refreshToken) {
    log('error', '无法刷新 token：这个账户没有 refresh_token');
    return false;
  }

  const isClaude = acct.provider === 'claude';
  const url = isClaude ? CLAUDE_TOKEN_URL : CODEX_TOKEN_URL;
  // 两家的令牌端点连编码都不一样：Claude 收 JSON（axios 发的），OpenAI 只收表单。
  // 我们的授权码交换早就是表单了，刷新这条之前发的却是 JSON，两条路径本身就对不上。
  const reqBody = isClaude
    ? JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: acct.refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      })
    : new URLSearchParams({
        client_id: CODEX_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: acct.refreshToken,
        scope: CODEX_REFRESH_SCOPE,
      }).toString();

  let resp: HttpResponse;
  try {
    resp = await request(url, {
      method: 'POST',
      headers: isClaude
        ? claudeOAuthHeaders()
        : { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: reqBody,
      timeoutMs: 30_000,
      // 刷新也是一次发给上游的请求，同样要留痕。正文里的 refresh_token
      // 会被换成占位符，因此库里落不下一份长期凭证。
      audit: auditOf(acct),
    });
  } catch (err) {
    log('error', `刷新 token 网络失败: ${String((err as Error).cause ?? err)}`);
    return false;
  }

  const text = await resp.text();
  if (!resp.ok) {
    log('error', `刷新 token 失败 ${resp.status}${diagnose(resp.headers, text)}: ${text.slice(0, 200)}`);
    return false;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    log('error', '刷新 token 的响应不是 JSON');
    return false;
  }

  const accessToken = String(body.access_token ?? acct.accessToken);
  // 上游并不总是重发 id_token；这时保留旧的，否则会平白丢掉账户身份信息
  const idToken = body.id_token ? String(body.id_token) : acct.idToken;

  const replacementId = accountIdOf(accessToken) || accountIdOf(idToken);
  const mismatch = accountIdMismatch(idToken, accessToken) ||
    (acct.accountId && replacementId && acct.accountId !== replacementId ? '刷新令牌与已保存的账户不一致' : '');
  if (mismatch) {
    // 宁可这一轮不发送，也不能把别的账户的令牌写进这个账户文件
    log('error', `刷新结果被拒绝：${mismatch}，请重新登录该账户`);
    return false;
  }

  acct.accessToken = accessToken;
  acct.idToken = idToken;
  if (body.refresh_token) acct.refreshToken = String(body.refresh_token);
  acct.expiresAt = Date.now() + Number(body.expires_in ?? 3600) * 1000;
  if (!acct.accountId) acct.accountId = accountIdOf(idToken || accessToken);
  await writeBack(acct);
  log('info', `token 已刷新，有效期至 ${new Date(acct.expiresAt).toLocaleString()}`);
  return true;
}

// 每个调用方可能拿着独立的 Account 副本，等待者也必须接收刷新后的字段。
const renewals = new Map<string, Promise<Account | null>>();

export async function refreshViaOAuth(
  acct: Account,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): Promise<boolean> {
  const key = resolve(acct.path);
  let pending = renewals.get(key);
  if (!pending) {
    const originalToken = acct.accessToken;
    const originalRefresh = acct.refreshToken;
    pending = withCredentialLock(key, async () => {
      const latest = (await loadAccounts(dirname(key))).find((a) => resolve(a.path) === key);
      if (!latest || latest.id !== acct.id || (acct.accountId && latest.accountId !== acct.accountId)) return null;
      if ((latest.accessToken !== originalToken || latest.refreshToken !== originalRefresh) && stillFresh(latest)) return latest;
      if (!latest.autoRefresh) return (await syncFromClient(latest, log)) ? latest : null;
      return (await performOAuthRefresh(latest, log)) ? latest : null;
    });
    renewals.set(key, pending);
  }
  try {
    const updated = await pending;
    if (!updated) return false;
    Object.assign(acct, updated);
    return true;
  } catch (error) {
    log('error', `凭证刷新失败: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    if (renewals.get(key) === pending) renewals.delete(key);
  }
}

/** 按需刷新 accessToken；返回当前 token 是否仍可用。 */
export async function ensureFresh(
  acct: Account,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): Promise<boolean> {
  // Qoder 没有 OAuth 续期这条路，只能回 IDE 的库里重读
  if (acct.provider === 'qoder') return syncQoder(acct, log);
  // 跟随客户端的账户由原客户端负责续期，这里只同步，绝不动 OAuth
  if (!acct.autoRefresh) return syncFromClient(acct, log);
  if (stillFresh(acct)) return true;
  if (!acct.refreshToken) {
    log('error', 'token 已过期且没有 refresh_token');
    return false;
  }
  return refreshViaOAuth(acct, log);
}
