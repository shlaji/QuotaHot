/**
 * 把上游限额信息归一化成 Window 对象。
 *
 * 字段名按前缀正则匹配，而不是写死完整名字，因此上游即使改后缀也不至于立刻解析失败。
 * 如果完全读不出窗口，调用方应停止该账户的自动调度，而不是猜测下一次发送时间。
 */
import type { Window } from '../shared/types.js';

// Anthropic：Anthropic-Ratelimit-Unified-{5h,7d,7d_oi}-Reset / -Status
const ANTHROPIC_RE = /^anthropic-ratelimit-unified(?:-([a-z0-9_]+))?-reset$/i;
// Codex：x-codex-{primary,secondary}-reset-after-seconds / -used-percent / -window-minutes
const CODEX_RE = /^x-codex-(primary|secondary)-([a-z-]+)$/i;

/** 限额响应头可能给 unix 秒、相对秒数或 RFC3339；三种都接受，统一返回毫秒。 */
export function toEpochMs(value: string, nowMs: number): number | null {
  const v = (value ?? '').trim();
  if (!v) return null;

  const n = Number(v);
  if (Number.isFinite(n)) {
    // 大于十亿时视为绝对 unix 时间戳，否则按相对偏移秒处理
    return n > 1_000_000_000 ? n * 1000 : nowMs + n * 1000;
  }

  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? null : parsed;
}

function toNumber(value: unknown): number | null {
  const n = Number(String(value ?? '').trim());
  return Number.isFinite(n) ? n : null;
}

export function isFiveHour(w: Window): boolean {
  if (w.windowMinutes !== null) return w.windowMinutes >= 240 && w.windowMinutes <= 360;
  return w.name === '5h' || w.name === 'primary';
}

function blank(name: string): Window {
  return { name, resetAt: 0, usedPercent: null, windowMinutes: null, source: '' };
}

/**
 * 任何长得像 header 的对象：undici 的 Headers、全局 Headers，或普通对象都可以。
 * 这里故意采用鸭子类型；若写成 `instanceof Headers`，面对 undici 自己的 Headers 类会判 false，
 * 从而悄悄什么都解析不到。
 */
export type HeaderLike = Iterable<[string, string]> | Record<string, string>;

function isIterable(h: HeaderLike): h is Iterable<[string, string]> {
  return typeof (h as Iterable<[string, string]>)[Symbol.iterator] === 'function';
}

/** 从 Headers-like 对象或普通记录对象里读取单个 header。 */
function getHeader(headers: HeaderLike, name: string): string | null {
  const get = (headers as { get?: (k: string) => string | null }).get;
  if (typeof get === 'function') return get.call(headers, name);
  const record = headers as Record<string, string>;
  const hit = Object.keys(record).find((k) => k.toLowerCase() === name);
  return hit ? record[hit] : null;
}

export function parseHeaders(headers: HeaderLike, nowMs: number): Window[] {
  const entries: [string, string][] = isIterable(headers)
    ? [...headers]
    : Object.entries(headers);
  const out = new Map<string, Window>();

  for (const [rawKey, rawVal] of entries) {
    const key = rawKey.toLowerCase();

    const am = ANTHROPIC_RE.exec(key);
    if (am) {
      const reset = toEpochMs(rawVal, nowMs);
      if (reset === null) continue;
      const name = (am[1] ?? 'unified').toLowerCase();
      const w = out.get(name) ?? blank(name);
      w.resetAt = reset;
      w.source = `header:${key}`;
      if (name === '5h') w.windowMinutes = 300;
      else if (name.startsWith('7d')) w.windowMinutes = 10080;
      out.set(name, w);
      continue;
    }

    const cm = CODEX_RE.exec(key);
    if (cm) {
      const name = cm[1].toLowerCase();
      const field = cm[2].toLowerCase();
      const w = out.get(name) ?? blank(name);
      if (field.includes('reset')) {
        const reset = toEpochMs(rawVal, nowMs);
        if (reset !== null) {
          w.resetAt = reset;
          w.source = `header:${key}`;
        }
      } else if (field.includes('used')) {
        w.usedPercent = toNumber(rawVal);
      } else if (field.includes('window')) {
        w.windowMinutes = toNumber(rawVal);
      }
      out.set(name, w);
    }
  }

  return [...out.values()].filter((w) => w.resetAt > 0);
}

