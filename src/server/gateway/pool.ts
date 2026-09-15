/**
 * 账号池：决定这一次转发交给哪个账户。
 *
 * 判定分成两层，故意分开写：
 *
 * - **纯函数层**（stateOf / rank）只看数据，不认识时间以外的任何外部世界，因此可以直接测。
 * - **运行时层**（GatewayPool）记住在飞请求数、连续失败和冷却，这些东西没必要落盘：
 *   进程重启后账户本来就该重新试一次，把上一次运行的冷却带过来只会让人以为账户坏了。
 *
 * 失败判定是这里最要紧的一条规矩：**只有账户自己的问题才算它的失败**。429 限流、上游 5xx、
 * 连接断开都是基础设施问题，换个账户重试一样会撞上，把它们记进失败预算，只会在一次网络
 * 抖动之后让整个池子集体进冷却。
 */
import {
  DEFAULT_ACCOUNT_SETTING,
  EMPTY_STAT,
  isForwardable,
  needsPat,
  type GatewayAccountState,
  type GatewayAccountView,
  type GatewayConfig,
} from '../../shared/gateway.js';
import type { Account } from '../creds.js';
import type { AccountState, GatewayAccountRow, Store } from '../store.js';
import type { Provider } from '../../shared/types.js';

export { isForwardable };

/** 一个账户此刻在池子里的运行时状态。 */
export interface Runtime {
  inFlight: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  lastError: string;
  /** 最近一次派活时刻；round-robin 靠它轮转，比库里那份实时。 */
  lastUsedAt: number;
}

export function emptyRuntime(lastUsedAt = 0): Runtime {
  return { inFlight: 0, consecutiveFailures: 0, cooldownUntil: 0, lastError: '', lastUsedAt };
}

export interface PoolEntry {
  account: Account;
  row: GatewayAccountRow;
  runtime: Runtime;
  /** 已用额度百分比，来自额度查询；从没查过时为 null。 */
  usedPercent: number | null;
}

/**
 * 这个账户现在能不能接活，以及为什么不能。
 *
 * usedPercent 为 null（还没查过额度）时按「能接」处理：不能因为用户没点过查额度，
 * 就把一个好账户排除在外；真的用完了，上游会在第一次请求时告诉我们。
 */
export function stateOf(entry: PoolEntry, cfg: GatewayConfig, now: number): GatewayAccountState {
  if (!isForwardable(entry.account.provider) || entry.account.disabled) return 'unusable';
  // Qoder 转发要账户单独设 PAT；没设就没法签名，等于用不了——即便开了开关也不该被派活
  if (needsPat(entry.account.provider) && !entry.row.pat) return 'unusable';
  if (!entry.row.enabled) return 'off';
  if (entry.runtime.cooldownUntil > now) return 'cooling';
  if (entry.usedPercent !== null && entry.usedPercent >= cfg.exhaustedPercent) return 'exhausted';
  return entry.runtime.inFlight > 0 ? 'busy' : 'ready';
}

/** busy 只是「正在忙」，不是「不能接」——同一个账户可以同时服务多条流。 */
export function isAvailable(state: GatewayAccountState): boolean {
  return state === 'ready' || state === 'busy';
}

/**
 * 候选排序。
 *
 * - `fill-first`：优先级高的先用，同优先级里按 id 定序，于是同一个账户会被一直用到耗尽。
 *   这正是参考实现的做法，好处是额度按账户一份份消耗，方便用户看清「现在在烧哪一个」。
 * - `round-robin`：同优先级里最久没被派活的先上，额度在池子里摊平。
 */
export function rank(entries: PoolEntry[], strategy: GatewayConfig['strategy']): PoolEntry[] {
  return [...entries].sort((a, b) => {
    if (a.row.priority !== b.row.priority) return b.row.priority - a.row.priority;
    if (strategy === 'round-robin' && a.runtime.lastUsedAt !== b.runtime.lastUsedAt) {
      return a.runtime.lastUsedAt - b.runtime.lastUsedAt;
    }
    return a.account.id.localeCompare(b.account.id);
  });
}

/** 候选项 → 卡片上那一块。只读，不碰运行时状态。 */
export function viewOf(entry: PoolEntry, cfg: GatewayConfig, now: number): GatewayAccountView {
  return {
    enabled: entry.row.enabled,
    priority: entry.row.priority,
    requests: entry.row.requests,
    failures: entry.row.failures,
    inputTokens: entry.row.inputTokens,
    outputTokens: entry.row.outputTokens,
    lastUsedAt: entry.row.lastUsedAt,
    state: stateOf(entry, cfg, now),
    inFlight: entry.runtime.inFlight,
    cooldownUntil: entry.runtime.cooldownUntil > now ? entry.runtime.cooldownUntil : null,
    lastError: entry.runtime.lastError,
    supported: isForwardable(entry.account.provider),
    needsPat: needsPat(entry.account.provider),
    hasPat: needsPat(entry.account.provider) && entry.row.pat !== '',
  };
}

