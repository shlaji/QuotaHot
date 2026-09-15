/**
 * Qoder 账户的导入与只读额度查询。
 *
 * 与 claude / codex 有两处根本区别，其余设计都由它们推导而来：
 *
 * 1. **没有会自己重置的 5 小时窗口。** Qoder 卖的是按订阅周期发放的 credits，用完为止。
 *    因此这类账户永远不进调度器（见 scheduler.selectSchedulable），只做导入和额度展示。
 * 2. **凭证不在 JSON 文件里。** Qoder 是 VS Code 系的 IDE，令牌存在
 *    `<userDataDir>/User/globalStorage/state.vscdb` 的 ItemTable 里，值又被 Electron
 *    safeStorage 加密过。所以这里要自己读 SQLite 再解密，而不是像别的来源那样读文件。
 *
 * 这里同样不做任何“续期”：Qoder 没有给出可用的 refresh_token 链路，账户一律按
 * “跟随客户端”导入——需要新令牌时回到同一个 state.vscdb 再读一遍，由 IDE 自己续期。
 *
 * 参照实现：cockpit-tools（Rust/Tauri）的 qoder_account.rs / qoder_oauth.rs / vscode_inject.rs。
 */
import { execFileSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { noteError, request, type Audit } from './http.js';
import { diagnose, qoderHeaders, type QoderMachine } from './headers.js';
import type { Account } from './creds.js';
import type { UsageResult, Window } from '../shared/types.js';

const QODER_OPENAPI_BASE = 'https://openapi.qoder.sh';
/** 额度总览；这是本模块唯一必须成功的请求。 */
const QODER_QUOTA_PATH = '/api/v2/quota/usage';
/** 套餐名称；拿不到就退回 state.vscdb 里缓存的那份，因此失败不影响结果。 */
const QODER_PLAN_PATH = '/api/v2/user/plan';

/** IDE 把这三段 JSON 分别加密后存进 ItemTable。 */
const SECRET_USER_INFO = 'secret://aicoding.auth.userInfo';
const SECRET_USER_PLAN = 'secret://aicoding.auth.userPlan';
const SECRET_CREDIT_USAGE = 'secret://aicoding.auth.creditUsage';

const MAX_RAW = 4000;

/**
 * 上游用“公元 9999 年”表示“本档位没有到期时间”。
 * 直接透传会让界面显示一个荒唐的倒计时，因此当成“没有重置时间”处理。
 */
const SENTINEL_EXPIRES_AT_MS = Date.UTC(9999, 11, 31);

/* ── 本机路径 ────────────────────────────────────────────────────────────── */

/** Qoder IDE 的用户数据目录；与 VS Code 一样按平台放在各自的应用数据目录下。 */
export function qoderUserDataDir(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Qoder');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Qoder');
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Qoder');
}

export function qoderStateDbPath(userDataDir = qoderUserDataDir()): string {
  return join(userDataDir, 'User', 'globalStorage', 'state.vscdb');
}

/** Qoder IDE 的机器令牌缓存，放在用户数据目录的 SharedClientCache 下。 */
function qoderIdeMachineTokenPath(userDataDir = qoderUserDataDir()): string {
  return join(userDataDir, 'SharedClientCache', 'cache', 'machine_token.json');
}

/**
 * Qoder 桌面版 / CLI 的机器令牌缓存。
 * 桌面版不走平台数据目录，凭证和缓存都固定放在 home 下的 ~/.qoder，因此这里不按平台分叉。
 */
function qoderCliMachineTokenPath(): string {
  return join(homedir(), '.qoder', 'shared_client', 'cache', 'machine_token.json');
}

/** 从一个 machine_token.json 里读出机器标识；文件缺失或没有 token 时返回 null。 */
async function readMachineTokenFile(path: string): Promise<QoderMachine | null> {
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const machine: QoderMachine = {
    token: str(data.token),
    machineType: str(data.type),
    machineCode: str(data.code),
    machineId: str(data.id),
    machineHostname: str(data.hostname),
    machineOS: str(data.os),
    cosyVersion: str(data.version),
  };
  return machine.token ? machine : null;
}

