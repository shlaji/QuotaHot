/**
 * 调度核心。
 *
 * 每个账户各自跑一条独立循环，因为 5 小时窗口是按账户分别计时的滚动窗口：
 *   等待每日窗口打开 -> 发送 -> 读取 resetAt -> 睡到 resetAt+buffer+jitter -> 再发 -> ...
 *
 * 每日窗口表示“每天重复的某个时段”，因此循环本身不会真正结束：
 * 如果某一拍落在窗口外，就顺延到下一次开窗。
 *
 * 实现受三个硬约束影响：
 * 1. 所有等待都基于绝对时间戳，并切成短分片。单个超长 setTimeout 在电脑休眠或
 *    NTP 校时后会明显漂移，而分片重算不会。
 * 2. 每次发送后立刻持久化 nextDue，因此进程被杀后恢复时会沿用原有节奏，
 *    而不是重新打开一个新窗口。
 * 3. 下一拍排出来之后不是就此定死：等待期间会定期回头核对额度，窗口变了就改期，
 *    见 waitForDue。周额度是滚动窗口，它放出额度的时刻谁也算不准。
 */
import { ACCOUNTS_DIR } from './config.js';
import { loadAccounts, ensureFresh, type Account } from './creds.js';
import { syncTargetsOf } from './clientsync.js';
import { send } from './providers.js';
import { blockingWindow, hasStarted, isExhausted, isFiveHour, nextSendWindow } from './ratelimit.js';
import { queryUsage } from './usage.js';
import { setProxy, getProxy } from './http.js';
import {
  formatDailyTime,
  isWithinDailyWindow,
  nextWindowClose,
  nextWindowOpen,
  parseDailyTime,
} from '../shared/schedule.js';
import { Store } from './store.js';
import * as bus from './bus.js';
import type {
  AccountView,
  AppConfig,
  SchedulerStatus,
  SendNowResult,
  Window,
} from '../shared/types.js';

/** 等待分片的粒度。 */
const TICK_MS = 30_000;
/** 单个分片如果超出预期这么多，就认为系统时钟发生了跳变。 */
const CLOCK_JUMP_MS = 300_000;
/**
 * 等令牌就绪时两次重试之间最长隔多久。
 *
 * 跟随客户端的账户要等它自己续期，那取决于用户什么时候再打开一次 Claude Code，我们无从预知，
 * 所以间隔逐次拉长；但拉得再长也要封顶，否则续期完还得再空等几个小时才发得出下一拍。
 */
const TOKEN_WAIT_MAX_MS = 30 * 60_000;
/** 关掉后台额度刷新时，等待期间自己回头核对的间隔。 */
const RECHECK_FALLBACK_MINUTES = 10;
/**
 * 改期幅度小于这个值就当作没变。
 *
 * 上游报的重置时刻本来就会在秒级上抖，每次核对都跟着挪一下，只会让日志刷满
 * 「下一拍改到…」，而界面上的倒计时一个字都不会变。
 */
const REPLAN_EPSILON_MS = 60_000;

/** 一次发送之后我们知道的四件事。 */
interface SendOutcome {
  /** 下一次发送的依据，取不到任何窗口时为 null。 */
  resetAt: number | null;
  /** 不为 null 表示上游是因为额度还没重置才拒绝的——那不算失败。 */
  limitedBy: Window | null;
  /**
   * 不必再去核对额度了：认证被拒，或者这个 provider 本来就不做保活发送。
   * 这几种情况等到额度重置也一样发不出去，该停下来叫人。
   */
  giveUp: boolean;
  /**
   * 令牌这一刻还不能用：跟随的客户端还没续期，或者自动刷新暂时没成。
   *
   * 这既不是失败也不是终局——两种情况都会自己好，所以既不查额度也不停账户，
   * 过一会儿回来再看一眼就是了。
   */
  needsToken: boolean;
}

/** 这一拍没有发出去，也没有可用的重置时刻。 */
function noSend(giveUp = false): SendOutcome {
  return { resetAt: null, limitedBy: null, giveUp, needsToken: false };
}

type RunState = AccountView['state'];

interface Worker {
  account: Account;
  state: RunState;
  lastError: string;
  /** 连着多少拍卡在「令牌还没就绪」上；用来把重试间隔逐步拉长。 */
  tokenWaits: number;
  /**
   * 当前这一拍是照哪个重置时刻排出来的。
   *
   * 等待期间重新核对额度时拿它来比对：变的是不是同一件事。直接比 nextDue 不行，
   * 那上面还加了每次都重新摇的抖动，比出来永远是「变了」。
   */
  plannedResetAt: number;
}

export class Scheduler {
  private store: Store;
  private config: AppConfig;
  private workers = new Map<string, Worker>();
  private abort: AbortController | null = null;
  private startedAt: number | null = null;
  private loops: Promise<void>[] = [];

  constructor(store: Store, config: AppConfig) {
    this.store = store;
    this.config = config;
  }

  get running(): boolean {
    return this.abort !== null;
  }

  /** 当前配置的每日窗口，单位是“本地零点之后的分钟数”。 */
  private window(): { startMin: number; endMin: number } {
    return {
      startMin: parseDailyTime(this.config.dailyStart) ?? 0,
      endMin: parseDailyTime(this.config.dailyEnd) ?? 0,
    };
  }

