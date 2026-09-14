/** 服务端与前端共享的类型契约。 */

/**
 * 会被调度的 provider：有滚动限额窗口，所以保活才有意义。
 * 模型选择、登录、发送这几处都只对它们成立。
 */
export type SendProvider = 'claude' | 'codex';

/**
 * 全部 provider。
 *
 * Qoder 卖的是按订阅周期发放的 credits，用完为止，没有会自己重置的 5 小时窗口——
 * 保活对它没有任何意义，因此这类账户只做导入与只读额度展示，不进调度器。
 */
export type Provider = SendProvider | 'qoder';

/**
 * 本机某个客户端此刻登录着的那个账户。
 *
 * 「这台电脑现在用的是哪个账户」只写在客户端自己的凭证文件里，服务端定时核对一遍
 * （见 server/inuse.ts），界面据此在账户列表上标出来。
 */
export interface ClientUse {
  /** 客户端标识，例如 'claude-cli'。 */
  source: string;
  /** 客户端展示名，例如 'Claude Code'。 */
  label: string;
  /** 核对的是哪个凭证文件。 */
  path: string;
  /** 认出来的账户 id；它登录的账户不在本程序的账户目录里时为空串。 */
  accountId: string;
  /** 它登录的是谁，邮箱优先；认不出来时为空串。 */
  who: string;
  /** 凭证读不出来时的原因；读到了就是空串。 */
  error: string;
}

export interface AccountView {
  id: string;
  provider: Provider;
  email: string;
  disabled: boolean;
  /** 订阅套餐，例如 'plus'；上游和 token 都未提供时为空。 */
  plan: string;
  /** 付费周期结束时间，毫秒时间戳；未知时为 null。 */
  subscriptionEndsAt: number | null;
  /** 上游自己的用户 ID，用于区分邮箱相同但实际不同的账户。 */
  userId: string;
  /** 账户登录方式，例如 'Google'、'Password'。 */
  loginMethod: string;
  /** access_token 到期时间，毫秒时间戳。 */
  tokenExpiresAt: number;
  /** 当前 5 小时窗口的重置时刻，毫秒时间戳；未知时为 null。 */
  windowResetAt: number | null;
  /** 下一次计划发送时刻，毫秒时间戳。 */
  nextDueAt: number | null;
  lastSentAt: number | null;
  usedPercent: number | null;
  /** 重置时间的来源，用于排障。 */
  windowSource: string;
  /** 上游最近一次返回的全部限额窗口，不仅仅是 5 小时窗口。 */
  windows: Window[];
  /** 最近一次额度查询成功的时刻，毫秒时间戳；从未成功时为 null。 */
  usageCheckedAt: number | null;
  /** ChatGPT 侧“重置用量”剩余次数；上游未报告时为 null。 */
  resetCredits: number | null;
  /** 最早过期的那张重置次数的过期时刻，毫秒时间戳；未知时为 null。 */
  resetCreditsExpiresAt: number | null;
  /** 该账户凭证的来源，例如 'codex-cli'、'oauth'。 */
  source: string;
  /**
   * 是否由本程序自己刷新令牌。
   * 为 false 即“跟随客户端”：只用同步过来的令牌查接口，续期交给原客户端。
   */
  autoRefresh: boolean;
  /** 跟随模式下取新令牌的文件；为空表示没有可同步的来源。 */
  syncPath: string;
  /**
   * “同步到用户配置文件”会写入的那些文件；Codex 会同时写官方 CLI 和 OpenCode 两处。
   * 为空表示这个账户没有可写回的客户端（Qoder 的凭证在加密的 state.vscdb 里）。
   */
  syncTargets: string[];
  /**
   * 本机哪些客户端此刻正用着这个账户；为空表示这台电脑当前没在用它。
   * 由定时核对刷新，见 server/inuse.ts。
   */
  inUseBy: ClientUse[];
  /** 上一次核对本机客户端的时刻，毫秒时间戳；还没核对过时为 null。 */
  inUseCheckedAt: number | null;
  consecutiveFailures: number;
  state: 'idle' | 'waiting' | 'sending' | 'stopped' | 'error';
  lastError: string;
}