/**
 * 读取本机缓存的机器标识。
 *
 * 整份缓存都是可选的：读不到就发一组只有 Authorization 的请求头，多数接口照常返回。
 * 来源有两个——IDE 的 SharedClientCache 和桌面版/CLI 的 ~/.qoder——它们的机器标识各自独立，
 * 装了哪个就用哪个。默认按「IDE 优先、回退到桌面版」的顺序找第一个能读到 token 的；
 * 显式传入 path 时只读这一个，便于测试和定向读取。
 */
export async function readQoderMachine(path?: string): Promise<QoderMachine | null> {
  if (path !== undefined) return readMachineTokenFile(path);
  for (const candidate of [qoderIdeMachineTokenPath(), qoderCliMachineTokenPath()]) {
    const machine = await readMachineTokenFile(candidate);
    if (machine) return machine;
  }
  return null;
}

/* ── Electron safeStorage 解密 ───────────────────────────────────────────── */

/** Chromium 系一贯的固定参数：IV 是 16 个空格，盐是 'saltysalt'。 */
const CBC_IV = Buffer.alloc(16, 0x20);
const SALT = 'saltysalt';

/** PBKDF2-HMAC-SHA1(密码, 'saltysalt') 出 16 字节 AES-128 密钥。 */
function deriveKey(password: string, iterations: number): Buffer {
  return pbkdf2Sync(password, SALT, iterations, 16, 'sha1');
}

function commandOutput(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return '';
  }
}

/**
 * Linux 的密钥。
 *
 * v11 表示密码来自系统密钥环，用 `secret-tool` 取；桌面环境没跑密钥环时 Electron 会退回
 * 空密码，因此拿不到也不算失败，让调用方再试一遍空密码派生的密钥。
 * v10 则是众所周知的固定密码 'peanuts'。
 */
function linuxKeys(prefix: string, application = 'Qoder'): Buffer[] {
  const empty = deriveKey('', 1);
  if (prefix === 'v10') return [deriveKey('peanuts', 1), empty];
  const keys: Buffer[] = [];
  for (const app of [application, application.toLowerCase()]) {
    const password = commandOutput('secret-tool', ['lookup', 'application', app]);
    if (password) {
      keys.push(deriveKey(password, 1));
      break;
    }
  }
  keys.push(empty);
  return keys;
}

/** macOS 的密钥存在钥匙串里，条目名随发行版本变过，这里按参照实现的顺序试一遍。 */
function macKeys(): Buffer[] {
  for (const account of ['Qoder', 'qoder', 'Qoder Safe Storage']) {
    const password = commandOutput('security', [
      'find-generic-password',
      '-w',
      '-s',
      'Qoder Safe Storage',
      '-a',
      account,
    ]);
    if (password) return [deriveKey(password, 1003)];
  }
  const password = commandOutput('security', [
    'find-generic-password',
    '-w',
    '-s',
    'Qoder Safe Storage',
  ]);
  return password ? [deriveKey(password, 1003)] : [];
}

function decryptCbc(payload: Buffer, key: Buffer): string {
  const decipher = createDecipheriv('aes-128-cbc', key, CBC_IV);
  const out = Buffer.concat([decipher.update(payload), decipher.final()]);
  return out.toString('utf8');
}

/**
 * 解开 safeStorage 密文。
 *
 * Windows 用的是 DPAPI + AES-256-GCM，密钥只能通过 Win32 API 拿到，纯 Node 做不了——
 * 那里如实报错，而不是给出一段乱码让用户以为是别的问题。
 */