  status(): SchedulerStatus {
    const { startMin, endMin } = this.window();
    const now = Date.now();
    const within = isWithinDailyWindow(now, startMin, endMin);
    return {
      running: this.running,
      startedAt: this.startedAt,
      dailyStart: formatDailyTime(startMin),
      dailyEnd: formatDailyTime(endMin),
      withinWindow: within,
      // 全天窗口没有边界可倒计时
      windowEdgeAt:
        startMin === endMin
          ? null
          : within
            ? nextWindowClose(now, startMin, endMin)
            : nextWindowOpen(now, startMin, endMin),
      // 启动时可以只挑一部分账户，因此哪些在跑要如实报出来，而不是让界面按“全部”猜
      accountIds: this.running ? [...this.workers.keys()] : [],
    };
  }

  setConfig(cfg: AppConfig): void {
    this.config = cfg;
    setProxy(cfg.proxy, cfg.noProxy);
  }

  getConfig(): AppConfig {
    return this.config;
  }

  /**
   * 记一条应用日志：落库、推送给所有前端、再打到进程 stdout。
   *
   * 对外公开是因为路由层也要往同一条日志流里写——手动刷新 token、写回客户端配置这类操作
   * 都发生在 HTTP 请求里，用户却是在同一个日志面板上看结果的。
   */
  log(level: 'info' | 'warn' | 'error', accountId: string, message: string): void {
    const entry = this.store.appendLog({ ts: Date.now(), level, accountId, message });
    bus.emit({ type: 'log', entry });
    const tag = accountId ? `[${accountId}] ` : '';
    console.log(`${new Date(entry.ts).toLocaleTimeString()} ${level.padEnd(5)} ${tag}${message}`);
  }

  /**
   * 把刚换到的新令牌同步进正在跑的 worker。
   *
   * worker 手里的 Account 是启动那一刻从磁盘读进来的对象，之后就一直留在内存里。
   * 路由层强制刷新时读的是磁盘上的另一份，写回文件后，worker 手里那份 refresh_token
   * 已经被上游作废——下一拍它拿着作废的令牌去续期，只会白白失败一次。
   */
  adoptTokens(acct: Account): void {
    const worker = this.workers.get(acct.id);
    if (!worker || worker.account === acct) return;
    Object.assign(worker.account, {
      accessToken: acct.accessToken,
      refreshToken: acct.refreshToken,
      idToken: acct.idToken,
      accountId: acct.accountId,
      expiresAt: acct.expiresAt,
    });
  }

  /**
   * 磁盘上那份令牌比 worker 手里的新时就采纳过来。
   *
   * 换令牌的不只有 worker 自己：后台额度刷新、界面上的查额度都会走 ensureFresh，从客户端
   * 同步到新令牌后写回磁盘——而 worker 手里那份还停在启动那一刻。不认磁盘的结果，卡片上的
   * 有效期就一直显示换之前的那个（快照优先取 worker 手里的账户），worker 下一拍也还攥着
   * 过期令牌去发送，白失败一次。
   *
   * 只在磁盘更新时采纳，是为了不覆盖 worker 刚在内存里换好、还没落盘的那一瞬。
   */
  private adoptNewer(disk: Account): void {
    const worker = this.workers.get(disk.id);
    if (worker && disk.expiresAt > worker.account.expiresAt) this.adoptTokens(disk);
  }

  /** 发送之前先跟磁盘对一次账，见 adoptNewer。读不动磁盘不算事，手里那份还能用。 */
  private async syncFromDisk(accountId: string): Promise<void> {
    try {
      const disk = (await loadAccounts(ACCOUNTS_DIR)).find((a) => a.id === accountId);
      if (disk) this.adoptNewer(disk);
    } catch (err) {
      this.log('warn', accountId, `发送前重读账户文件失败，沿用手里的令牌: ${String(err)}`);
    }
  }

  /** 组装面向前端的账户视图，把磁盘凭证与运行时状态合并起来。 */
  async snapshot(): Promise<AccountView[]> {
    // 账户列表始终以磁盘为准：worker 里只有“本次纳入调度”的那些，拿它当列表会让
    // 没被选中的账户和 Qoder 账户在运行期间整个从界面上消失。
    // 令牌则取两者中新的那份：worker 可能刚换过，磁盘也可能被别的路径换过（见 adoptNewer）。
    const accounts = selectAccounts(await loadAccounts(ACCOUNTS_DIR), this.config).map((a) => {
      // 顺手把磁盘上更新的令牌交给 worker：快照是所有令牌变更之后都会走一遍的地方，
      // 在这里对账，界面和 worker 就一起跟上了
      this.adoptNewer(a);
      return this.workers.get(a.id)?.account ?? a;
    });
    const states = this.store.allStates();

    return Promise.all(accounts.map(async (a) => {
      const st = states.get(a.id);
      const worker = this.workers.get(a.id);
      return {
        id: a.id,
        provider: a.provider,
        email: a.email,
        disabled: a.disabled,
        // 额度查询结果通常比 token 自带声明更新，因此优先采用它
        plan: st?.plan || a.plan,
        subscriptionEndsAt: st?.subscriptionEndsAt || a.subscriptionEndsAt || null,
        userId: a.userId,
        loginMethod: a.loginMethod,
        tokenExpiresAt: a.expiresAt,
        windowResetAt: st && st.lastResetAt > 0 ? st.lastResetAt : null,
        nextDueAt: st && st.nextDueAt > 0 ? st.nextDueAt : null,
        lastSentAt: st && st.lastSentAt > 0 ? st.lastSentAt : null,
        usedPercent: st?.usedPercent ?? null,
        windowSource: st?.lastSource ?? '',
        windows: st?.windows ?? [],
        usageCheckedAt: st && st.usageCheckedAt > 0 ? st.usageCheckedAt : null,
        resetCredits: st?.resetCredits ?? null,
        resetCreditsExpiresAt: st?.resetCreditsExpiresAt ?? null,
        source: a.source,
        autoRefresh: a.autoRefresh,
        syncPath: a.syncPath,
        // 界面上要先告诉用户这次会写哪些文件，才谈得上让他决定点不点
        syncTargets: (await syncTargetsOf(a)).map((t) => t.path),
        consecutiveFailures: st?.consecutiveFailures ?? 0,
        // 没进本次调度的账户（没被勾中，或者本来就是 Qoder）不在跑，即使调度器开着
        state: worker?.state ?? 'stopped',
        lastError: worker?.lastError ?? st?.lastError ?? '',
      };
    }));
  }