/** 上游这次的失败，该不该记到这个账户头上。 */
export function blamesAccount(status: number): boolean {
  // 401/403 是这份凭证的问题；400 多半是请求体的问题，但同一个账户连着 400 也确实该歇一歇
  if (status === 401 || status === 403 || status === 402) return true;
  // 429 与 5xx 是限流和上游抖动：换个账户照样撞，记进失败预算会让整池一起进冷却
  return false;
}

export class GatewayPool {
  private runtimes = new Map<string, Runtime>();

  constructor(private readonly store: Store) {}

  private runtimeOf(accountId: string, lastUsedAt: number): Runtime {
    let runtime = this.runtimes.get(accountId);
    if (!runtime) {
      // 进程刚起来时用库里那份 lastUsedAt 接上，否则 round-robin 每次重启都从头轮一遍
      runtime = emptyRuntime(lastUsedAt);
      this.runtimes.set(accountId, runtime);
    }
    return runtime;
  }

  /** 把账户、库里的设置统计和运行时状态拼成候选项。 */
  entries(accounts: readonly Account[], states: Map<string, AccountState>): PoolEntry[] {
    const rows = this.store.gatewayAccounts();
    return accounts.map((account) => {
      const row = rows.get(account.id) ?? { ...DEFAULT_ACCOUNT_SETTING, ...EMPTY_STAT, pat: '', machineId: '' };
      return {
        account,
        row,
        runtime: this.runtimeOf(account.id, row.lastUsedAt),
        usedPercent: states.get(account.id)?.usedPercent ?? null,
      };
    });
  }

  /** 卡片上那一块网关信息。 */
  views(
    accounts: readonly Account[],
    states: Map<string, AccountState>,
    cfg: GatewayConfig,
    now = Date.now(),
  ): Map<string, GatewayAccountView> {
    return new Map(
      this.entries(accounts, states).map((entry) => [entry.account.id, viewOf(entry, cfg, now)]),
    );
  }

  /**
   * 单个账户的那一块。
   *
   * 快照那条路上已经逐个账户取过状态了，再走一遍 entries() 等于把整张表重查一次；
   * 卡片列表每次刷新都要走这条路，所以单独留一个入口。
   */
  viewOf(account: Account, usedPercent: number | null, cfg: GatewayConfig, now = Date.now()): GatewayAccountView {
    const row = this.store.gatewayAccount(account.id) ?? { ...DEFAULT_ACCOUNT_SETTING, ...EMPTY_STAT, pat: '', machineId: '' };
    return viewOf({ account, row, runtime: this.runtimeOf(account.id, row.lastUsedAt), usedPercent }, cfg, now);
  }

  /**
   * 选下一个来接活的账户。
   *
   * `exclude` 是这一次请求里已经试过的账户：同一条请求不会重复派给同一个账户，
   * 否则「最多重试三次」会在同一个坏账户上原地打三转。
   */
  pick(
    accounts: readonly Account[],
    states: Map<string, AccountState>,
    cfg: GatewayConfig,
    provider: Provider,
    exclude: ReadonlySet<string>,
    now = Date.now(),
  ): Account | null {
    const candidates = this.entries(accounts, states).filter(
      (entry) =>
        entry.account.provider === provider &&
        !exclude.has(entry.account.id) &&
        isAvailable(stateOf(entry, cfg, now)),
    );
    return rank(candidates, cfg.strategy)[0]?.account ?? null;
  }

  /** 派活：只动在飞计数，成败由后面两个方法记。 */
  begin(accountId: string, now = Date.now()): void {
    const runtime = this.runtimeOf(accountId, 0);
    runtime.inFlight += 1;
    runtime.lastUsedAt = now;
  }

  succeed(accountId: string, inputTokens: number, outputTokens: number): void {
    const runtime = this.runtimeOf(accountId, 0);
    runtime.inFlight = Math.max(0, runtime.inFlight - 1);
    runtime.consecutiveFailures = 0;
    runtime.cooldownUntil = 0;
    runtime.lastError = '';
    this.store.recordGatewayUse(accountId, true, inputTokens, outputTokens, runtime.lastUsedAt);
  }

  /**
   * 记一次失败。
   *
   * `blame` 为 false 时只把错误留给界面看，不计入失败预算、也不进冷却——限流和上游抖动
   * 不是这个账户的错。
   */
  fail(accountId: string, error: string, blame: boolean, cfg: GatewayConfig, now = Date.now()): void {
    const runtime = this.runtimeOf(accountId, 0);
    runtime.inFlight = Math.max(0, runtime.inFlight - 1);
    runtime.lastError = error;
    if (blame) {
      runtime.consecutiveFailures += 1;
      if (runtime.consecutiveFailures >= cfg.maxConsecutiveFailures) {
        runtime.cooldownUntil = now + cfg.cooldownSeconds * 1000;
      }
    }
    this.store.recordGatewayUse(accountId, false, 0, 0, runtime.lastUsedAt);
  }

  /** 用户在界面上让它重新归队：清掉冷却和失败计数。 */
  reset(accountId: string): void {
    const runtime = this.runtimeOf(accountId, 0);
    runtime.consecutiveFailures = 0;
    runtime.cooldownUntil = 0;
    runtime.lastError = '';
  }
}