export function decryptSafeStorage(encrypted: Buffer, application = 'Qoder'): string {
  const prefix = encrypted.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') {
    throw new Error(`无法识别的 safeStorage 密文前缀: ${JSON.stringify(prefix)}`);
  }
  if (process.platform === 'win32') {
    throw new Error('Windows 上的 Qoder 凭证由 DPAPI 加密，本程序暂不支持导入');
  }

  const body = encrypted.subarray(3);
  const keys = process.platform === 'darwin' ? macKeys() : linuxKeys(prefix, application);
  if (keys.length === 0) {
    throw new Error('没能取到 Qoder 的 safeStorage 密钥，请确认系统钥匙串/密钥环可用');
  }
  let last = '';
  for (const key of keys) {
    try {
      return decryptCbc(body, key);
    } catch (err) {
      last = String((err as Error).message ?? err);
    }
  }
  throw new Error(`Qoder 凭证解密失败: ${last}`);
}

/**
 * ItemTable 里的值：要么是明文 JSON，要么是 `{"data":[…字节…]}` 这样的密文包装。
 * 认不出来时原样返回，交给上层去解析——上游改格式时至少还能看到原文。
 */
export function decodeSecretValue(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const data = (parsed as { data?: unknown })?.data;
  if (!Array.isArray(data)) return raw;
  return decryptSafeStorage(Buffer.from(data as number[]));
}

/* ── state.vscdb ─────────────────────────────────────────────────────────── */

/** IDE 里缓存的三段身份/额度 JSON，字段全部按可选处理。 */
export interface QoderSnapshot {
  userInfo: Record<string, unknown> | null;
  userPlan: Record<string, unknown> | null;
  creditUsage: Record<string, unknown> | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 从 state.vscdb 读出这三段密文并解密。
 *
 * 只读打开：IDE 可能正开着同一个库，我们绝不能因为一次导入把它的写入弄坏。
 */
export function readQoderSnapshot(dbPath = qoderStateDbPath()): QoderSnapshot {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
    const one = (key: string): Record<string, unknown> | null => {
      const row = stmt.get(key) as { value?: unknown } | undefined;
      if (!row || typeof row.value !== 'string') return null;
      try {
        return asRecord(JSON.parse(decodeSecretValue(row.value)));
      } catch {
        return null;
      }
    };
    return {
      userInfo: one(SECRET_USER_INFO),
      userPlan: one(SECRET_USER_PLAN),
      creditUsage: one(SECRET_CREDIT_USAGE),
    };
  } finally {
    db.close();
  }
}

/* ── 字段提取 ────────────────────────────────────────────────────────────── */

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 在若干个候选对象里按键名依次找第一个非空字符串。 */
function pickString(sources: (Record<string, unknown> | null | undefined)[], keys: string[]): string {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const v = text(source[key]);
      if (v) return v;
    }
  }
  return '';
}

function pickNumber(
  sources: (Record<string, unknown> | null | undefined)[],
  keys: string[],
): number | null {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const v = num(source[key]);
      if (v !== null) return v;
    }
  }
  return null;
}

/** 上游有时给 0–1 的比例，有时给 0–100 的百分数；都收敛成百分数。 */
function clampPercent(value: number | null): number | null {
  if (value === null) return null;
  const normalized = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, normalized));
}

/** 秒或毫秒都收，哨兵值（9999 年）当作“没有到期时间”。 */
function timestampMs(value: number | null): number | null {
  if (value === null || value <= 0) return null;
  const ms = value >= 1_000_000_000_000 ? Math.round(value) : Math.round(value * 1000);
  return ms >= SENTINEL_EXPIRES_AT_MS ? null : ms;
}

/** 一档额度：自有额度、加油包、组织共享包都是这个形状。 */
interface Bucket {
  used: number | null;
  total: number | null;
  remaining: number | null;
  percent: number | null;
  unit: string;
}

function parseBucket(raw: unknown): Bucket {
  const rec = asRecord(raw);
  const used = pickNumber([rec], ['used', 'usage', 'consumed']);
  const total = pickNumber([rec], ['total', 'quota', 'limit']);
  const remaining =
    pickNumber([rec], ['remaining', 'available', 'left']) ??
    (total !== null && used !== null ? Math.max(0, total - used) : null);
  const percent = clampPercent(
    pickNumber([rec], ['percentage', 'usagePercent', 'usage_percentage']) ??
      (total !== null && used !== null && total > 0 ? (used / total) * 100 : null),
  );
  return { used, total, remaining, percent, unit: pickString([rec], ['unit']) || 'credits' };
}