  private async broadcast(): Promise<void> {
    bus.emit({ type: 'accounts', accounts: await this.snapshot() });
    bus.emit({ type: 'scheduler', status: this.status() });
  }

  /**
   * 推一次状态给前端，但不让调度循环等它。
   *
   * snapshot() 要把整个账户目录重读一遍，挂在发送前后的热路径上，等的是磁盘而不是额度。
   * 界面晚几十毫秒看到状态无所谓，推送失败更不该把这个账户的循环带下去。
   */
  private notify(): void {
    void this.broadcast().catch((err) => {
      console.error(`状态推送失败: ${String(err)}`);
    });
  }

  /** 错开多个账户用的随机延时。 */
  private jitterMs(): number {
    return Math.random() * this.config.jitterSeconds * 1000;
  }

  /**
   * 首拍的错开延时。
   *
   * 只跑一个账户时没有「同一秒一起发」这回事，到点就发——用户点了启动，界面该立刻有动静。
   * 多账户才需要摊开，摊的宽度就是 jitterSeconds。
   */
  private startupStaggerMs(): number {
    return this.workers.size > 1 ? this.jitterMs() : 0;
  }

  /**
   * 起跑前核对一次：此刻有没有窗口还在计时。
   *
   * 库里没有可续的排期，不等于「该补一发」。保活要的是打开并观测 5 小时窗口，而窗口
   * 还开着的时候再发一条，既开不出新窗口，也换不来新的重置时刻——白费一次额度，
   * 还把这个账户的节奏整体往后拖。只有确实没有窗口在计时（额度是满的），这一发才有意义。
   *
   * 挑窗口用的是和调度器完全同一条规则（nextSendWindow），取窗口的口径也和 replan 一致：
   * 库里那份够新就直接用，省一次上游调用；旧了才去只读额度接口问一次，问不动就退回库里
   * 那份。全都没有时返回 null——那既可能是真没在计时，也可能是从没查过，两者都按「该发」
   * 处理：漏发一次的代价是窗口白关，多发一次只是提前开窗，前者更糟。
   *
   * 挑出来的窗口还要再过一道 hasStarted：上游在窗口没开时报的是「从现在起再过一整个窗口」，
   * 那不是门槛，而恰恰说明额度是满的、这一发正该发出去。
   */
  private async startupWindow(worker: Worker): Promise<Window | null> {
    const state = this.store.getState(worker.account.id);
    const fresh = state !== null && state.usageCheckedAt > Date.now() - this.recheckMs();
    const queried = fresh ? null : await this.refreshWindows(worker.account);
    const windows = fresh ? state.windows : (queried ?? state?.windows ?? []);
    // 这份窗口是什么时候读回来的：hasStarted 要拿它去比，不能拿此刻，见那里的说明
    const observedAt = queried !== null ? Date.now() : (state?.usageCheckedAt ?? 0);

    const counting = nextSendWindow(windows, Date.now());
    return counting !== null && hasStarted(counting, observedAt) ? counting : null;
  }