/** 深度优先查找第一个命中的 `target` 键（SSE 事件嵌套层级并不固定）。 */
export function findKey(node: unknown, target: string, depth = 0): unknown {
  if (depth > 6 || node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const v of node) {
      const found = findKey(v, target, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const obj = node as Record<string, unknown>;
  if (target in obj) return obj[target];
  for (const v of Object.values(obj)) {
    const found = findKey(v, target, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * 从 Codex SSE 事件里的 `rate_limits` 对象读取窗口，结构类似：
 * { rate_limits: { primary: { used_percent, window_minutes, resets_in_seconds }, ... } }
 */
export function parseBody(payload: unknown, nowMs: number): Window[] {
  const limits = findKey(payload, 'rate_limits');
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) return [];

  const out: Window[] = [];
  for (const [name, node] of Object.entries(limits as Record<string, unknown>)) {
    if (node === null || typeof node !== 'object') continue;
    const rec = node as Record<string, unknown>;
    let resetAt: number | null = null;
    for (const k of ['resets_in_seconds', 'reset_after_seconds', 'resets_at', 'reset_at']) {
      if (k in rec) {
        resetAt = toEpochMs(String(rec[k]), nowMs);
        break;
      }
    }
    if (resetAt === null) continue;
    out.push({
      name: name.toLowerCase(),
      resetAt,
      usedPercent: toNumber(rec.used_percent),
      windowMinutes: toNumber(rec.window_minutes),
      source: 'body:rate_limits',
    });
  }
  return out;
}

/** 当响应是 429 时，作为最后兜底来源的解析逻辑。 */
export function parseRetryAfter(headers: HeaderLike, nowMs: number): number | null {
  for (const key of ['retry-after', 'x-ratelimit-reset-requests', 'x-should-retry-after']) {
    const v = getHeader(headers, key);
    if (v) {
      const ts = toEpochMs(v, nowMs);
      if (ts !== null) return ts;
    }
  }
  return null;
}

/** 按窗口名合并多个来源，先到先赢；调用方应把更可信的来源排在前面。 */
export function merge(...groups: Window[][]): Window[] {
  const out = new Map<string, Window>();
  for (const group of groups) {
    for (const w of group) if (!out.has(w.name)) out.set(w.name, w);
  }
  return [...out.values()];
}

/**
 * 还没到点的那些重置时刻里最早的一个。
 *
 * 发送失败之后要靠它回答一个问题：这是接口坏了，还是额度压根还没重置？
 * 只要 5 小时或周窗口里还有一个没到点，上游拒绝这一发就是完全正常的，
 * 该做的是等到那一刻，而不是把账户当成故障停掉。
 */
export function nextReset(windows: readonly Window[], nowMs: number): Window | null {
  const pending = windows.filter((w) => w.resetAt > nowMs);
  if (pending.length === 0) return null;
  return pending.reduce((a, b) => (a.resetAt <= b.resetAt ? a : b));
}

/**
 * 用到这个比例就认为这个窗口是满的。
 *
 * 不写死 100 是因为上游报的百分比会被四舍五入，而且撞限之后还可能小幅回落；
 * 差几个点的窗口本来也发不出什么东西。
 */
export const EXHAUSTED_PERCENT = 99;

export function isExhausted(w: Window): boolean {
  return (w.usedPercent ?? 0) >= EXHAUSTED_PERCENT;
}

/**
 * 窗口刚开就去查，剩余时间和整窗长度之间只差一个往返；这点容差用来吸收它，
 * 以及上游把秒数取整留下的零头。
 */
const WINDOW_START_SLACK_MS = 60_000;

/**
 * 这个窗口是不是已经开始计时。
 *
 * 滚动窗口由第一发请求打开。在那之前，上游报的「重置时刻」并不是一道真实的门槛，而是
 * 「从你问的这一刻起，再过一整个窗口」——codex 用量为 0 时就是如此，reset_after_seconds
 * 恒等于 window_minutes，每查一次就往后挪一次。拿这种时刻排下一拍，下一拍会被推得和时间
 * 流逝一样快，永远到不了点：账户就此一整天发不出一条，而日志里看着一切正常。
 *
 * 两条判据满足其一就算在计时：窗口里已经有消耗；或者剩余时间明显短于整窗长度，说明它是
 * 过去某一刻开的。读不出窗口长度时无从比对，按「在计时」处理——多等一会儿，好过把一道真实
 * 的门槛当成不存在，然后一头撞上去。
 *
 * `observedAt` 是这份窗口数据从上游读回来的时刻，不是此刻：库里那份可能已经放了半小时，
 * 拿此刻去比，一个从没开过的窗口会被算成「开了半小时」。
 *
 * 只能用在只读额度查询读回来的窗口上。发送响应里的窗口是这一发刚刚打开的，剩余时间同样
 * 贴着整窗长度，用这里的判据会把它错判成没在计时。
 */
export function hasStarted(w: Window, observedAt: number): boolean {
  if ((w.usedPercent ?? 0) > 0) return true;
  if (w.windowMinutes === null || w.windowMinutes <= 0) return true;
  return w.resetAt - observedAt < w.windowMinutes * 60_000 - WINDOW_START_SLACK_MS;
}

/**
 * 这个窗口是不是管着所有模型。
 *
 * 上游在 5 小时和 7 天两个总窗口之外，还会另报两类子窗口：模型专属的
 * （seven_day_opus / seven_day_sonnet，响应头里是 7d_opus 这样的后缀），以及计费口径的
 * 超额窗口（seven_day_overage_included，头里叫 7d_oi——认得出它是因为同一个节点上挂着
 * limit_dollars / used_dollars / remaining_dollars，那是钱，不是能不能发）。
 *
 * 这两类用满都不代表这一发发不出去：保活只发配置里那一个模型。拿另一个模型的额度、
 * 或者拿钱的额度去挡它，账户会一直等到那个窗口重置——周窗口就是好几天，而这期间
 * 每一发其实都能成功。
 */
export function isGlobalWindow(w: Window): boolean {
  const name = w.name.toLowerCase();
  return !/_(opus|sonnet)$/.test(name) && !name.includes('overage') && !/_oi$/.test(name);
}

/**
 * 还没到点、时刻本身也可信、而且管得着所有模型的那些窗口。
 *
 * 筛完一个不剩时退回没筛的那份：多等一会儿是小事，交白卷却会被调用方当成
 * 「读不出窗口」，那是直接停掉账户——保活断在这里，得等人来手动重启。
 */
function pendingOf(windows: readonly Window[], nowMs: number): Window[] {
  const pending = windows.filter((w) => Number.isFinite(w.resetAt) && w.resetAt > nowMs);
  const global = pending.filter(isGlobalWindow);
  return global.length > 0 ? global : pending;
}

/**
 * 此刻挡着下一发的窗口：用满且还没重置的那些里，重置最晚的一个。
 *
 * 取最晚而不是最早，是因为它们是「与」的关系——周额度用满时，5 小时窗口再怎么早重置，
 * 发出去也一样会被顶回来。都没用满时返回 null，表示这一发被拒不是额度的问题。
 */
export function blockingWindow(windows: readonly Window[], nowMs: number): Window | null {
  const blocked = pendingOf(windows, nowMs).filter(isExhausted);
  if (blocked.length === 0) return null;
  return blocked.reduce((a, b) => (a.resetAt >= b.resetAt ? a : b));
}

/**
 * 下一发要等到哪个窗口重置。
 *
 * 这是排下一拍唯一的依据。先只留管得着所有模型的窗口（见 pendingOf / isGlobalWindow），
 * 再按三条规则依次看：
 * 1. 有窗口用满，就等它们全部重置——最晚的那个才是真正的门槛（见 blockingWindow）。
 * 2. 都没用满，就等 5 小时窗口关闭：它还开着的时候再发一条也开不出新窗口，纯属白发。
 * 3. 连 5 小时窗口都读不到，退回最早重置的那个。宁可多等一会儿，也好过按一个猜出来的
 *    节奏反复去撞上游。
 *
 * 返回 null 表示一个未到点的窗口都没有，调用方应当据此判断「读不出窗口」，而不是猜时间。
 */
export function nextSendWindow(windows: readonly Window[], nowMs: number): Window | null {
  const pending = pendingOf(windows, nowMs);
  if (pending.length === 0) return null;

  const blocked = blockingWindow(pending, nowMs);
  if (blocked !== null) return blocked;

  const fiveHour = pending.filter(isFiveHour);
  const candidates = fiveHour.length > 0 ? fiveHour : pending;
  return candidates.reduce((a, b) => (a.resetAt <= b.resetAt ? a : b));
}