/** 从额度响应里解析出的全部内容。 */
export interface QoderQuota {
  plan: string;
  userId: string;
  email: string;
  /** 订阅周期结束时间，毫秒时间戳；上游用哨兵值表示“不过期”时为 null。 */
  expiresAt: number | null;
  windows: Window[];
}

/**
 * 解析额度响应，保持纯函数形式便于用真实响应做校验。
 *
 * `payload` 可以是 /api/v2/quota/usage 的响应，也可以是 state.vscdb 里缓存的那份
 * creditUsage——两者字段一致，这正是导入时不必联网也能显示额度的原因。
 * `extra` 用来把 userPlan / userInfo 一起纳入查找范围。
 */
export function parseQoderQuota(
  payload: unknown,
  extra: (Record<string, unknown> | null)[] = [],
): QoderQuota {
  const usage = asRecord(payload);
  // 有的部署把内容包在 data / result 下面，两层都要看
  const sources = [usage, asRecord(usage?.data), asRecord(usage?.result), ...extra].filter(
    (s): s is Record<string, unknown> => s !== null,
  );

  const userQuota = parseBucket(pickFirstRecord(sources, ['userQuota', 'user_quota']));
  const addOn = parseBucket(pickFirstRecord(sources, ['addOnQuota', 'addonQuota', 'add_on_quota']));
  const totalPercent = clampPercent(
    pickNumber(sources, ['totalUsagePercentage', 'total_usage_percentage']),
  );
  const expiresAt = timestampMs(
    pickNumber(sources, ['expiresAt', 'expires_at', 'resetAt', 'reset_at']),
  );

  const windows: Window[] = [];
  const percent = userQuota.percent ?? totalPercent;
  if (userQuota.total !== null || userQuota.used !== null || percent !== null) {
    windows.push({
      name: 'credits',
      // 订阅周期结束才发新的 credits，这就是 Qoder 唯一的“重置时刻”；没有则为 0
      resetAt: expiresAt ?? 0,
      usedPercent: percent,
      // 周期长度上游没给，也不是固定值（月付/年付都有），不猜
      windowMinutes: null,
      source: 'qoder:quota',
      ...(userQuota.used !== null ? { used: userQuota.used } : {}),
      ...(userQuota.total !== null ? { total: userQuota.total } : {}),
      unit: userQuota.unit,
    });
  }
  if (addOn.total !== null && addOn.total > 0) {
    windows.push({
      name: 'credits_addon',
      // 加油包不随订阅周期重置，用完为止
      resetAt: 0,
      usedPercent: addOn.percent,
      windowMinutes: null,
      source: 'qoder:quota',
      ...(addOn.used !== null ? { used: addOn.used } : {}),
      total: addOn.total,
      unit: addOn.unit,
    });
  }

  return {
    plan: pickString(sources, [
      'plan_tier_name',
      'tier_name',
      'tierName',
      'planTierName',
      'plan',
      'userTag',
      'user_tag',
    ]),
    userId: pickString(sources, ['userId', 'user_id', 'uid', 'id']),
    email: pickString(sources, ['email', 'mail']).toLowerCase(),
    expiresAt,
    windows,
  };
}

function pickFirstRecord(
  sources: Record<string, unknown>[],
  keys: string[],
): Record<string, unknown> | null {
  for (const source of sources) {
    for (const key of keys) {
      const rec = asRecord(source[key]);
      if (rec) return rec;
    }
  }
  return null;
}

/** 从快照里读出的账户身份。 */
export interface QoderProfile {
  email: string;
  userId: string;
  displayName: string;
  plan: string;
  accessToken: string;
  /** 令牌到期时间，毫秒时间戳；IDE 没写就是 0，此时每次用之前都回去重读一遍。 */
  expiresAt: number;
  quota: QoderQuota;
}