export interface SchedulerStatus {
  running: boolean;
  startedAt: number | null;
  /** 当前生效的每日窗口，本地时间格式为 'HH:MM'。 */
  dailyStart: string;
  dailyEnd: string;
  /** 当前时刻是否落在今天的窗口内。 */
  withinWindow: boolean;
  /** 当前窗口关闭时刻，或下一个窗口开启时刻；全天运行时为 null。 */
  windowEdgeAt: number | null;
  /**
   * 本次启动真正纳入调度的账户 id；未运行时为空数组。
   * 启动时可以只选一部分账户，因此“有哪些在跑”不能再从账户列表推出来。
   */
  accountIds: string[];
}

export interface AppConfig {
  /** 每一轮发送的自定义文本。 */
  text: string;
  /**
   * 每天重复的发送时间窗口，使用本地时间 'HH:MM' 表示。
   * 结束早于开始表示跨零点；两端相等表示全天。
   */
  dailyStart: string;
  dailyEnd: string;
  /** 重置时刻之后额外等待的秒数，用来避开边界抖动。 */
  bufferSeconds: number;
  /** 随机抖动，避免多个账户在同一秒同时触发。 */
  jitterSeconds: number;
  maxRetries: number;
  retryBackoffSeconds: number;
  models: Record<SendProvider, string>;
  /**
   * 后台自动刷新额度的间隔，单位分钟。
   * 设为 0 表示关闭自动刷新，只保留手动“查询额度”按钮。
   * 只在每日时段内刷新：时段外没有账户会发送，卡片上的数字也就没人看，
   * 没必要为它整夜打上游的额度接口。
   */
  usageRefreshMinutes: number;
  /**
   * 核对本机客户端在用哪个账户的间隔，单位分钟。
   * 设为 0 表示不再核对，账户列表上的「本机在用」标记就停在最后一次的结果上。
   */
  clientCheckMinutes: number;
  /** 按邮箱子串筛选；include 为空表示包含全部账户。 */
  include: string[];
  exclude: string[];
  /** 需要时使用的代理 URL，例如 http://127.0.0.1:7897。 */
  proxy: string;
  /** 按 NO_PROXY 语义配置的直连主机规则；proxy 为空时忽略。 */
  noProxy: string[];
  /**
   * 进程起来之后自动把调度跑起来。
   *
   * 记的是用户的意图，不是进程的状态：只有界面上的启动/停止会改它，收到 SIGTERM 时
   * 内部那次 stop() 不碰。反过来的话，systemd 重启前的那次 SIGTERM 会先把它关掉，
   * 重启之后就再也不会自己跑起来——恰好是这个开关要解决的那件事。
   *
   * 保活服务被 `Restart=always` 拉起来却停在那儿不发送，是最不容易被发现的一种断，
   * 因为界面上的「下次发送」倒计时照走不误。
   */
  autoStart: boolean;
  /**
   * 自动启动时纳入哪些账户，空数组表示全部可保活账户。
   *
   * 跟着 autoStart 一起记，是因为「只跑选中的几个」是用户明确挑过的：重启之后悄悄
   * 扩成全部，等于替他给没打算保活的账户也发了。
   */
  autoStartIds: string[];
}

export interface LogEntry {
  id: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  accountId: string;
  message: string;
}

/**
 * 一次真实发出的上游请求，原样保留下来供用户复现。
 * `headers` 里的令牌已经被换成占位符，见 shared/curl.ts。
 */
export interface RequestRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface RequestLogRow extends RequestRecord {
  id: number;
  accountId: string;
  sentAt: number;
  /** 上游状态码；0 表示连接都没建起来。 */
  status: number;
  durationMs: number;
  error: string;
  /**
   * 上游返回的正文（已解压、超长截断、凭证已抹）。
   * 流式请求只读到需要的地方就断开，因此这里可能只是开头的一截。
   */
  response: string;
}