  /**
   * 启动调度。
   *
   * `ids` 为空表示纳入全部可保活账户；给了就只跑这几个——只想给某一个账户保活时，
   * 不必先去配置里改 include/exclude。传进来的 id 里不可保活的（Qoder、被排除的）
   * 会被直接滤掉，一个都不剩时按“没有可保活账户”处理，而不是悄悄退回全部。
   */
  async start(ids: readonly string[] = []): Promise<void> {
    if (this.running) return;

    try {
      setProxy(this.config.proxy, this.config.noProxy);
    } catch (err) {
      // 用户明明要求走代理却退回直连，比根本不启动更糟
      this.log('error', '', `代理配置无效，未启动: ${(err as Error).message}`);
      return;
    }
    this.log('info', '', `出站代理: ${getProxy() || '直连'}`);

    const schedulable = selectSchedulable(await loadAccounts(ACCOUNTS_DIR), this.config);
    if (schedulable.length === 0) {
      this.log('error', '', `在 ${ACCOUNTS_DIR} 下没有找到可保活的账户，请先导入或登录`);
      return;
    }
    const wanted = new Set(ids);
    const accounts = wanted.size > 0 ? schedulable.filter((a) => wanted.has(a.id)) : schedulable;
    if (accounts.length === 0) {
      this.log('error', '', '选中的账户都不能保活（Qoder 或被 include/exclude 排除），未启动');
      return;
    }

    this.abort = new AbortController();
    this.startedAt = Date.now();
    this.workers = new Map(
      accounts.map((a) => [
        a.id,
        { account: a, state: 'idle' as RunState, lastError: '', tokenWaits: 0, plannedResetAt: 0 },
      ]),
    );

    const { startMin, endMin } = this.window();

    this.log(
      'info',
      '',
      `启动，共 ${accounts.length} 个账户${
        accounts.length < schedulable.length ? `（可保活的共 ${schedulable.length} 个，本次只跑选中的）` : ''
      }: ${accounts.map((a) => a.id).join(', ')}`,
    );
    this.log(
      'info',
      '',
      startMin === endMin
        ? '每日窗口: 全天'
        : `每日窗口: ${formatDailyTime(startMin)} – ${formatDailyTime(endMin)}${
            endMin < startMin ? '（跨零点）' : ''
          }`,
    );

    const signal = this.abort.signal;
    this.loops = [...this.workers.values()].map((w) =>
      this.runAccount(w, signal).catch((err) => {
        w.state = 'error';
        w.lastError = String(err);
        this.log('error', w.account.id, `异常退出: ${String(err)}`);
      }),
    );

    void Promise.all(this.loops).then(() => {
      if (this.running) {
        this.log('info', '', '全部账户结束');
        this.abort = null;
        void this.broadcast();
      }
    });

    await this.broadcast();
  }

  async stop(): Promise<void> {
    if (!this.abort) return;
    this.abort.abort();
    this.abort = null;
    await Promise.allSettled(this.loops);
    for (const w of this.workers.values()) w.state = 'stopped';
    this.log('info', '', '已停止');
    await this.broadcast();
  }

  /** 单个账户的完整生命周期；直到被停止，或该账户自己放弃为止。 */
  private async runAccount(worker: Worker, signal: AbortSignal): Promise<void> {
    const { account } = worker;

    // 重启恢复：如果 store 记录还没到点，就继续等，不要重新开一个新窗口
    const persisted = this.store.getState(account.id);
    const { startMin, endMin } = this.window();
    const persistedDue = persisted?.nextDueAt ?? 0;
    let due: number;

    if (persistedDue > Date.now()) {
      due = nextWindowOpen(persistedDue, startMin, endMin);
    } else {
      // 没有可续的排期：全新账户、上次出错时清过，或者停得太久已经过点。
      // 这时不能见了空排期就补一发——先核对窗口，见 startupWindow。
      const counting = await this.startupWindow(worker);
      if (signal.aborted) return;
      if (counting !== null) {
        const pct = counting.usedPercent === null ? '' : `，已用 ${counting.usedPercent.toFixed(0)}%`;
        this.log(
          'info',
          account.id,
          `${counting.name} 窗口仍在计时${pct}，这一发开不出新窗口，按它排下一拍`,
        );
        due = this.planFrom(worker, counting.resetAt).due;
      } else {
        // 首拍也要错开。恢复出来的节奏本身就是带着抖动算出来的，但全新起跑的账户如果都取
        // 当下这一刻，启动那一秒就会一起打向上游——jitterSeconds 要避免的正是这件事。
        due = nextWindowOpen(Date.now() + this.startupStaggerMs(), startMin, endMin);
      }
    }
    if (due > Date.now()) {
      worker.state = 'waiting';
      this.store.setNextDue(account.id, due);
      this.log('info', account.id, `等待至 ${new Date(due).toLocaleString()}`);
      this.notify();
    } else if (persistedDue > 0) {
      this.store.setNextDue(account.id, 0);
    }

    while (!signal.aborted) {
      const fired = await this.waitForDue(worker, due, signal);
      if (fired === null) return;
      due = fired;

      worker.state = 'sending';
      this.notify();

      const outcome = await this.sendOnce(worker, signal);
      let { resetAt } = outcome;

      if (signal.aborted) return;

      // 令牌没就绪就什么都别做，隔一会儿再来看：这一拍连发都没发出去，额度接口也一样
      // 会拿 401 顶回来，问了也是白问
      if (outcome.needsToken) {
        due = this.waitForToken(worker);
        continue;
      }
      worker.tokenWaits = 0;

      if (!outcome.giveUp && (resetAt === null || resetAt <= Date.now())) {
        // 停掉这个账户之前，最后去额度接口核对一次：只要 5 小时或周窗口里还有一个
        // 没到点，这一发发不出去就是意料之中的事，等到那一刻再发即可。把「额度还没
        // 重置」当成故障停掉，保活就此中断，而且要等人来手动重启才会恢复。
        const pending = await this.quotaReset(account, true);
        if (pending !== null) resetAt = this.noteLimited(worker, pending, '额度尚未重置');
      }

      if (resetAt === null || resetAt <= Date.now()) {
        const failures = this.store.getState(account.id)?.consecutiveFailures ?? 0;
        worker.state = 'error';
        worker.lastError = failures >= this.config.maxRetries
          ? '连续失败过多，停止该账户'
          : '未取得限额窗口重置时间，停止调度';
        this.store.setNextDue(account.id, 0);
        this.log('error', account.id, worker.lastError);
        this.notify();
        return;
      }

      const { due: nextDue, raw } = this.planFrom(worker, resetAt);
      due = nextDue;

      const hours = (due - Date.now()) / 3_600_000;
      this.log(
        'info',
        account.id,
        due > raw
          ? `下一拍 ${new Date(raw).toLocaleString()} 落在每日窗口外，顺延到 ${new Date(due).toLocaleString()}`
          : `下一次发送 ${new Date(due).toLocaleString()}（${hours.toFixed(1)} 小时后）`,
      );
      worker.state = 'waiting';
      this.notify();
    }
    worker.state = 'stopped';
    this.notify();
  }