/** 令牌在 userInfo 里，键名历史上变过几次，按参照实现的顺序找。 */
function accessTokenOf(userInfo: Record<string, unknown> | null): string {
  if (!userInfo) return '';
  const direct = pickString([userInfo], ['token', 'securityOauthToken', 'accessToken', 'access_token']);
  if (direct) return direct;
  return pickString([asRecord(userInfo.result), asRecord(userInfo.data)], ['token', 'accessToken']);
}

export function profileOf(snapshot: QoderSnapshot): QoderProfile {
  const { userInfo, userPlan, creditUsage } = snapshot;
  const quota = parseQoderQuota(creditUsage, [userPlan, userInfo]);
  const sources = [userInfo, userPlan, creditUsage];
  return {
    email: quota.email || pickString(sources, ['email', 'mail']).toLowerCase(),
    userId: quota.userId || pickString(sources, ['userId', 'user_id', 'uid', 'id']),
    displayName: pickString([userInfo], ['name', 'nickname', 'display_name', 'displayName', 'username']),
    plan: quota.plan,
    accessToken: accessTokenOf(userInfo),
    expiresAt: timestampMs(pickNumber(sources, ['tokenExpiresAt', 'token_expires_at'])) ?? 0,
    quota,
  };
}

/* ── 额度查询 ────────────────────────────────────────────────────────────── */

/**
 * 这个账户的请求日志上下文。
 *
 * 与 creds.auditOf 是同一件事，但这里自己拼一份：creds.ts 会经由 clientfile.ts 引到
 * 本模块，反过来引它就成了循环依赖。Qoder 没有 refresh_token，字段本来也更少。
 */
function auditOf(acct: Account): Audit {
  return { accountId: acct.id, secrets: { accessToken: acct.accessToken } };
}

/** 查一次 Qoder 额度。整个过程只读，不会消耗任何 credits。 */
export async function queryQoderUsage(acct: Account): Promise<UsageResult> {
  const base: UsageResult = {
    accountId: acct.id,
    provider: acct.provider,
    email: acct.email,
    ok: false,
    status: 0,
    error: '',
    plan: acct.plan,
    subscriptionEndsAt: acct.subscriptionEndsAt || null,
    userId: acct.userId,
    // 这两个是 ChatGPT 侧“重置用量”的概念，Qoder 没有对应物
    resetCredits: null,
    resetCreditsExpiresAt: null,
    orgType: '',
    quotaAvailable: null,
    windows: [],
    endpoint: '',
    raw: '',
  };

  const machine = await readQoderMachine();
  const headers = qoderHeaders(acct.accessToken, machine);
  const url = `${QODER_OPENAPI_BASE}${QODER_QUOTA_PATH}`;
  const audit = auditOf(acct);

  let body: string;
  let status: number;
  let respHeaders: Headers;
  try {
    const resp = await request(url, { headers, timeoutMs: 30_000, audit });
    status = resp.status;
    respHeaders = resp.headers;
    body = await resp.text();
  } catch (err) {
    return { ...base, endpoint: url, error: `network: ${String((err as Error).cause ?? err)}` };
  }

  const result: UsageResult = { ...base, status, endpoint: url, raw: body.slice(0, MAX_RAW) };
  if (status !== 200) {
    const error = `${body.slice(0, 300) || `HTTP ${status}`}${diagnose(respHeaders, body)}`;
    noteError(audit, error);
    return { ...result, error };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    noteError(audit, '响应不是 JSON');
    return { ...result, error: '响应不是 JSON' };
  }

  // 套餐名不在额度响应里时再问一次 plan 接口；失败只是少一个字段，不影响额度
  const plan = await fetchPlan(acct, headers);
  const quota = parseQoderQuota(payload, [plan]);

  return {
    ...result,
    ok: true,
    plan: quota.plan || base.plan,
    subscriptionEndsAt: quota.expiresAt ?? base.subscriptionEndsAt,
    userId: quota.userId || base.userId,
    windows: quota.windows,
  };
}