/**
 * 请求日志一页。
 *
 * 行里的令牌是**占位符**——界面上照原样显示，屏幕和截图里都不会出现真令牌。
 * `secrets` 单独给出账户当前的凭证，只在用户点“复制”时用来把占位符换回真值，
 * 这样复制出去的 curl 依然可以直接重发。
 */
export interface RequestLogPage {
  rows: RequestLogRow[];
  secrets: { accessToken: string; refreshToken?: string };
}

/** 从上游解析出的单个限额窗口。 */
export interface Window {
  name: string;
  resetAt: number;
  usedPercent: number | null;
  windowMinutes: number | null;
  source: string;
  /** 已用量的绝对数值；只有 Qoder 这种按 credits 计费的上游会报告。 */
  used?: number;
  /** 额度总量的绝对数值；同上。 */
  total?: number;
  /** 上面两个数字的单位，例如 'credits'。 */
  unit?: string;
}

/** 一次手动「测试文本」的结果；批量测试按账户逐条返回。 */
export interface SendNowResult {
  accountId: string;
  ok: boolean;
  message: string;
}

/** 单个账户对只读额度查询的响应结果。 */
export interface UsageResult {
  accountId: string;
  provider: Provider;
  email: string;
  ok: boolean;
  status: number;
  error: string;
  /** 上游返回的订阅/套餐名称。 */
  plan: string;
  /** 付费周期结束时间，毫秒时间戳；上游未提供时为 null。 */
  subscriptionEndsAt: number | null;
  /** 上游自己的用户 ID。 */
  userId: string;
  /** ChatGPT 剩余“重置用量”次数；未报告时为 null。 */
  resetCredits: number | null;
  /** 最早过期的那张重置次数的过期时刻；未知时为 null。 */
  resetCreditsExpiresAt: number | null;
  /** Claude 组织类型（claude_max / claude_pro / …），来自官方 oauth/profile。 */
  orgType: string;
  /** Codex 服务端明确报告账户此刻是否可用；上游未报告或其他 provider 为 null。 */
  quotaAvailable: boolean | null;
  windows: Window[];
  /** 实际返回响应的 endpoint，用于排障。 */
  endpoint: string;
  /** 截断后的响应体原文；保留原样，便于上游改字段名时继续排查。 */
  raw: string;
  /**
   * 上游要求的下次重试时刻（毫秒时间戳）。
   * 只有额度接口自己限流（429）且带了 `retry-after` 时才有值——它管的是**接口**能不能
   * 再问，与账户的额度窗口无关，别和 windows 混起来。
   */
  retryAfterAt?: number | null;
}

/** 一处可导入的本地凭证来源。 */
export interface ImportCandidate {
  /** 来源标识。 */
  source: string;
  /** 该来源在本机的路径。 */
  path: string;
  /** 是否存在且可读。 */
  available: boolean;
  /** 在该来源中发现的账户，仅含展示所需字段。 */
  accounts: {
    id: string;
    provider: Provider;
    email: string;
    expiresAt: number;
    /** 导入后是否默认跟随该客户端续期，而不是由本程序刷新。 */
    followClient: boolean;
  }[];
  /** 不可用时的原因。 */
  error: string;
}

/** 客户端配置文件里被改写的一处内容。 */
export interface ConfigChange {
  /** 配置文件里的位置，例如 'claudeAiOauth.accessToken'。 */
  field: string;
  /** 改写前后的值；令牌类字段只保留头尾，界面和日志里都不会出现完整凭证。 */
  before: string;
  after: string;
}

