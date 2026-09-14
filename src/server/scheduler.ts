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
 * 3. 调度器自己只在发送前后查额度：起跑前判断该不该发、发完读刚打开的窗口、发失败时
 *    分辨是不是额度没到点。等待期间一次都不查——改期靠的是别人写进库的那份新数据
 *    （后台定时刷新、界面上的「查询额度」），见 waitForDue。
 */
import { ACCOUNTS_DIR } from './config.js';
import { loadAccounts, ensureFresh, type Account } from './creds.js';
import { send } from './providers.js';
import { blockingWindow, hasStarted, isThresholdWindow, nextSendWindow } from './ratelimit.js';
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
import { buildAccountViews, selectAccounts, selectSchedulable } from './accounts-view.js';
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
/**
 * 等令牌就绪时两次重试之间最长隔多久。
 *
 * 跟随客户端的账户要等它自己续期，那取决于用户什么时候再打开一次 Claude Code，我们无从预知，
 * 所以间隔逐次拉长；但拉得再长也要封顶，否则续期完还得再空等几个小时才发得出下一拍。
 */
const TOKEN_WAIT_MAX_MS = 30 * 60_000;
/**
 * 单拍内两次重试之间最多退避多久。
 *
 * 退避是翻倍涨的，maxRetries 放到 10 时最后几次要睡上两个多小时——一拍卡这么久，
 * 这个账户的整条节奏都跟着停摆，还不如早点认输把这一拍收掉。
 */
const RETRY_BACKOFF_MAX_MS = 30 * 60_000;
/**
 * 库里那份额度数据多新才算「此刻的真相」。
 *
 * 起跑前判断有没有窗口在计时时要用它：比这还新就直接用库里那份，省掉一次上游调用；
 * 旧了才自己去查一次。这个阈值只决定「复用还是重查」，本身不会引出任何定时查询——库里那份
 * 由后台定时刷新、界面上的「查询额度」和发送前后的查询写新。每日时段外后台刷新是停着的，
 * 那时这份数据必然会放旧，于是当晚第一拍起跑前自己查一次，这正是想要的。
 */
const USAGE_FRESH_MS = 10 * 60_000;
/**
 * 两次额度核对隔得比这还近，就当成同一次问话。
 *
 * 一拍里有两处要核对：sendOnce 第一次失败之后，以及调用方失败收尾时。中间隔着重试退避，
 * 通常有几十秒；但 maxRetries 可以配成 1，那时两次之间一轮退避都没有，隔不到一秒去问
 * 同一个接口，答案必然一样，只会给它自己的限流计数白加一笔。
 */
const QUOTA_PROBE_REUSE_MS = 10_000;
/**
 * 状态推送的合并窗口。
 *
 * 一次发送前后、每次改期都会推一遍，N 个账户各推各的，而 snapshot() 要把整个账户目录
 * 重读一遍。界面晚这么一点看到状态无所谓，合并之后既省磁盘，也不会出现两次并发推送
 * 谁先到达没准、前端被一份更旧的快照盖掉的情况。
 */
const BROADCAST_COALESCE_MS = 200;
/**
 * 改期幅度小于这个值就当作没变。
 *
 * 上游报的重置时刻本来就会在秒级上抖，每次核对都跟着挪一下，只会让日志刷满
 * 「下一拍改到…」，而界面上的倒计时一个字都不会变。
 */
const REPLAN_EPSILON_MS = 60_000;
/** 一个 5 小时窗口有多长；非门槛窗口能把下一拍推多远就以它为限，见 cappedResetAt。 */
const WINDOW_5H_MS = 5 * 3_600_000;
/**
 * 整拍发不出去时，两次重来之间最长隔多久。
 *
 * 封在一个 5 小时窗口上：上游真坏了也不必一直去撞，而它一旦好了，最多一个周期就能接上——
 * 保活本来就是按这个节奏走的，等上一个周期跟停掉账户完全是两回事。
 */
const FAIL_WAIT_MAX_MS = WINDOW_5H_MS;
/**
 * 每日时段改过之后，最迟多久让已经排定的那一拍跟着改。
 *
 * 醒来只做一次纯本地计算，不碰网络，因此可以醒得勤：用户在界面上把时段改窄，
 * 总不能眼看着下一拍还是落在窗口外。库里的额度数据换了新的，也是在这些醒来的时刻被看见。
 */
const WINDOW_TICK_MS = 60_000;

/** 一次发送之后我们知道的几件事。 */
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
  /**
   * 这一发到底出去了没有。
   *
   * 决定发送之后那次额度核对该信到什么程度：发出去了只是没读到窗口，那就得排出下一拍，
   * 任何一个没到点的窗口都比没有强；重试耗尽的那种压根没发出去，就只认真门槛，否则一次
   * 真故障会被记成「额度尚未重置」，连失败计数一起清零，一等好几个小时还没人知道。
   */
  sent: boolean;
  /**
   * 这一拍里 sendOnce 什么时候回头核对过额度；0 表示没核对过。
   *
   * 调用方失败收尾时还要再核对一次。maxRetries 配成 1 时两次中间连一轮退避都没有，
   * 隔不到一秒问同一个接口，答案必然一样，只会给它自己的限流计数白加一笔。
   */
  quotaProbedAt: number;
}

/** 这一拍没有发出去，也没有可用的重置时刻。 */
function noSend(giveUp = false, quotaProbedAt = 0): SendOutcome {
  return { resetAt: null, limitedBy: null, giveUp, needsToken: false, sent: false, quotaProbedAt };
}