  private onClockJump(accountId: string, driftMs: number): void {
    this.log(
      'warn',
      accountId,
      `检测到时钟跳变 ${(driftMs / 1000).toFixed(0)} 秒（休眠/校时），已按绝对时间重算`,
    );
  }

  /**
   * 照某个窗口的重置时刻排下一拍：加上缓冲与抖动，再顺延到每日窗口之内。
   *
   * 每次都重读窗口配置，界面上改完的每日时段才能从下一拍开始生效。
   * 同时记下这一拍的依据（plannedResetAt），等待期间重新核对时要拿它比对。
   */
  private planFrom(worker: Worker, resetAt: number): { due: number; raw: number } {
    const { startMin, endMin } = this.window();
    const raw = resetAt + this.config.bufferSeconds * 1000 + this.jitterMs();
    const due = nextWindowOpen(raw, startMin, endMin);
    worker.plannedResetAt = resetAt;
    this.store.setNextDue(worker.account.id, due);
    return { due, raw };
  }

  /** 等待期间隔多久回头核对一次额度。后台刷新关掉时也要自己查，否则就永远不改期了。 */
  private recheckMs(): number {
    const minutes = this.config.usageRefreshMinutes;
    return (minutes > 0 ? minutes : RECHECK_FALLBACK_MINUTES) * 60_000;
  }

  /**
   * 睡到 `due`，中途定期回头核对额度，窗口变了就改期。
   *
   * 排下一拍用的是排那一刻看到的窗口，而窗口自己是会动的：周额度是滚动窗口，等着等着
   * 就会放出一部分；上游也会主动重置。一睡到底的代价是明明一小时后就能发的账户，
   * 在那儿干等一天多——保活最该避免的正是这个。
   *
   * 返回真正到点的时刻（可能已经改过期），被取消时返回 null。
   */
  private async waitForDue(worker: Worker, due: number, signal: AbortSignal): Promise<number | null> {
    while (!signal.aborted) {
      // 下一个核对点和到点时刻谁先到就停在谁那儿
      const checkpoint = Math.min(due, Date.now() + this.recheckMs());
      const onJump = (drift: number) => this.onClockJump(worker.account.id, drift);
      if (!(await sleepUntil(checkpoint, signal, onJump))) return null;
      if (Date.now() >= due) return due;
      due = await this.replan(worker, due);
    }
    return null;
  }

  /**
   * 拿最新的窗口重算下一拍；核对不出结果就按原计划继续等。
   *
   * 这里读的窗口优先来自库：后台额度刷新一直在写它，同一份数据再查一遍只会给上游的
   * 限流计数白加一笔。只有库里那份也旧了（例如用户把后台刷新关了）才自己去查。
   */
  private async replan(worker: Worker, due: number): Promise<number> {
    const { account } = worker;
    // 等令牌的那种等待不看额度：令牌都取不到，额度接口同样会拿 401 顶回来
    if (worker.tokenWaits > 0) return due;

    const state = this.store.getState(account.id);
    const fresh = state !== null && state.usageCheckedAt > Date.now() - this.recheckMs();
    const windows = fresh ? state.windows : await this.refreshWindows(account);
    if (windows === null || windows.length === 0) return due;
    // 这份窗口是什么时候读回来的：hasStarted 要拿它去比，不能拿此刻，见那里的说明
    const observedAt = fresh ? state.usageCheckedAt : Date.now();

    const target = nextSendWindow(windows, Date.now());
    if (target === null || Math.abs(target.resetAt - worker.plannedResetAt) < REPLAN_EPSILON_MS) {
      return due;
    }
    /*
      还没开始计时的窗口不是门槛：它报的「重置时刻」是从这次查询算起的一整个窗口，下次核对
      时又会往后挪同样多。照它改期，下一拍会被推得和时间流逝一样快，永远排不到——一次真实
      事故里，codex 账户就是这样从 06:00 一路被推到 12:06，整个上午一条都没发出去。

      它说的其实是反面的事：额度是满的，没有窗口在跑，而这一发正好用来把窗口打开。所以不
      光是别照它改期，索性把这一拍提前，现在就补一发。两道闸拦着别发过头：只提前不推后；
      距上次发送不足一个窗口就不补——万一哪天上游把正在计时的窗口也报成这个样子，最多每个
      窗口多发一条，不至于变成每核对一次发一条。
    */
    if (!hasStarted(target, observedAt)) {
      const windowMs = (target.windowMinutes ?? 0) * 60_000;
      if (Date.now() - (state?.lastSentAt ?? 0) < windowMs) return due;
      const { startMin, endMin } = this.window();
      const next = nextWindowOpen(Date.now(), startMin, endMin);
      if (next >= due) return due;
      // 这一拍不是照窗口排的，等待期间没有什么可以拿来跟它比对，见 waitForToken 里同样的处理
      worker.plannedResetAt = 0;
      this.store.setNextDue(account.id, next);
      this.log(
        'info',
        account.id,
        `${target.name} 窗口还没开始计时，额度是满的，提前到 ${new Date(next).toLocaleString()}` +
          ` 补一发（原定 ${new Date(due).toLocaleString()}）`,
      );
      this.notify();
      return next;
    }
    /*
      用满的窗口和 5 小时窗口都是明确的门槛，往前往后都照它改。
      其余窗口（例如这一刻上游只报得出周窗口）只是个兜底，凭它把下一拍往后拖，就会出现
      「5 小时窗口早关了，却还在等一周」——保活最该避免的正是这个。这种时候宁可按原计划
      发出去，发完拿响应里的窗口重排。
    */
    const threshold = isExhausted(target) || isFiveHour(target);
    if (!threshold && target.resetAt > worker.plannedResetAt) return due;

    const { due: next } = this.planFrom(worker, target.resetAt);
    // 认下了这个依据，但时刻本身没挪动（重启恢复后的第一次核对多半是这样），就别去打扰用户
    if (Math.abs(next - due) < REPLAN_EPSILON_MS) return next;

    const pct = target.usedPercent === null ? '' : `，已用 ${target.usedPercent.toFixed(0)}%`;
    this.log(
      'info',
      account.id,
      `按 ${target.name} 窗口重排${pct}，下一次发送改到 ${new Date(next).toLocaleString()}` +
        `（原定 ${new Date(due).toLocaleString()}）`,
    );
    this.notify();
    return next;
  }