async function fetchPlan(
  acct: Account,
  headers: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  try {
    const resp = await request(`${QODER_OPENAPI_BASE}${QODER_PLAN_PATH}`, {
      headers,
      timeoutMs: 15_000,
      audit: auditOf(acct),
    });
    if (resp.status !== 200) return null;
    return asRecord(await resp.json());
  } catch {
    return null;
  }
}

/* ── 设备码登录 ──────────────────────────────────────────────────────────── */

/**
 * Qoder 的登录不是 OAuth 授权码流程，而是官方 IDE 用的那套设备码：
 * 我们生成 nonce 和 PKCE 挑战，把用户送去网页选账号，然后自己去 openapi 轮询
 * `deviceToken/poll` 把令牌取回来。授权页的 redirect_uri 是 `qoder://` 自定义协议，
 * 本机监听接不住，所以这条链路只能靠服务端轮询收尾——反过来说，用户也不用粘贴任何东西。
 */
const QODER_DEVICE_LOGIN_URL = 'https://qoder.com/device/selectAccounts';
/** 授权页要求的回调地址，必须与官方 IDE 注册的完全一致，否则页面会拒绝。 */
export const QODER_DEVICE_REDIRECT_URI = 'qoder://aicoding.aicoding-agent/login-success';
const QODER_DEVICE_POLL_PATH = '/api/v1/deviceToken/poll';
const QODER_USERINFO_PATH = '/api/v1/userinfo';
const QODER_USER_STATUS_PATH = '/api/v3/user/status';
const QODER_CHALLENGE_METHOD = 'S256';

/** 授权页链接。machineId 缺失时照发，只是登录记录里会少一条设备信息。 */
export function buildQoderLoginUrl(nonce: string, challenge: string, machineId = ''): string {
  const url = new URL(QODER_DEVICE_LOGIN_URL);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('challenge', challenge);
  url.searchParams.set('challenge_method', QODER_CHALLENGE_METHOD);
  url.searchParams.set('redirect_uri', QODER_DEVICE_REDIRECT_URI);
  if (machineId) url.searchParams.set('machine_id', machineId);
  return url.toString();
}

/**
 * 登录链接上带的设备标识：优先用 machine token，没有就退回 IDE 缓存的那个裸 id。
 * 两个都读不到也无所谓，官方链路允许不带。
 */
export async function qoderLoginMachineId(machine: QoderMachine | null): Promise<string> {
  if (machine?.token) return machine.token;
  try {
    const raw = await readFile(
      join(qoderUserDataDir(), 'SharedClientCache', 'cache', 'id'),
      'utf8',
    );
    return raw.trim();
  } catch {
    return '';
  }
}

/** 轮询到的一份令牌。 */
export interface QoderDeviceToken {
  accessToken: string;
  refreshToken: string;
  userId: string;
  /** 毫秒时间戳；上游没给就是 0。 */
  expiresAt: number;
}