/**
 * 照这个窗口排下一拍，最远能推到什么时候。
 *
 * 用满的窗口和 5 小时窗口是真门槛，等多久都是应该的；其余窗口（典型情况是这一刻上游只
 * 报得出周窗口，5 小时那条根本没出现在响应里）只是个兜底，凭它把下一拍推到几天后，等于
 * 放着 5 小时窗口不管——而它多半只是已经关了，正等着被下一发打开，不发就永远开不出来。
 *
 * 这种窗口按一个 5 小时窗口封顶，取的和 providers 里那条估算窗口同一个上界：宁可早发一次、
 * 到时候重新问一遍，也不要一睡好几天，而日志里看着一切正常。
 *
 * startupWindow 和 replan 里那道 isThresholdWindow 说的是同一件事，只不过它们
 * 决定的是「这一发发不发」，这里决定的是「发完等多久」。
 */
export function cappedResetAt(w: Window, from: number): number {
  if (isThresholdWindow(w)) return w.resetAt;
  return Math.min(w.resetAt, from + WINDOW_5H_MS);
}

/**
 * 逐次翻倍的退避间隔，封顶在 capMs。
 *
 * 等令牌就绪和整拍失败重来用的是同一套：等的都是一件我们既催不动也预测不了的事，
 * 一直按最短间隔重试只是在日志里刷屏。
 */
function backoffMs(baseSeconds: number, attempts: number, capMs: number): number {
  // 指数先夹一道，免得 2 ** 大数字先溢出成 Infinity 再去比大小
  return Math.min(baseSeconds * 1000 * 2 ** Math.min(attempts, 16), capMs);
}

/**
 * 由字符串派生出一个稳定的 [0, 1) 小数（FNV-1a）。
 *
 * 用来给每个账户配一个固定的错开量。不能每次重摇随机数：reclamp 每分钟就要把这一拍
 * 重框一遍，摇出来的值次次不同，界面上的倒计时会一直抖，日志也会跟着刷屏。
 */