  /**
   * 去只读额度接口取一次当前窗口，顺手写回库里，界面也就跟着更新了。
   *
   * 返回 null 表示这次没问出可信的结果——调用方应当沿用手里的旧窗口，而不是当成
   * 「这个账户没有窗口」，后者会把一次网络抖动变成停掉账户。
   */
  private async refreshWindows(account: Account): Promise<Window[] | null> {
    try {
      const usage = await queryUsage(account, { windowsOnly: true });
      const checkedAt = Date.now();
      const valid =
        usage.ok &&
        usage.windows.length > 0 &&
        usage.windows.every((window) => Number.isFinite(window.resetAt) && window.resetAt > checkedAt);
      if (!valid) {
        this.log('warn', account.id, '额度查询未返回有效的未来窗口，沿用上次记录的窗口');
        return null;
      }
      // 顺手写回：界面上的窗口不该停留在上一次的那一份
      this.store.recordUsage(
        account.id,
        {
          windows: usage.windows,
          plan: usage.plan,
          subscriptionEndsAt: usage.subscriptionEndsAt,
          checkedAt,
        },
        nextSendWindow(usage.windows, checkedAt),
      );
      return usage.windows;
    } catch (err) {
      this.log('warn', account.id, `额度查询失败，改用上次记录的窗口: ${String(err)}`);
      return null;
    }
  }

  /**
   * 回头确认一次：额度到底重置了没有。
   *
   * 一次发送失败可能是接口坏了，也可能只是额度还没重置，而两者的处理方式完全相反：
   * 前者该重试、重试不好就停下来叫人；后者只要等，等到那一刻自己就好了。误判的代价
   * 也不对称——把「额度没到点」当成故障，账户会被直接停掉，保活断在这里没人知道。
   *
   * 所以这里去只读额度接口把 5 小时和周窗口都问一遍（问不通就退回库里上次记下的，
   * 旧一点也好过没有），返回这一发要等的那个重置时刻：
   *
   *   - 有窗口已经用满，就等它们全部重置——它们才是这一发被拒的原因；
   *   - 都没用满时，只有 `trustAny`（上游明确说了触限，或者这一拍本来就无窗口可用）
   *     才退而求其次按常规节奏排。否则宁可判定「这不是额度问题」，让重试与失败计数
   *     照常走，免得把真正的故障装扮成等额度，一等就是几个小时。
   */
  private async quotaReset(account: Account, trustAny: boolean): Promise<Window | null> {
    const now = Date.now();
    // 失败之后要的是此刻的真相，因此总是现查一次；查不动才退回库里那份
    const windows = (await this.refreshWindows(account)) ?? this.store.getState(account.id)?.windows ?? [];

    return blockingWindow(windows, now) ?? (trustAny ? nextSendWindow(windows, now) : null);
  }