/** 上游的到期时间可能是秒、毫秒或 RFC3339 串，三种都收；认不出来当作“没写”。 */
function expiryMs(raw: unknown): number {
  const value = text(raw);
  if (!value) return 0;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return timestampMs(n) ?? 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function getOpenApi(
  path: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = new URL(`${QODER_OPENAPI_BASE}${path}`);
  signal?.throwIfAborted();
  const resp = await request(url.toString(), { headers, timeoutMs: 20_000, signal });
  const body = await resp.text();
  if (resp.status !== 200) {
    throw new Error(`请求 ${path} 失败 HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`请求 ${path} 的响应不是 JSON`);
  }
}

/**
 * 轮询一次设备令牌。
 *
 * 用户还没在网页上点完时上游回 404，这不是错误，返回 null 让调用方接着等；
 * 真正的错误（网络、5xx）才抛出来。这一步不带 Authorization，nonce + verifier 就是凭据。
 */
export async function pollQoderDeviceToken(
  nonce: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<QoderDeviceToken | null> {
  const url = new URL(`${QODER_OPENAPI_BASE}${QODER_DEVICE_POLL_PATH}`);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('verifier', verifier);
  url.searchParams.set('challenge_method', QODER_CHALLENGE_METHOD);

  const resp = await request(url.toString(), {
    headers: { accept: 'application/json' },
    timeoutMs: 20_000,
    signal,
  });
  if (resp.status === 404) return null;
  const body = await resp.text();
  if (resp.status !== 200) {
    throw new Error(`轮询 Qoder 设备令牌失败 HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  let payload: Record<string, unknown> | null;
  try {
    payload = asRecord(JSON.parse(body));
  } catch {
    throw new Error('轮询 Qoder 设备令牌的响应不是 JSON');
  }
  const accessToken = payload ? text(payload.token) : '';
  // 有的部署在授权完成前会回 200 + 空对象，同样按“还没好”处理
  if (!accessToken || !payload) return null;

  return {
    accessToken,
    refreshToken: text(payload.refresh_token) || text(payload.refreshToken),
    userId: text(payload.user_id) || text(payload.userId),
    expiresAt: expiryMs(payload.expires_at ?? payload.expiresAt),
  };
}

/**
 * 检查用户状态是否允许登录。
 *
 * 企业版会按 IP 白名单、席位、应用开关等多个维度挡人，这些都只体现在
 * `whitelistStatus` 上；不看这个字段就会把一个根本用不了的账户存进来，
 * 直到第一次查额度失败才发现。返回空串表示放行。
 */
export function qoderStatusError(status: unknown): string {
  const rec = asRecord(status);
  if (!rec) return 'Qoder 用户状态响应不是对象，无法确认登录身份';
  if (!text(rec.id)) return 'Qoder 用户状态里没有 id，无法确认登录身份';
  switch (text(rec.whitelistStatus)) {
    case 'NoIpPermission':
      return '企业设置了 IP 白名单，当前 IP 无法登录';
    case 'AppDisable':
      return 'Qoder 应用已被停用，无法登录';
    case 'LoginExpire':
      return 'Qoder 登录已失效，请重新发起登录';
    case 'NotAllow':
    case 'NOT_ALLOW':
      return '当前账号暂无 Qoder 使用权限';
    default:
      return '';
  }
}

/**
 * 拿到令牌后补齐这个账户的身份和额度。
 *
 * 只有 user/status 是必须成功的——它同时承担身份确认和准入检查两件事；
 * userinfo / plan / quota 拿不到只是少几个展示字段，不该让一次成功的登录失败。
 * 拼出来的形状与 state.vscdb 里那三段缓存一致，于是可以直接交给 profileOf 解析，
 * 导入和登录两条路进来的账户字段完全相同。
 */
export async function fetchQoderLoginProfile(
  token: QoderDeviceToken,
  machine: QoderMachine | null,
  signal?: AbortSignal,
): Promise<QoderProfile> {
  const headers = qoderHeaders(token.accessToken, machine);

  const userInfo = asRecord(await getOpenApi(QODER_USERINFO_PATH, headers, signal).catch(() => null));
  const status = await getOpenApi(QODER_USER_STATUS_PATH, headers, signal);
  const statusError = qoderStatusError(status);
  if (statusError) throw new Error(statusError);

  const userPlan = asRecord(await getOpenApi(QODER_PLAN_PATH, headers, signal).catch(() => null));
  const creditUsage = asRecord(await getOpenApi(QODER_QUOTA_PATH, headers, signal).catch(() => null));

  const profile = profileOf({
    // status 里的 id / email 比 userinfo 更权威，放在后面覆盖
    userInfo: { ...(userInfo ?? {}), ...(asRecord(status) ?? {}), token: token.accessToken },
    userPlan,
    creditUsage,
  });
  return {
    ...profile,
    userId: profile.userId || token.userId,
    // 到期时间以 poll 给的为准：那是这份令牌自己的，不是缓存里别人的
    expiresAt: token.expiresAt || profile.expiresAt,
  };
}
