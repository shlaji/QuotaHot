/**
 * 只读额度查询。
 *
 * 与 providers.send 不同，这里完全不会调用模型：两家上游都暴露了各自 CLI
 * 读取的额度计数接口，分别对应 Claude Code 的 /usage 和 codex 的 /status。
 * 查询本身不消耗 token，更关键的是不会打开 5 小时窗口，这正是它和 providers.send 的区别。
 *
 * 这些地址都是从官方 CLI 中提取出来的未版本化内部接口（Claude Code 2.1.x、codex 0.144.x）。
 * 因此解析器把所有字段都视为可选，接受多种响应形状，并把原始响应体回传给 UI。
 * 即使上游改字段名，也只会导致某些数字缺失，不会直接抛异常；原始响应会告诉我们该修哪儿。
 */
import { noteError, request, type Audit, type HttpResponse } from './http.js';
import { CLAUDE_OAUTH_BETA, claudeOAuthHeaders, codexWebHeaders, diagnose } from './headers.js';
import * as rl from './ratelimit.js';
import { auditOf, type Account } from './creds.js';
import { queryQoderUsage } from './qoder.js';
import type { Provider, UsageResult, Window } from '../shared/types.js';

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** 官方身份接口：套餐来自组织类型，比从 JWT 声明里猜更权威。 */
const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
/** ChatGPT 主动重置次数的明细接口；wham/usage 只给一个总数，这里能拿到每张的过期时间。 */
const CODEX_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
/**
 * 按顺序尝试，直到某个地址返回“不只是没路由到这里”的结果。
 * codex 客户端会从同一个基址下尝试 `/wham/...` 和 `/api/codex/...` 两套前缀；
 * 哪一套实际可用在不同版本之间变过，目前存活的是 wham。对于 chatgpt.com 来说，
 * 某些未路由路径返回的是 HTML 403 而不是 404，因此这里也把它视为“打空”——见 fetchUsage。
 */
const CODEX_USAGE_URLS = [
  'https://chatgpt.com/backend-api/wham/usage',
  'https://chatgpt.com/backend-api/api/codex/usage',
];

const MAX_RAW = 4000;

/** Claude 侧窗口名使用 five_hour / seven_day / seven_day_opus / seven_day_sonnet。 */
const CLAUDE_WINDOW_MINUTES: Record<string, number> = {
  five_hour: 300,
  seven_day: 10080,
  seven_day_opus: 10080,
  seven_day_sonnet: 10080,
  seven_day_overage_included: 10080,
};

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 读取已用百分比，兼容两家上游历史上出现过的各类字段名。 */
function usedPercentOf(rec: Record<string, unknown>): number | null {
  for (const k of ['used_percent', 'used_percentage', 'utilization', 'percent']) {
    const n = toNumber(rec[k]);
    if (n !== null) return n;
  }
  return null;
}

/**
 * 解析 `{ five_hour: { utilization, resets_at }, seven_day: {...}, ... }` 这类结构。
 *
 * 这些窗口早先包在 `rate_limits` 里，后来直接摊在响应根上，两种都要认。
 * 摊平之后根上混着 `spend`、`member_dashboard_available` 这些非窗口字段，
 * 但它们要么不是对象、要么没有 `resets_at`，会被下面的循环自然滤掉，
 * 因此不必再维护一份窗口名白名单——上游新增窗口时也就不用跟着改代码。
 */
export function parseClaudeUsage(payload: unknown, nowMs: number): Window[] {
  const wrapped = rl.findKey(payload, 'rate_limits');
  const limits =
    wrapped !== null && typeof wrapped === 'object' && !Array.isArray(wrapped) ? wrapped : payload;
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) return [];

  const out: Window[] = [];
  for (const [key, node] of Object.entries(limits as Record<string, unknown>)) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) continue;
    const rec = node as Record<string, unknown>;
    const resetAt = rl.toEpochMs(String(rec.resets_at ?? rec.reset_at ?? ''), nowMs);
    if (resetAt === null) continue;
    out.push({
      // isFiveHour 识别的是 '5h'，而响应头里对 5 小时窗口也是这么叫的
      name: key === 'five_hour' ? '5h' : key,
      resetAt,
      usedPercent: usedPercentOf(rec),
      windowMinutes: CLAUDE_WINDOW_MINUTES[key] ?? null,
      source: `usage:${key}`,
    });
  }
  return out;
}

/**
 * Codex 目前出现过两种结构：
 * 一种是流式形态 `{ rate_limits: { primary: { used_percent, window_minutes, resets_in_seconds } } }`，
 * 另一种是快照形态 `{ rate_limit: { primary_window: { limit_window_seconds, reset_after_seconds } } }`。
 * 先尝试第一种，失败后再退回第二种。
 */