  /**
   * 令牌还没就绪：把下一拍往后推一点再来看，而不是停掉这个账户。
   *
   * 跟随客户端的账户由原客户端负责续期，那是用户下次打开 Claude Code 的事；自动刷新失败
   * 也常常只是网络抖了一下。两种情况过一会儿都会自己好，唯独「停掉」不会——账户一停，保活
   * 就断到有人发现并手动重启为止，而这恰恰是最不容易被发现的一种断。
   *
   * 间隔逐次翻倍（封顶 TOKEN_WAIT_MAX_MS），因为等的是一件我们既催不动也预测不了的事：
   * 一直按最短间隔重试，只是在日志里刷屏，跟随模式下还会反复去读同一个没变的凭证文件。
   * 返回下一拍时刻，好让调用方直接接着排。
   */
  private waitForToken(worker: Worker): number {
    const backoff = this.config.retryBackoffSeconds * 1000 * 2 ** Math.min(worker.tokenWaits, 16);
    // 重试也是要发送的，同样不能落在每日窗口之外
    const win = this.window();
    const due = nextWindowOpen(Date.now() + Math.min(backoff, TOKEN_WAIT_MAX_MS), win.startMin, win.endMin);
    worker.tokenWaits++;
    // 这一拍不是照窗口排的，等待期间没有什么可以拿来跟它比对，见 replan
    worker.plannedResetAt = 0;
    // 令牌拿不到不是「发送失败」，别让它累进那个会把账户判死的计数器
    this.store.clearFailures(worker.account.id);
    this.store.setNextDue(worker.account.id, due);
    worker.state = 'waiting';
    this.log(
      'warn',
      worker.account.id,
      `${worker.lastError}；${new Date(due).toLocaleString()} 再看一次，调度不停`,
    );
    this.notify();
    return due;
  }

  /**
   * 这一发是被额度挡下来的：既不算失败，也不该在界面上留下错误。
   * 返回下一拍要用的重置时刻，好让调用方直接接着排。
   */
  private noteLimited(worker: Worker, window: Window, reason: string): number {
    worker.lastError = '';
    // 额度没到点不是失败；计进去的话，一个完全健康的账户几轮之后就会被判成
    // 「连续失败过多」而停掉
    this.store.clearFailures(worker.account.id);
    const pct = window.usedPercent === null ? '' : ` | 已用 ${window.usedPercent.toFixed(0)}%`;
    this.log(
      'info',
      worker.account.id,
      `${reason}（${window.name}${pct}），窗口重置 ${new Date(window.resetAt).toLocaleString()}`,
    );
    return window.resetAt;
  }

  /** 带重试地发送一次；返回下一拍的依据，以及这一发到底是失败了还是在等额度。 */
  private async sendOnce(worker: Worker, signal: AbortSignal): Promise<SendOutcome> {
    const { account } = worker;
    if (account.provider === 'qoder') {
      // Qoder 的额度按订阅周期发放，发消息只会白白花掉 credits
      worker.lastError = 'Qoder 没有滚动窗口，不做保活发送';
      return noSend(true);
    }
    const model = this.config.models[account.provider];
    let lastError = '';

    // 手里那份可能已经被别的路径换掉了（后台额度刷新就会），发之前先跟磁盘对一次账
    await this.syncFromDisk(account.id);

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      if (signal.aborted) return noSend();

      const fresh = await ensureFresh(account, (lvl, msg) => this.log(lvl, account.id, msg));
      if (!fresh) {
        // 令牌拿不到就是拿不到，重试几次也一样；等它续期是调用方的事，见 waitForToken
        worker.lastError = account.autoRefresh ? 'token 刷新失败' : 'token 已过期，等客户端续期';
        return { resetAt: null, limitedBy: null, giveUp: false, needsToken: true };
      }

      const result = await send(account, this.config.text, model, {
        proxy: this.config.proxy,
        noProxy: this.config.noProxy,
      });
      // 这一发之后要等的那个窗口：周额度用满时就是它，而不是更早重置的 5 小时窗口
      const window = nextSendWindow(result.windows, result.sentAt);

      this.store.recordSend({
        accountId: account.id,
        sentAt: result.sentAt,
        ok: result.ok,
        resetAt: window?.resetAt ?? null,
        source: window?.source ?? '',
        usedPercent: window?.usedPercent ?? null,
        error: result.error,
      });

      if (result.ok) {
        worker.lastError = '';
        if (window) {
          const pct = window.usedPercent === null ? '?' : `${window.usedPercent.toFixed(0)}%`;
          this.log(
            'info',
            account.id,
            `发送成功 | 已用 ${pct} | 窗口重置 ${new Date(window.resetAt).toLocaleString()} | 来源 ${window.source}`,
          );
          // 这条不是上游说的，是发送时刻加 5 小时推出来的，值得单独提醒一句
          if (window.source === 'assumed') {
            this.log(
              'warn',
              account.id,
              '额度接口没能给出窗口（多半是它自己在限流），下一拍按 5 小时估算，届时会重新问一次',
            );
          }
        } else {
          this.log('info', account.id, '发送成功，但响应未带限额信息');
        }
        return { resetAt: window?.resetAt ?? null, limitedBy: null, giveUp: false, needsToken: false };
      }

      // 429 自带重置时间，因此不算真正失败；它本身就能决定下一拍时间
      if (result.status === 429 && window) {
        return {
          resetAt: this.noteLimited(worker, window, '已触限'),
          limitedBy: window,
          giveUp: false,
          needsToken: false,
        };
      }

      lastError = `HTTP ${result.status}: ${result.error}`;
      worker.lastError = lastError;

      if (result.status === 401 || result.status === 403) {
        this.log('error', account.id, `认证失败，停止该账户: ${lastError.slice(0, 160)}`);
        return noSend(true);
      }

      /**
       * 被拒不等于接口坏了：额度还没重置时，上游拒绝这一发本来就是对的。
       *
       * 只在第一次失败之后确认一遍：几十秒内窗口不会变，多问几次只会给额度接口自己的
       * 限流计数加数。上游明说了触限（429 但没给出窗口）时，任何一个没到点的窗口都算数；
       * 其余错误则要求确实有窗口用满了，免得把网络故障也当成等额度。
       */
      if (attempt === 1) {
        const pending = await this.quotaReset(account, result.status === 429);
        if (pending !== null) {
          return {
            resetAt: this.noteLimited(worker, pending, '额度尚未重置'),
            limitedBy: pending,
            giveUp: false,
            needsToken: false,
          };
        }
      }

      if (attempt < this.config.maxRetries) {
        const backoff = this.config.retryBackoffSeconds * 1000 * 2 ** (attempt - 1);
        this.log(
          'warn',
          account.id,
          `第 ${attempt} 次失败 (${lastError.slice(0, 120)})，${(backoff / 1000).toFixed(0)}s 后重试`,
        );
        if (!(await sleepUntil(Date.now() + backoff, signal))) return noSend();
      }
    }