/** 一次“同步到用户配置文件”里单个文件的结果，用户据此知道自己的文件被动了哪里。 */
export interface SyncToClientResult {
  /** 被写入的配置文件路径。 */
  path: string;
  /** 目标客户端标识，例如 'claude-cli'。 */
  source: string;
  /** 目标客户端展示名，例如 'Claude Code'。 */
  label: string;
  /** 该文件原先不存在，这次是新建的。 */
  created: boolean;
  /** 覆盖前留下的备份路径；新建或无改动时为空。 */
  backupPath: string;
  /** 逐项列出的改动；为空表示文件内容本来就和当前令牌一致，什么都没写。 */
  changes: ConfigChange[];
  /** 目标文件原先属于另一个账户时的提醒；没有这种情况时为空。 */
  warning: string;
  /** 这个文件写失败的原因；写成了就是空串。同一次同步里的其他文件不受影响。 */
  error: string;
}

/**
 * 一次续期方式切换的结果。
 *
 * 两个方向都会先核对「本机那个客户端现在登录的还是这个账户吗」，核对的结论未必是错误：
 * 改为跟随时对不上就直接拒绝，改为自动刷新时对得上反而要提醒一句——本程序一刷新，
 * 客户端手里那份就作废了。这两种话都放在 note 里，由界面原样展示。
 */
export interface AutoRefreshResult {
  id: string;
  autoRefresh: boolean;
  /** 切换成功后要补充说明的一句话；没什么要说的就是空串。 */
  note: string;
}

/** 一次手动更新 token 的结果。 */
export interface ForceRefreshResult {
  accountId: string;
  /** 新令牌的到期时间，毫秒时间戳。 */
  expiresAt: number;
}

/** 一次导入操作的结果。 */
export interface ImportResult {
  imported: string[];
  skipped: { id: string; reason: string }[];
}

/**
 * 登录方式。
 *
 * device 目前只有 Codex 支持：不依赖回调，用户在任意一台设备上打开官方页面输入一串
 * 验证码即可。浏览器和服务端不在同一台机器上时用它。
 */
export type LoginMode = 'redirect' | 'device';

/** 发起一次 OAuth 登录后返回给前端的信息。 */
export interface LoginStart {
  loginId: string;
  provider: Provider;
  /** 需要用户在浏览器里打开的授权地址。 */
  authorizeUrl: string;
  /** 授权完成后浏览器会跳到的地址；没有本地监听时用户要从地址栏复制它回来。 */
  redirectUri: string;
  /** 设备码流程里要用户手敲的验证码；其余流程为空。 */
  userCode: string;
  expiresAt: number;
  /** 本机是否已经起了回调监听。为 true 时用户不必手动粘贴。 */
  listening: boolean;
  /** 未能起监听时的原因，用来在界面上解释为什么仍要手动粘贴。 */
  listenError: string;
}

/** 下拉框里的一个模型选项。 */
export interface ModelOption {
  id: string;
  label: string;
}

/** 某个 provider 当前可选的模型，以及这份列表是不是真从上游问来的。 */
export interface ProviderCatalog {
  options: ModelOption[];
  /** false 表示用的是内置清单——账户查不到或者压根没有这类账户。 */
  fromUpstream: boolean;
  error: string;
}

export type ModelCatalog = Record<SendProvider, ProviderCatalog>;

/** 轮询一次登录的进展；只有开了本地监听时才需要用到。 */
export interface LoginStatus {
  state: 'pending' | 'done' | 'error' | 'expired';
  accountId: string;
  error: string;
  listening: boolean;
}

/** 通过 SSE 推送的事件类型。 */
export type ServerEvent =
  | { type: 'log'; entry: LogEntry }
  | { type: 'accounts'; accounts: AccountView[] }
  | { type: 'scheduler'; status: SchedulerStatus };

export interface StateResponse {
  version: string;
  scheduler: SchedulerStatus;
  accounts: AccountView[];
  config: AppConfig;
  /** 账户存放目录，由数据目录固定推导，界面只用来显示。 */
  accountsDir: string;
  /** 当前实际生效的代理；若 config.proxy 被拒绝，这里可能与配置值不同。 */
  proxy: string;
  /** 当前实际生效的忽略代理规则。 */
  noProxy: string[];
}