function unitHash(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

type RunState = AccountView['state'];

interface Worker {
  account: Account;
  state: RunState;
  lastError: string;
  /** 连着多少拍卡在「令牌还没就绪」上；用来把重试间隔逐步拉长。 */
  tokenWaits: number;
  /** 连着多少拍整拍发不出去；同样用来把重来的间隔逐步拉长，见 waitAfterFailure。 */
  failWaits: number;
  /**
   * 循环外面塞进来的改期请求，值是新的重置时刻。
   *
   * 目前只有一个来源：界面上的「测试文本」。那一发是真的会打开 5 小时窗口的，可运行中的
   * worker 并不知情——不告诉它，界面上的「下次发送」就一直是错的，真到点了还会白发一条
   * 被上游顶回来。等待循环每次醒来都会看一眼这里，见 waitForDue。
   */
  pendingPlan: number | null;
  /**
   * 当前这一拍顺延进每日时段之前的原始时刻。
   *
   * 每日时段是用户随时会改的：改窄了，已经排好的那一拍会落到窗口外照发不误；改宽了，
   * 被顺延到明天早上的那一拍本该现在就发。两种都要拿这个原始时刻用新时段重框，见 reclamp。
   */
  plannedRaw: number;
  /**
   * 当前这一拍是照哪个重置时刻排出来的。
   *
   * 等待期间重新核对额度时拿它来比对：变的是不是同一件事。直接比 nextDue 不行，
   * 那上面还加了每次都重新摇的抖动，比出来永远是「变了」。
   */
  plannedResetAt: number;
  /**
   * 把这条循环从睡眠里叫醒的那个开关，见 usageChanged。
   *
   * 等待期间平时一分钟才醒一次（WINDOW_TICK_MS），那是给「时段被改过」这类不着急的事
   * 用的。但用户在界面上点「查询额度」，等的就是当场看见下一拍跟着变——让他盯着一个不动
   * 的倒计时等满一分钟，和没改期没有区别。abort 一次就是叫醒一次；叫醒的人负责换上一个
   * 新的，否则第二次叫就叫不动了。
   */
  wake: AbortController;
}

/** 一个还没排过任何一拍的 worker。 */
function newWorker(account: Account): Worker {
  return {
    account,
    state: 'idle',
    lastError: '',
    tokenWaits: 0,
    failWaits: 0,
    wake: new AbortController(),
    pendingPlan: null,
    plannedResetAt: 0,
    plannedRaw: 0,
  };
}

export class Scheduler {
  private store: Store;
  private config: AppConfig;
  private workers = new Map<string, Worker>();
  private abort: AbortController | null = null;
  /** 正在收尾的那一轮；running 已经变假，但取消信号还有人要用，见 stop。 */
  private stopping: AbortController | null = null;
  private startedAt: number | null = null;
  private loops: Promise<void>[] = [];
  /** 合并中的状态推送，见 notify。 */
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private broadcastPending = false;
  /** 正在飞的那一次推送；不为 null 时新的请求只记账，不另起一次，见 notify。 */
  private broadcasting: Promise<void> | null = null;

  /**
   * 等待期间多久醒来一次；醒来只做纯本地的事，见 waitForDue。
   * 留成参数是为了让测试把它调小，在一个用例里看到改期，而不必真等一分钟。
   */
  private readonly windowTickMs: number;

  constructor(store: Store, config: AppConfig, windowTickMs = WINDOW_TICK_MS) {
    this.store = store;
    this.config = config;
    this.windowTickMs = windowTickMs;
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
    if (!worker) return;
    Object.assign(worker.account, {
      autoRefresh: disk.autoRefresh,
      syncPath: disk.syncPath,
      syncSource: disk.syncSource,
    });
    if (disk.expiresAt > worker.account.expiresAt) this.adoptTokens(disk);
  }

  /**
   * 发送之前先跟磁盘对一次账：采纳更新的令牌（见 adoptNewer），顺便确认这个账户还该不该跑。
   *
   * 删账户、禁用、改 include/exclude 都发生在这条循环外面，而循环手里攥着的是启动那一刻
   * 读进来的 Account。不回头看一眼的话，一个已经从界面上消失的账户（snapshot 是按当前配置
   * 过滤的）还会拿着内存里那份令牌一拍一拍地发下去——用户以为删干净了，它还在打上游，
   * 而界面上连这个账户都找不到，没有任何地方能看出这件事。
   *
   * 返回非 null 表示它已经不在调度范围内，字符串是给用户看的原因。读不动磁盘时返回 null：
   * 手里那份令牌还能用，一次读盘失败不该把账户踢出调度。
   */
  private async syncFromDisk(accountId: string): Promise<string | null> {
    try {
      const disk = (await loadAccounts(ACCOUNTS_DIR)).find((a) => a.id === accountId);
      if (!disk) return '账户已删除';
      this.adoptNewer(disk);
      // 和 start() 挑账户用的是同一个判据，两处才不会对「谁该跑」给出不同答案
      if (selectSchedulable([disk], this.config).length === 0) {
        return disk.disabled ? '账户已禁用' : '账户已被 include/exclude 排除';
      }
      return null;
    } catch (err) {
      this.log('warn', accountId, `发送前重读账户文件失败，沿用手里的令牌: ${String(err)}`);
      return null;
    }
  }

  /**
   * 取一份面向前端的账户列表。
   *
   * 这里只负责「哪些账户、用哪份凭证、各自跑到哪一步」，字段怎么拼在 accounts-view 里。
   */
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
    return buildAccountViews(accounts, this.store.allStates(), (id) => {
      const worker = this.workers.get(id);
      return worker ? { state: worker.state, lastError: worker.lastError } : null;
    });
  }

  private async broadcast(): Promise<void> {
    bus.emit({ type: 'accounts', accounts: await this.snapshot() });
    bus.emit({ type: 'scheduler', status: this.status() });
  }

  /**
   * 推一次状态给前端，但不让调度循环等它，并且把短时间内的多次推送合并成一次。
   *
   * snapshot() 要把整个账户目录重读一遍，挂在发送前后的热路径上，等的是磁盘而不是额度；
   * 而一拍下来光是「开始发送/发完了/排好了下一拍」就有三次，N 个账户还各推各的。
   *
   * 合并的另一半理由是顺序：不合并的话，两次并发的 snapshot 谁先读完磁盘就谁先发出去，
   * 前端有可能被一份更旧的快照盖掉。这里始终只有一次在飞，尾沿再补一次，最后到达的
   * 必定是最新的那份。
   */
  private notify(): void {
    // 排着一次、或者有一次正在读磁盘：这次的变化都由它一并带上。只看定时器不够——
    // 那一次广播飞出去的时候定时器就已经清空了，此时再起一次，两份快照就并发了，
    // 而 snapshot() 要读整个账户目录外加每个客户端凭证文件，谁先读完谁先到，
    // 前端照样会被更旧的那份盖掉，正是这里要避免的事
    if (this.broadcastTimer !== null || this.broadcasting !== null) {
      this.broadcastPending = true;
      return;
    }
    this.broadcastPending = false;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcasting = this.broadcast()
        .catch((err) => {
          console.error(`状态推送失败: ${String(err)}`);
        })
        .finally(() => {
          this.broadcasting = null;
          // 这一轮读磁盘期间又有变化，再补一次；否则界面会停在中间那个状态上
          if (this.broadcastPending) this.notify();
        });
    }, BROADCAST_COALESCE_MS);
    this.broadcastTimer.unref?.();
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
   * 此刻手里最好的那份窗口，以及它是什么时候读回来的。
   *
   * 优先用库里那份：后台定时刷新、界面上点过的「查询额度」、刚发完那一次查询都会把它写新，
   * 同一份数据再查一遍只会给上游的限流计数白加一笔。只有它也旧了（超过 USAGE_FRESH_MS）
   * 才自己去查；
   * 查不动就退回库里那份，旧一点也好过交白卷——调用方会把「一个窗口都没有」当成另一回事。
   *
   * observedAt 是这份数据从上游读回来的时刻，不是此刻：hasStarted 必须拿它去比，
   * 否则一个从没开过的窗口会被算成「已经开了半小时」，见那里的说明。
   *
   * 起跑判断和等待期核对问的是同一件事，因此共用这一段；分开写的话，两处迟早会漂。
   */
  private async currentWindows(
    account: Account,
  ): Promise<{ windows: Window[]; observedAt: number; fresh: boolean }> {
    const state = this.store.getState(account.id);
    if (state !== null && state.usageCheckedAt > Date.now() - USAGE_FRESH_MS) {
      return { windows: state.windows, observedAt: state.usageCheckedAt, fresh: true };
    }
    const probed = await this.refreshWindows(account);
    if (probed !== null) return { windows: probed, observedAt: Date.now(), fresh: true };
    // fresh 为 false 表示这份是问不动上游之后退回来的旧数据：起跑时它仍比没有强，
    // 但等待期的改期不该照着它动——凭一份放了半天的窗口把下一拍往后推，是白等
    return { windows: state?.windows ?? [], observedAt: state?.usageCheckedAt ?? 0, fresh: false };
  }

  /**
   * 这个账户被顺延到开窗时刻之后，还要再往后错开多少。
   *
   * nextWindowOpen 顺延时返回的是精确到毫秒的窗口起点，于是所有跨夜被顺延的账户会在
   * 06:00:00.000 一起打向上游——jitterSeconds 要避免的正是这件事，而它加在顺延之前的
   * raw 上，顺延一发生就被抹掉了。
   *
   * 错开量按 accountId 派生而不是每次重摇：reclamp 每分钟就要把这一拍重框一遍，随机数
   * 会让它一直抖，界面上的倒计时和日志都跟着刷屏。窗口本身很窄时按窗口长度收一收，
   * 免得错开反倒把这一拍推出窗口外。
   */
  private spreadMs(accountId: string): number {
    const span = this.config.jitterSeconds * 1000;
    if (span <= 0) return 0;
    const { startMin, endMin } = this.window();
    const windowMs =
      startMin === endMin ? Number.POSITIVE_INFINITY : (((endMin - startMin + 1440) % 1440) * 60_000);
    return unitHash(accountId) * Math.min(span, windowMs / 2);
  }

  /**
   * 把这一拍框进每日时段：落在时段内就照原样，落在外面就顺延到下次开窗并错开。
   *
   * 所有算下一拍的地方都要走这里，包括 reclamp——它每分钟重算一次，算法不一致的话，
   * 每一次都会看出「差了一个错开量」，于是没完没了地改期。
   */
  private frameIntoWindow(accountId: string, raw: number): number {
    const { startMin, endMin } = this.window();
    const open = nextWindowOpen(raw, startMin, endMin);
    return open === raw ? raw : open + this.spreadMs(accountId);
  }

  /**
   * 起跑前核对一次：此刻有没有窗口还在计时。
   *
   * 库里没有可续的排期，不等于「该补一发」。保活要的是打开并观测 5 小时窗口，而窗口
   * 还开着的时候再发一条，既开不出新窗口，也换不来新的重置时刻——白费一次额度，
   * 还把这个账户的节奏整体往后拖。只有确实没有窗口在计时（额度是满的），这一发才有意义。
   *
   * 挑窗口与取数的口径都和 replan 一致：nextSendWindow 已按门槛排好序（有窗口用满就先
   * 还它，没有才轮到 5 小时窗口），窗口本身优先取库里那份，见 currentWindows。挑出来的
   * 还要过 isThresholdWindow 和 hasStarted 两道——管不着这一发的窗口（例如这一刻上游只
   * 报得出周窗口）会把第一拍推到好几天后；而没开始计时的窗口恰恰说明额度是满的，这一发
   * 正该发出去。hasStarted 的容差读不出刚开一分钟内的窗口，因此再拿上次发送时刻兜一道。
   *
   * 返回 null 表示没有窗口挡着——既可能是真没在计时，也可能是从没查过，两者都按「该发」
   * 处理：漏发一次的代价是窗口白关，多发一次只是提前开窗，前者更糟。
   */
  private async startupWindow(worker: Worker): Promise<Window | null> {
    const { windows, observedAt } = await this.currentWindows(worker.account);
    const counting = nextSendWindow(windows, Date.now());
    if (counting === null || !isThresholdWindow(counting)) return null;

    const windowMs = (counting.windowMinutes ?? 0) * 60_000;
    const sentWithin = Date.now() - (this.store.getState(worker.account.id)?.lastSentAt ?? 0) < windowMs;
    return hasStarted(counting, observedAt) || sentWithin ? counting : null;
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
    // 占位要抢在任何 await 之前：读账户目录是异步的，守卫和这一行之间一旦让出线程，
    // 界面上连点两次启动就会各起一套 worker，先起的那套没人 abort 得掉，同一个账户
    // 两条循环并发发送，而日志里看不出任何异常。同理，start 途中点 stop 也不会被无视。
    const abort = new AbortController();
    this.abort = abort;
    // 中途放弃时把占位撤掉，否则界面会一直显示“运行中”，而其实一个 worker 都没有
    const bail = (message: string): void => {
      this.log('error', '', message);
      if (this.abort === abort) this.abort = null;
    };

    try {
      setProxy(this.config.proxy, this.config.noProxy);
    } catch (err) {
      // 用户明明要求走代理却退回直连，比根本不启动更糟
      bail(`代理配置无效，未启动: ${(err as Error).message}`);
      return;
    }
    this.log('info', '', `出站代理: ${getProxy() || '直连'}`);

    const schedulable = selectSchedulable(await loadAccounts(ACCOUNTS_DIR), this.config);
    // 这期间用户可能已经点了停止，那就到此为止，别再把 worker 铺开
    if (abort.signal.aborted) return;
    if (schedulable.length === 0) {
      bail(`在 ${ACCOUNTS_DIR} 下没有找到可保活的账户，请先导入或登录`);
      return;
    }
    const wanted = new Set(ids);
    const accounts = wanted.size > 0 ? schedulable.filter((a) => wanted.has(a.id)) : schedulable;
    if (accounts.length === 0) {
      bail('选中的账户都不能保活（Qoder 或被 include/exclude 排除），未启动');
      return;
    }

    this.startedAt = Date.now();
    this.workers = new Map(accounts.map((a) => [a.id, newWorker(a)]));

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

    const signal = abort.signal;
    this.loops = [...this.workers.values()].map((w) =>
      this.runAccount(w, signal).catch((err) => {
        w.state = 'error';
        w.lastError = String(err);
        this.log('error', w.account.id, `异常退出: ${String(err)}`);
      }),
    );

    void Promise.all(this.loops).then(() => {
      // 认准自己这一轮：期间可能已经停过又起过一轮，那一轮不该被这里收尾
      if (this.abort === abort) {
        this.log('info', '', '全部账户结束');
        this.abort = null;
        void this.broadcast();
      }
    });

    await this.broadcast();
  }

  async stop(): Promise<void> {
    const abort = this.abort;
    if (!abort) return;
    abort.abort();
    this.abort = null;
    // running 要立刻变假，但这一轮的取消信号还得留着：收尾期间点「测试文本」发出去的
    // 那一发也该跟着停，而那时 this.abort 已经空了，见 sendNow
    this.stopping = abort;
    // 认准自己这一轮的 worker：等循环收尾期间用户可能已经重新点了启动，那时 this.workers
    // 装的是新一轮的对象，照着它标 stopped 会把刚跑起来的账户在界面上写成已停止
    const stopping = this.workers;
    try {
      await Promise.allSettled(this.loops);
      for (const w of stopping.values()) w.state = 'stopped';
      // 同一个理由的另一半：收尾期间用户重新点了启动的话，this.abort 已经是新一轮的了。
      // 那时「已停止」这句和下面那次推送说的都是上一轮的事，而界面上正跑着新一轮——
      // 照发只会让人以为刚起来的这一轮又停了。新一轮自己会推它的状态，这里交给它
      if (this.abort !== null) return;
      this.log('info', '', '已停止');
      // 合并中的那次推送作废：下面这一次带的是停稳之后的状态，才是该留在界面上的那份
      if (this.broadcastTimer !== null) clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
      this.broadcastPending = false;
      // 已经在读磁盘的那一次拦不住，只能等它落地——否则它带着「运行中」的快照后到，
      // 界面会停在一个早已不成立的状态上
      await this.broadcasting;
      await this.broadcast();
    } finally {
      if (this.stopping === abort) this.stopping = null;
    }
  }

  /** 单个账户的完整生命周期；直到被停止，或该账户自己放弃为止。 */
  private async runAccount(worker: Worker, signal: AbortSignal): Promise<void> {
    const { account } = worker;

    // 重启恢复：如果 store 记录还没到点，就继续等，不要重新开一个新窗口
    const persisted = this.store.getState(account.id);
    const persistedDue = persisted?.nextDueAt ?? 0;
    let due: number;

    if (persistedDue > Date.now()) {
      worker.plannedRaw = persistedDue;
      // 这一拍当初是照哪个窗口排的，库里还记着；不接回来的话，等待期第一次核对必定判
      // 「变了」，于是拿一份没动过的窗口重摇一次抖动，白改一次期还要在日志里说一声。
      // planned_reset_at 是和 next_due_at 一起写的；老库里没有这一列，退回 last_reset_at，
      // 它多数时候就是同一个时刻，只是可能已被之后的某次额度查询覆盖成别的窗口
      worker.plannedResetAt = persisted?.plannedResetAt || persisted?.lastResetAt || 0;
      due = this.frameIntoWindow(account.id, persistedDue);
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
        worker.plannedRaw = Date.now() + this.startupStaggerMs();
        due = this.frameIntoWindow(account.id, worker.plannedRaw);
      }
    }
    if (due > Date.now()) {
      worker.state = 'waiting';
      this.store.setNextDue(account.id, due, worker.plannedResetAt);
      this.log('info', account.id, `等待至 ${new Date(due).toLocaleString()}`);
      this.notify();
    } else if (persistedDue > 0) {
      this.store.setNextDue(account.id, 0);
    }

    while (!signal.aborted) {
      const fired = await this.waitForDue(worker, due, signal);
      if (fired === null) return;
      due = fired;

      // 到点了先确认这个账户还在调度范围内，再决定发不发，见 syncFromDisk。
      // 顺带把磁盘上更新的令牌也接了过来，所以 sendOnce 里不必再读一遍。
      const retired = await this.syncFromDisk(account.id);
      // 这期间可能已经停过又起过一轮，那时 this.workers 装的是新一轮的对象，
      // 照着它删会把刚跑起来的同名账户从新一轮里摘掉
      if (signal.aborted) return;
      if (retired !== null) {
        // 不清 nextDue：被排除的账户日后再放回来时，接着原来的节奏比重开一个窗口好
        this.workers.delete(account.id);
        worker.state = 'stopped';
        this.log('info', account.id, `${retired}，退出本次调度`);
        this.notify();
        return;
      }

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

      // sendOnce 刚在这一拍里核对过、答的又是「不是额度问题」，中间还没隔过一轮退避
      // （maxRetries 配成 1 时正是如此），那再问一遍必然是同一份答案，见 quotaProbedAt。
      // 它那次用的判据只会比这里更宽松（429 时认任何未到点的窗口），返回了 null 就说明
      // 这里问也是 null，跳过是安全的
      const askedJustNow =
        outcome.quotaProbedAt > 0 && Date.now() - outcome.quotaProbedAt < QUOTA_PROBE_REUSE_MS;
      if (!outcome.giveUp && !askedJustNow && (resetAt === null || resetAt <= Date.now())) {
        // 判成失败之前，最后去额度接口核对一次：只要 5 小时或周窗口里还有一个没到点，
        // 这一发发不出去就是意料之中的事，等到那一刻再发即可。把「额度还没重置」当成
        // 故障，账户会在界面上标成连着失败，下一拍也排到退避上去，而不是那个重置时刻。
        //
        // 信到什么程度要看这一发出去了没有，见 SendOutcome.sent：发出去了只是没读到
        // 窗口，那就得排出下一拍；重试耗尽的那种则只认用满的窗口，否则真故障会被装扮
        // 成等额度——而那条路上失败计数还会被清零，保活断了也没人知道。
        const pending = await this.quotaReset(account, outcome.sent);
        if (pending !== null) resetAt = this.noteLimited(worker, pending, '额度尚未重置');
      }

      if (resetAt === null || resetAt <= Date.now()) {
        // giveUp 那几种（认证被拒、这个 provider 本来就不发）等到什么时候都一样发不出去，
        // 只能停下来叫人；sendOnce 已经把话说清楚了，别拿通用措辞盖掉它
        if (outcome.giveUp) {
          worker.state = 'error';
          this.store.setNextDue(account.id, 0);
          this.log('error', account.id, worker.lastError);
          this.notify();
          return;
        }
        // 其余的（重试耗尽、窗口读不出来）等下一个周期再发一次就是了，见 waitAfterFailure
        due = this.waitAfterFailure(worker);
        continue;
      }
      worker.failWaits = 0;

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

  /**
   * 照某个窗口的重置时刻排下一拍：加上缓冲与抖动，再顺延到每日窗口之内。
   *
   * 每次都重读窗口配置，界面上改完的每日时段才能从下一拍开始生效。
   * 同时记下这一拍的依据（plannedResetAt），等待期间重新核对时要拿它比对。
   */
  private planFrom(worker: Worker, resetAt: number): { due: number; raw: number } {
    const raw = resetAt + this.config.bufferSeconds * 1000 + this.jitterMs();
    const due = this.frameIntoWindow(worker.account.id, raw);
    worker.plannedResetAt = resetAt;
    worker.plannedRaw = raw;
    this.store.setNextDue(worker.account.id, due, resetAt);
    return { due, raw };
  }

  /**
   * 睡到 `due`；等待期间不碰网络，只认已经摆在手边的新消息。
   *
   * 排下一拍用的是排那一刻看到的窗口，而窗口自己是会动的：周额度是滚动窗口，等着等着
   * 就会放出一部分；上游也会主动重置。一睡到底的代价是明明一小时后就能发的账户，在那儿
   * 干等一天多——保活最该避免的正是这个。但这条循环自己不去问上游：同一份数据后台刷新
   * 已经在按周期取了，两边各查各的只会给上游的限流计数白加一笔。改期因此只有两个由头，
   * 两个都不需要新的上游调用：
   *
   *   - 每日时段变了：用户在界面上说改就改，每醒来一次都拿它重框一遍，见 reclamp；
   *   - 库里的额度数据换了一份：后台定时刷新刚写完一轮、界面上点过「查询额度」，
   *     或者这个账户刚发完一拍，直接用现成的成果重排，见 replan。
   *
   * 代价是后台刷新关掉（周期设为 0）或正处在每日时段外时，没人替等着的账户发现上游悄悄
   * 放宽了额度，得等这一拍到点发出去才纠正回来。想立刻纠正就在界面上点一次「查询额度」。
   *
   * 返回真正到点的时刻（可能已经改过期），被取消时返回 null。
   */
  private async waitForDue(worker: Worker, due: number, signal: AbortSignal): Promise<number | null> {
    let seenUsageAt = this.store.getState(worker.account.id)?.usageCheckedAt ?? 0;
    while (!signal.aborted) {
      // 醒来先重框再判到点：反过来的话，睡到 due 的那一次会直接发出去，
      // 而这一觉中间时段可能刚被改窄，这一拍正该被挪走
      due = this.reclamp(worker, due);
      if (Date.now() >= due) return due;
      // 到点和下一次时段核对，谁先到就停在谁那儿
      const checkpoint = Math.min(due, Date.now() + this.windowTickMs);
      // 睡着期间被 usageChanged 叫醒的话，不等这一片睡完就回到循环顶上重新判一遍。
      // 取消和叫醒共用一套信号，因此醒来要分清是哪一种：真停了才返回 null
      if (!(await sleepUntil(checkpoint, AbortSignal.any([signal, worker.wake.signal])))) {
        if (signal.aborted) return null;
      }

      // 循环外面塞进来的改期（目前只有界面上的「测试文本」），见 Worker.pendingPlan
      const pending = worker.pendingPlan;
      if (pending !== null) {
        worker.pendingPlan = null;
        due = this.adoptPlan(worker, pending, due);
        continue;
      }

      const usageAt = this.store.getState(worker.account.id)?.usageCheckedAt ?? 0;
      if (usageAt > seenUsageAt) {
        due = await this.replan(worker, due);
        seenUsageAt = this.store.getState(worker.account.id)?.usageCheckedAt ?? usageAt;
      }
    }
    return null;
  }

  /**
   * 库里的额度数据换了一份：让等着的那几条循环立刻去看一眼。
   *
   * 后台定时刷新和界面上的「查询额度」查完都要叫一声。不叫醒也不会漏掉——下一次醒来
   * （最迟一分钟）照样会看见；但点按钮的人正盯着卡片，「立刻纠正」和「一分钟后纠正」
   * 在他那儿是两回事。叫醒本身不碰网络，改期用的还是刚写进库的那份成果，见 waitForDue。
   *
   * `accountIds` 为空表示刚查的是全部账户。
   */
  usageChanged(accountIds: readonly string[] = []): void {
    const wanted = accountIds.length > 0 ? new Set(accountIds) : null;
    for (const [id, worker] of this.workers) {
      if (wanted !== null && !wanted.has(id)) continue;
      // 先换上新的再叫：这一声过后开关就作废了，留着它下次谁也叫不动
      const wake = worker.wake;
      worker.wake = new AbortController();
      wake.abort();
    }
  }

  /**
   * 采纳一个从循环外面来的重置时刻。
   *
   * 界面上点「测试文本」发出去的那一发是真的会打开 5 小时窗口的。不告诉正在等的 worker，
   * 卡片上的「下次发送」就一直是旧的那个，真到点了还会再发一条——而那一条只会被上游顶
   * 回来，白花一次额度。
   */
  private adoptPlan(worker: Worker, resetAt: number, due: number): number {
    const { due: next } = this.planFrom(worker, resetAt);
    if (Math.abs(next - due) < REPLAN_EPSILON_MS) return next;
    this.log(
      'info',
      worker.account.id,
      `刚手动发过一条，下一次发送改到 ${new Date(next).toLocaleString()}` +
        `（原定 ${new Date(due).toLocaleString()}）`,
    );
    this.notify();
    return next;
  }

  /**
   * 用当前的每日时段重新框一次这一拍。
   *
   * 排这一拍用的是排那一刻的时段，而时段是用户随时会改的：改窄了，原本排在 14:00 的那一拍
   * 照样在 14:00 发出去，落在窗口外；改宽了，被顺延到明天早上的那一拍其实现在就该发。两种
   * 情况都不该等到「上游窗口恰好也动了一次」，才被 replan 顺手纠正过来。
   *
   * 框的是 plannedRaw（顺延之前的原始时刻）而不是 due：拿 due 去框，一个已经顺延过的
   * 时刻会被当成它本来就该在明天早上发，时段放宽了也纹丝不动。原始时刻已经过去时
   * （补发的那一拍，或者时段刚被放宽）按当下重开一次窗口。
   */
  private reclamp(worker: Worker, due: number): number {
    // 还没排过（理论上到不了这里）就别自作主张，照原计划等着
    if (worker.plannedRaw <= 0) return due;
    const now = Date.now();
    const framed = this.frameIntoWindow(worker.account.id, worker.plannedRaw);
    const next = framed >= now ? framed : this.frameIntoWindow(worker.account.id, now);
    if (Math.abs(next - due) < REPLAN_EPSILON_MS) return due;

    this.store.setNextDue(worker.account.id, next, worker.plannedResetAt);
    this.log(
      'info',
      worker.account.id,
      `每日时段已改，这一拍跟着挪到 ${new Date(next).toLocaleString()}` +
        `（原定 ${new Date(due).toLocaleString()}）`,
    );
    this.notify();
    return next;
  }

  /**
   * 拿最新的窗口重算下一拍；核对不出结果就按原计划继续等。
   *
   * 只在库里那份额度数据换了一份时才会被叫到（后台刷新刚写完一轮、界面上点了「查询额度」，
   * 或者刚发完一拍），因此读的窗口就是那份新数据，不必也不该为此再问一次上游。
   */
  private async replan(worker: Worker, due: number): Promise<number> {
    const { account } = worker;
    // 等令牌的那种等待不看额度：令牌都取不到，额度接口同样会拿 401 顶回来
    if (worker.tokenWaits > 0) return due;

    const { windows, observedAt, fresh } = await this.currentWindows(account);
    if (!fresh || windows.length === 0) return due;
    const target = nextSendWindow(windows, Date.now());
    if (target === null || Math.abs(target.resetAt - worker.plannedResetAt) < REPLAN_EPSILON_MS) {
      return due;
    }
    /*
      还没开始计时的窗口不是门槛：它报的「重置时刻」是从这次查询算起的一整个窗口，下次核对
      时又会往后挪同样多。照它改期，下一拍会被推得和时间流逝一样快，永远排不到——一次真实
      事故里，codex 账户就是这样从 06:00 一路被推到 12:06，整个上午一条都没发出去。

      它说的其实是反面的事：额度是满的，没有窗口在跑，而这一发正好用来把窗口打开。所以不
      光是别照它改期，索性把这一拍提前，现在就补一发。三道闸拦着别发过头：只提前不推后；
      距上次发送不足一个窗口就不补——万一哪天上游把正在计时的窗口也报成这个样子，最多每个
      窗口多发一条，不至于变成每核对一次发一条；上游明说了现在不许发，那也别补，补了也是
      白挨一次拒绝。
    */
    if (!hasStarted(target, observedAt)) {
      const windowMs = (target.windowMinutes ?? 0) * 60_000;
      if (Date.now() - (this.store.getState(account.id)?.lastSentAt ?? 0) < windowMs) return due;
      const raw = Date.now();
      const next = this.frameIntoWindow(account.id, raw);
      if (next >= due) return due;
      // 这一拍不是照窗口排的，等待期间没有什么可以拿来跟它比对，见 waitForToken 里同样的处理
      worker.plannedResetAt = 0;
      worker.plannedRaw = raw;
      this.store.setNextDue(account.id, next, 0);
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
    if (!isThresholdWindow(target) && target.resetAt > worker.plannedResetAt) return due;

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
      // 逐条看，而不是有一条过点就把整份新数据否决掉：窗口交替那一刻（5 小时窗口刚重置、
      // 上游还挂着旧的 resets_at）本来就会读到这种混合结果，把它当成「查询失败」会让账户
      // 转而沿用一份更旧的记录。过点的窗口交给 pendingOf 逐条滤掉即可——写回库的那份也
      // 照原样留着，界面和额度刷新（refreshOne）看到的才是同一份东西。
      const future = usage.windows.filter(
        (window) => Number.isFinite(window.resetAt) && window.resetAt > checkedAt,
      );
      if (!usage.ok || future.length === 0) {
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
   *   - 再不然只有 `trustAny`（上游明确说了触限，或者这一拍本来就无窗口可用）
   *     才退而求其次按常规节奏排。否则宁可判定「这不是额度问题」，让重试与失败计数
   *     照常走，免得把真正的故障装扮成等额度，一等就是几个小时。
   */
  private async quotaReset(account: Account, trustAny: boolean): Promise<Window | null> {
    const now = Date.now();
    // 失败之后要的是此刻的真相，因此总是现查一次；查不动才退回库里那份
    const windows =
      (await this.refreshWindows(account)) ?? this.store.getState(account.id)?.windows ?? [];

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
    const raw = Date.now() + backoffMs(this.config.retryBackoffSeconds, worker.tokenWaits, TOKEN_WAIT_MAX_MS);
    // 重试也是要发送的，同样不能落在每日窗口之外
    const due = this.frameIntoWindow(worker.account.id, raw);
    worker.tokenWaits++;
    // 这一拍不是照窗口排的，等待期间没有什么可以拿来跟它比对，见 replan
    worker.plannedResetAt = 0;
    worker.plannedRaw = raw;
    // 令牌拿不到不是「发送失败」，别让它累进界面上那个连续失败计数
    this.store.clearFailures(worker.account.id);
    this.store.setNextDue(worker.account.id, due, 0);
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
   * 这一拍发不出去，但还没到该停掉账户的地步：过一阵子重来。
   *
   * 认证被拒、provider 本来就不发送那几种要人来处理（见 giveUp），剩下的多半是上游 5xx、
   * 网络抖了一下，或者这一刻谁都给不出窗口——它们等一等自己会好，而「停掉」不会：账户一停，
   * 保活就断到有人发现并手动重启为止，这恰恰是最不容易被发现的一种断。
   *
   * 间隔逐次翻倍（封顶 FAIL_WAIT_MAX_MS，也就是一个周期），真坏了不至于一直去撞上游。
   * 失败计数照常留着不清——界面上要看得见这个账户连着失败了多少次。
   * 返回下一拍时刻，好让调用方直接接着排。
   */
  private waitAfterFailure(worker: Worker): number {
    // 拿不到窗口这一路上并没有留下错误，可账户确实没发出去，得给它一句话
    const reason = worker.lastError || '未取得限额窗口重置时间';
    worker.lastError = reason;
    const raw =
      Date.now() + backoffMs(this.config.retryBackoffSeconds, worker.failWaits, FAIL_WAIT_MAX_MS);
    // 重来也是要发送的，同样不能落在每日窗口之外
    const due = this.frameIntoWindow(worker.account.id, raw);
    worker.failWaits++;
    // 这一拍不是照窗口排的，等待期间没有什么可以拿来跟它比对，见 replan
    worker.plannedResetAt = 0;
    worker.plannedRaw = raw;
    this.store.setNextDue(worker.account.id, due, 0);
    worker.state = 'waiting';
    this.log(
      'error',
      worker.account.id,
      `${reason}；${new Date(due).toLocaleString()} 再试一次，调度不停`,
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
    // 额度没到点不是失败；计进去的话，一个完全健康的账户几轮之后就会在界面上
    // 挂着一串「连续失败」，真出故障时反倒看不出来
    this.store.clearFailures(worker.account.id);
    const capped = cappedResetAt(window, Date.now());
    const pct = window.usedPercent === null ? '' : ` | 已用 ${window.usedPercent.toFixed(0)}%`;
    this.log(
      'info',
      worker.account.id,
      `${reason}（${window.name}${pct}），窗口重置 ${new Date(window.resetAt).toLocaleString()}` +
        (capped < window.resetAt
          ? `；这条窗口管不着这一发，下一拍按 5 小时封顶到 ${new Date(capped).toLocaleString()}`
          : ''),
    );
    return capped;
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
    let quotaProbedAt = 0;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      if (signal.aborted) return noSend(false, quotaProbedAt);

      const fresh = await ensureFresh(account, (lvl, msg) => this.log(lvl, account.id, msg));
      if (!fresh) {
        // 令牌拿不到就是拿不到，重试几次也一样；等它续期是调用方的事，见 waitForToken
        worker.lastError = account.autoRefresh ? 'token 刷新失败' : 'token 已过期，等客户端续期';
        return {
          resetAt: null, limitedBy: null, giveUp: false, needsToken: true, sent: false, quotaProbedAt,
        };
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
        // 响应里只有周窗口这类兜底时，不能凭它把下一拍推到几天后，见 cappedResetAt
        const resetAt = window === null ? null : cappedResetAt(window, result.sentAt);
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
          } else if (resetAt !== null && resetAt < window.resetAt) {
            this.log(
              'warn',
              account.id,
              `响应里只有 ${window.name} 窗口，它管不着这一发；下一拍按 5 小时封顶，届时会重新问一次`,
            );
          }
        } else {
          this.log('info', account.id, '发送成功，但响应未带限额信息');
        }
        return { resetAt, limitedBy: null, giveUp: false, needsToken: false, sent: true, quotaProbedAt };
      }

      // 429 自带重置时间，因此不算真正失败；它本身就能决定下一拍时间
      if (result.status === 429 && window) {
        return {
          resetAt: this.noteLimited(worker, window, '已触限'),
          limitedBy: window,
          giveUp: false,
          needsToken: false,
          sent: false,
          quotaProbedAt,
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
        quotaProbedAt = Date.now();
        if (pending !== null) {
          return {
            resetAt: this.noteLimited(worker, pending, '额度尚未重置'),
            limitedBy: pending,
            giveUp: false,
            needsToken: false,
            sent: false,
            quotaProbedAt,
          };
        }
      }

      if (attempt < this.config.maxRetries) {
        const backoff = backoffMs(this.config.retryBackoffSeconds, attempt - 1, RETRY_BACKOFF_MAX_MS);
        this.log(
          'warn',
          account.id,
          `第 ${attempt} 次失败 (${lastError.slice(0, 120)})，${(backoff / 1000).toFixed(0)}s 后重试`,
        );
        if (!(await sleepUntil(Date.now() + backoff, signal))) return noSend(false, quotaProbedAt);
      }
    }

    this.log('error', account.id, `重试耗尽: ${lastError.slice(0, 200)}`);
    return noSend(false, quotaProbedAt);
  }

  /**
   * UI 中“测试文本”按钮对应的动作。
   *
   * 它不打乱调度节奏，但也不能瞒着调度器：这一发是真的会打开 5 小时窗口的，正在等的
   * worker 得照新窗口把下一拍挪一挪，见 Worker.pendingPlan。
   */
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
    // 上面那次 loadAccounts 已经把磁盘上的账户读回来了，顺手对一次账：别处换到的新令牌
    // 要交给正在跑的 worker，否则它下一拍还攥着已经作废的那份（见 adoptNewer）
    this.adoptNewer(account);
    // 单独一份 Worker：sendOnce 会往里写 lastError，借用正在跑的那个会把调度循环的
    // 状态覆盖掉。account 仍取 worker 手里那份——它带着运行中刚换到的令牌，比磁盘上的新。
    const live = this.workers.get(accountId);
    const worker = newWorker(live?.account ?? account);

    // 停止调度时这一发也要跟着停：重试退避最长能占用好几分钟，不然 stop() 返回之后
    // 还有一发在飞
    const controller = new AbortController();
    // 收尾中的那一轮也算数：那时 this.abort 已经空了，可停止确实已经发生，见 stop
    const stopSignal = (this.abort ?? this.stopping)?.signal;
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
    // 这一发换来的窗口交给正在等的那条循环，它下次醒来（最多一分钟）就照它重排。
    // 只交给在等的：正在发的那条紧接着会拿自己那一发的窗口排，不该被这里盖掉
    if (live?.state === 'waiting' && resetAt !== null) live.pendingPlan = resetAt;
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
 * 睡到 `deadline`（绝对时刻）为止；如果中途被取消则返回 false。
 * 按分片反复重算，而不是只挂一个超长 setTimeout，才能扛住系统休眠和时钟校正。
 */
export async function sleepUntil(
  deadline: number,
  signal: AbortSignal,
  tickMs = TICK_MS,
): Promise<boolean> {
  while (!signal.aborted) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return true;

    if (!(await sleep(Math.min(remaining, tickMs), signal))) return false;
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