    this.log('error', account.id, `重试耗尽: ${lastError.slice(0, 200)}`);
    return noSend();
  }

  /** UI 中“测试文本”按钮对应的动作，不会打乱当前调度节奏。 */
  async sendNow(accountId: string): Promise<SendNowResult> {
    const accounts = selectAccounts(await loadAccounts(ACCOUNTS_DIR), this.config);
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return { accountId, ok: false, message: '找不到该账户' };
    if (account.provider === 'qoder') {
      return { accountId, ok: false, message: 'Qoder 只做额度查询，不发送保活文本' };
    }

    try {
      setProxy(this.config.proxy, this.config.noProxy);
    } catch (err) {
      return { accountId, ok: false, message: `代理配置无效: ${(err as Error).message}` };
    }
    // 单独一份 Worker：sendOnce 会往里写 lastError，借用正在跑的那个会把调度循环的
    // 状态覆盖掉。account 仍取 worker 手里那份——它带着运行中刚换到的令牌，比磁盘上的新。
    const live = this.workers.get(accountId);
    const worker: Worker = {
      account: live?.account ?? account,
      state: 'idle',
      lastError: '',
      tokenWaits: 0,
      plannedResetAt: 0,
    };

    // 停止调度时这一发也要跟着停：重试退避最长能占用好几分钟，不然 stop() 返回之后
    // 还有一发在飞
    const controller = new AbortController();
    const stopSignal = this.abort?.signal;
    const onStop = () => controller.abort();
    if (stopSignal?.aborted) controller.abort();
    else stopSignal?.addEventListener('abort', onStop, { once: true });

    let resetAt: number | null;
    let limitedBy: Window | null;
    try {
      ({ resetAt, limitedBy } = await this.sendOnce(worker, controller.signal));
    } finally {
      stopSignal?.removeEventListener('abort', onStop);
    }
    await this.broadcast();
    // 拿不到重置时间不等于失败：只要没留下错误，这一发就算发出去了
    if (worker.lastError) return { accountId, ok: false, message: worker.lastError };
    // 被额度挡住时这一发并没有发出去，不能报成功——但它也不是故障，说清楚等到什么时候
    if (limitedBy !== null) {
      return {
        accountId,
        ok: false,
        message: `额度未重置（${limitedBy.name}），${new Date(limitedBy.resetAt).toLocaleString()} 之后再试`,
      };
    }
    return {
      accountId,
      ok: true,
      message:
        resetAt === null
          ? '发送完成，但未取到重置时间'
          : `发送成功，窗口重置于 ${new Date(resetAt).toLocaleString()}`,
    };
  }

  /**
   * 批量“测试文本”。逐个串行发送，而不是一起并发：
   * 同时打几发只会让上游更容易把这一批判成异常流量，也让日志难对上账户。
   */
  async sendNowMany(accountIds: string[]): Promise<SendNowResult[]> {
    const results: SendNowResult[] = [];
    for (const id of accountIds) results.push(await this.sendNow(id));
    return results;
  }
}

/**
 * 参与调度与保活发送的账户。
 *
 * 在 selectAccounts 之上再去掉 Qoder：它按订阅周期发放 credits，没有会自己重置的
 * 窗口，保活发一条只是纯消耗。这类账户仍然出现在界面和额度查询里。
 */
export function selectSchedulable(accounts: Account[], cfg: AppConfig): Account[] {
  return selectAccounts(accounts, cfg).filter((a) => a.provider !== 'qoder');
}

export function selectAccounts(accounts: Account[], cfg: AppConfig): Account[] {
  return accounts.filter((a) => {
    if (a.disabled) return false;
    if (cfg.include.length > 0 && !cfg.include.some((k) => a.email.includes(k))) return false;
    if (cfg.exclude.some((k) => a.email.includes(k))) return false;
    return true;
  });
}

/**
 * 睡到 `deadline`（绝对时刻）为止；如果中途被取消则返回 false。
 * 按分片反复重算，而不是只挂一个超长 setTimeout，才能扛住系统休眠和时钟校正。
 */
export async function sleepUntil(
  deadline: number,
  signal: AbortSignal,
  onClockJump?: (driftMs: number) => void,
  tickMs = TICK_MS,
): Promise<boolean> {
  while (!signal.aborted) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return true;

    const slice = Math.min(remaining, tickMs);
    const before = Date.now();
    const finished = await sleep(slice, signal);
    if (!finished) return false;

    const drift = Date.now() - before - slice;
    if (drift > CLOCK_JUMP_MS) onClockJump?.(drift);
  }
  return false;
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