export function parseCodexUsage(payload: unknown, nowMs: number): Window[] {
  const streaming = rl.parseBody(payload, nowMs);
  if (streaming.length > 0) return streaming;

  const out: Window[] = [];
  for (const key of ['primary_window', 'secondary_window'] as const) {
    const node = rl.findKey(payload, key);
    if (node === null || typeof node !== 'object' || Array.isArray(node)) continue;
    const rec = node as Record<string, unknown>;
    let resetAt: number | null = null;
    for (const k of ['reset_after_seconds', 'resets_in_seconds', 'resets_at', 'reset_at']) {
      if (k in rec) {
        resetAt = rl.toEpochMs(String(rec[k]), nowMs);
        if (resetAt !== null) break;
      }
    }
    if (resetAt === null) continue;
    const seconds = toNumber(rec.limit_window_seconds);
    out.push({
      name: key === 'primary_window' ? 'primary' : 'secondary',
      resetAt,
      usedPercent: usedPercentOf(rec),
      windowMinutes: seconds === null ? toNumber(rec.window_minutes) : Math.round(seconds / 60),
      source: `usage:${key}`,
    });
  }
  return out;
}

/** 套餐名称；无论上游这版把它放在哪个字段里，都尽量找出来。 */
function planOf(payload: unknown): string {
  for (const k of ['subscription_type', 'plan_type', 'plan']) {
    const v = rl.findKey(payload, k);
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/** 付费周期结束时间；如果响应中有提到就解析出来。 */
function subscriptionEndOf(payload: unknown, nowMs: number): number | null {
  for (const k of [
    'subscription_active_until',
    'subscription_expires_at',
    'subscription_end',
    'current_period_end',
  ]) {
    const v = rl.findKey(payload, k);
    if (v === undefined || v === null || v === '') continue;
    const ts = rl.toEpochMs(String(v), nowMs);
    if (ts !== null) return ts;
  }
  return null;
}

/**
 * ChatGPT 每个周期会发放少量“立即重置用量”的次数，并报告剩余值；Claude 没有等价概念。
 */
function resetCreditsOf(payload: unknown): number | null {
  const node = rl.findKey(payload, 'rate_limit_reset_credits');
  if (node === null || typeof node !== 'object') return null;
  const rec = node as Record<string, unknown>;
  return toNumber(rec.available_count ?? rec.applicable_available_count);
}

/** Codex 服务端的最终准入判断；冲突时宁可视为不可用，也不要切过去再撞一次限额。 */
function codexQuotaAvailable(payload: unknown): boolean | null {
  const node = rl.findKey(payload, 'rate_limit');
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return null;
  const rec = node as Record<string, unknown>;
  if (rec.allowed === false || rec.limit_reached === true) return false;
  if (rec.allowed === true || rec.limit_reached === false) return true;
  return null;
}

/**
 * Claude 官方 oauth/profile 的解析结果。
 * 组织类型只有四个枚举；出现其他取值时宁可留空，也不要把内部代号当套餐名显示出去。
 */
export interface ProfileSummary {
  orgType: string;
  plan: string;
  email: string;
  userId: string;
}

const CLAUDE_ORG_PLANS: Record<string, string> = {
  claude_max: 'Max',
  claude_pro: 'Pro',
  claude_enterprise: 'Enterprise',
  claude_team: 'Team',
};

export function parseProfile(payload: unknown): ProfileSummary {
  const orgType = rl.findKey(payload, 'organization_type');
  const type = typeof orgType === 'string' ? orgType : '';
  const email = rl.findKey(payload, 'email_address') ?? rl.findKey(payload, 'email');
  const uuid = rl.findKey(payload, 'uuid');
  return {
    orgType: type,
    plan: CLAUDE_ORG_PLANS[type] ?? '',
    email: typeof email === 'string' ? email : '',
    userId: typeof uuid === 'string' ? uuid : '',
  };
}

/** 主动重置次数的明细：剩余张数，以及其中最早过期的那一张。 */
export interface ResetCreditsSummary {
  availableCount: number | null;
  nextExpiresAt: number | null;
}

/** 已经用掉或已过期的额度不该再计入剩余张数。 */
function isCreditAvailable(rec: Record<string, unknown>): boolean {
  const status = String(rec.status ?? rec.state ?? 'available').trim().toLowerCase();
  return !['redeemed', 'used', 'consumed', 'expired'].includes(status);
}

/**
 * 明细接口可能把内容包在 data 里，也可能直接放在顶层；两种都接受。
 * available_count 缺失时按明细自己数一遍，这样即使上游只返回数组也仍有可用数字。
 */
export function parseResetCredits(payload: unknown, nowMs: number): ResetCreditsSummary {
  const list = rl.findKey(payload, 'credits');
  const credits = Array.isArray(list)
    ? (list.filter((x) => x !== null && typeof x === 'object') as Record<string, unknown>[])
    : [];
  const available = credits.filter(isCreditAvailable);

  const reported = toNumber(rl.findKey(payload, 'available_count'));
  const expiries = available
    .map((rec) => {
      const raw = rec.expires_at ?? rec.expire_at ?? rec.expiresAt;
      return raw === undefined || raw === null || raw === '' ? null : rl.toEpochMs(String(raw), nowMs);
    })
    .filter((ts): ts is number => ts !== null);

  return {
    availableCount: reported ?? (credits.length > 0 ? available.length : null),
    nextExpiresAt: expiries.length > 0 ? Math.min(...expiries) : null,
  };
}

/** 单个账户在额度响应体中给出的全部信息，不含响应头。 */
export interface UsageSummary {
  plan: string;
  subscriptionEndsAt: number | null;
  userId: string;
  resetCredits: number | null;
  quotaAvailable: boolean | null;
  windows: Window[];
}

/**
 * 对额度响应体的完整解析逻辑，保持纯函数形式，方便脱离网络用两家真实响应做校验。
 */
export function summarize(provider: Provider, payload: unknown, nowMs: number): UsageSummary {
  const userId = rl.findKey(payload, 'user_id');
  return {
    plan: planOf(payload),
    subscriptionEndsAt: subscriptionEndOf(payload, nowMs),
    userId: typeof userId === 'string' ? userId : '',
    resetCredits: resetCreditsOf(payload),
    quotaAvailable: provider === 'codex' ? codexQuotaAvailable(payload) : null,
    windows:
      provider === 'claude' ? parseClaudeUsage(payload, nowMs) : parseCodexUsage(payload, nowMs),
  };
}

/**
 * 这类状态码表示“地址不对”，而不是“这个账户真的返回了业务结果”。
 * 404 最明显；chatgpt.com 的边缘节点对某些未路由的 backend-api 路径会返回 HTML 403，
 * 而 405 则表示路径存在但 HTTP 方法不对。三者都值得换地址再试；401 和 429 则不是，
 * 它们是关于当前账户的真实响应。
 */
function isMiss(status: number, body: string): boolean {
  if (status === 404 || status === 405) return true;
  // 只有 HTML 403 才说明是边缘节点拦截；JSON 403 则是上游真的在回答这个账户
  return status === 403 && /^\s*</.test(body);
}

async function fetchUsage(
  urls: string[],
  headers: Record<string, string>,
  audit: Audit,
  transport: 'undici' | 'fetch',
): Promise<{ resp: HttpResponse; url: string; body: string; audit: Audit } | { error: string }> {
  let last = '';
  let fallback: { resp: HttpResponse; url: string; body: string; audit: Audit } | null = null;

  for (const url of urls) {
    // 每个候选地址各记一条：哪些前缀被打空了，日志里要看得见
    const one: Audit = { ...audit };
    let resp: HttpResponse;
    try {
      resp = await request(url, { headers, timeoutMs: 30_000, audit: one, transport });
    } catch (err) {
      last = `network: ${String((err as Error).cause ?? err)}`;
      continue;
    }
    const body = await resp.text();
    if (isMiss(resp.status, body)) {
      last = `HTTP ${resp.status} @ ${url}`;
      noteError(one, `换下一个地址：HTTP ${resp.status}`);
      // 保留第一个“打空”结果：如果所有候选地址都打空，展示一份真实响应比只给一句错误更有价值
      fallback ??= { resp, url, body, audit: one };
      continue;
    }
    return { resp, url, body, audit: one };
  }
  return fallback ?? { error: last || '没有可用的额度查询地址' };
}

/** 按 provider 组装额度查询要用的请求头。 */
function usageHeaders(acct: Account): Record<string, string> {
  return acct.provider === 'claude'
    ? claudeOAuthHeaders(acct.accessToken, CLAUDE_OAUTH_BETA)
    : codexWebHeaders(acct.accessToken, acct.accountId);
}

/**
 * 附加查询：Claude 走官方 oauth/profile，Codex 走重置次数明细。
 * 两者都是锦上添花——失败时主查询结果照常返回，只是少几个字段，因此这里吞掉所有错误。
 */
async function fetchProfile(acct: Account): Promise<ProfileSummary | null> {
  try {
    const resp = await request(CLAUDE_PROFILE_URL, {
      headers: claudeOAuthHeaders(acct.accessToken),
      timeoutMs: 15_000,
      audit: auditOf(acct),
    });
    if (resp.status !== 200) return null;
    return parseProfile(await resp.json());
  } catch {
    return null;
  }
}

async function fetchResetCredits(
  acct: Account,
  nowMs: number,
  transport: UsageTransport,
): Promise<ResetCreditsSummary | null> {
  try {
    const resp = await request(CODEX_RESET_CREDITS_URL, {
      headers: codexWebHeaders(acct.accessToken, acct.accountId),
      timeoutMs: 15_000,
      audit: auditOf(acct),
      transport,
    });
    if (resp.status !== 200) return null;
    return parseResetCredits(await resp.json(), nowMs);
  } catch {
    return null;
  }
}

/** 查询的调用方式；发送之后那一次和界面上的“查询额度”想要的东西不一样。 */
export interface UsageOptions {
  /**
   * 只要限额窗口，不要附加信息。
   *
   * 发送之后那次查询只是为了知道刚打开的窗口什么时候重置，套餐名和重置次数都用不上；
   * 而 profile / reset-credits 是打给**同一台主机**的又一次请求，正好落在同一个限流
   * 计数器上。少问一次，就少一次把自己撞上 429 的机会。
   */
  windowsOnly?: boolean;
  usageTransport?: UsageTransport;
}

export type UsageTransport = 'undici' | 'fetch';

export async function queryUsage(acct: Account, opts: UsageOptions = {}): Promise<UsageResult> {
  // Qoder 的额度接口、请求头、响应形状都自成一套，整条链路都在 qoder.ts 里
  if (acct.provider === 'qoder') return queryQoderUsage(acct);

  const base: UsageResult = {
    accountId: acct.id,
    provider: acct.provider,
    email: acct.email,
    ok: false,
    status: 0,
    error: '',
    // token 自带声明是最低保底；即使查询失败，这些字段仍然可用
    plan: acct.plan,
    subscriptionEndsAt: acct.subscriptionEndsAt || null,
    userId: acct.userId,
    resetCredits: null,
    resetCreditsExpiresAt: null,
    orgType: '',
    quotaAvailable: null,
    windows: [],
    endpoint: '',
    raw: '',
  };

  const urls = acct.provider === 'claude' ? [CLAUDE_USAGE_URL] : CODEX_USAGE_URLS;
  // 普通查询走配置的代理；只有 OpenCode 调用方显式选择 fetch。
  const transport = opts.usageTransport ?? 'undici';
  const got = await fetchUsage(urls, usageHeaders(acct), auditOf(acct), transport);
  if ('error' in got) return { ...base, error: got.error };

  const { resp, url, body, audit } = got;
  const now = Date.now();
  const result: UsageResult = { ...base, status: resp.status, endpoint: url, raw: body.slice(0, MAX_RAW) };

  if (resp.status !== 200) {
    const error = `${body.slice(0, 300) || `HTTP ${resp.status}`}${diagnose(resp.headers, body)}`;
    noteError(audit, error);
    // 429 说的是“这个接口现在不想被问”，与账户额度无关；带回重试时刻，调用方才知道该等多久
    const retryAfterAt = resp.status === 429 ? rl.parseRetryAfter(resp.headers, now) : null;
    return { ...result, error, retryAfterAt };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    noteError(audit, '响应不是 JSON');
    return { ...result, error: '响应不是 JSON' };
  }

  const summary = summarize(acct.provider, payload, now);
  // 响应头里可能带有同样的计数信息，而且读取成本低，因此一起合并
  const windows = rl.merge(summary.windows, rl.parseHeaders(resp.headers, now));

  const extras = opts.windowsOnly !== true;
  const profile = extras && acct.provider === 'claude' ? await fetchProfile(acct) : null;
  const credits = extras && acct.provider === 'codex'
    ? await fetchResetCredits(acct, now, transport)
    : null;

  return {
    ...result,
    ok: true,
    // 官方 profile 最权威，其次是额度响应体，最后才退回 token 自带声明
    plan: profile?.plan || summary.plan || base.plan,
    orgType: profile?.orgType ?? '',
    subscriptionEndsAt: summary.subscriptionEndsAt ?? base.subscriptionEndsAt,
    userId: profile?.userId || summary.userId || base.userId,
    // 明细接口给出的张数比 usage 里的汇总更细，拿到就优先用它
    resetCredits: credits?.availableCount ?? summary.resetCredits,
    resetCreditsExpiresAt: credits?.nextExpiresAt ?? null,
    quotaAvailable: summary.quotaAvailable,
    windows,
  };
}
