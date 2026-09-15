/**
 * API 服务（多账号转发路由）的共享类型契约。
 *
 * 这条路和保活调度是两件事，只是共用同一批账户：调度器**按窗口节奏替账户发一条最小请求**，
 * 而网关是**替用户的真实请求找一个还有额度的账户**。因此两边的「可用」判定不同——
 * 调度看的是下一拍什么时候到，网关看的是这个账户现在还能不能接活。
 */

/** 账号池的挑选方式。 */
export type GatewayStrategy = 'fill-first' | 'round-robin';

/**
 * 网关的全局配置，随 AppConfig 一起存进 config.json。
 *
 * 默认不开：装上这个程序的人未必想在本机开一个能花掉全部额度的端点，
 * 这件事必须由用户自己按一下。
 */
export interface GatewayConfig {
  enabled: boolean;
  /**
   * 访问网关要带的 key（`Authorization: Bearer` 或 `x-api-key`）。
   * 为空表示不校验 key，此时只接受来自本机回环地址的请求——一个没有 key 又对外监听的
   * 转发端点，等于把账号池里的全部额度公开出去。
   */
  apiKeys: string[];
  strategy: GatewayStrategy;
  /** 一次客户端请求最多换几个账户重试；换的是账户，不是把同一个再试一遍。 */
  maxAttempts: number;
  /** 连续失败几次后让账户进冷却。 */
  maxConsecutiveFailures: number;
  /** 冷却时长，秒。 */
  cooldownSeconds: number;
  /**
   * 已用额度达到这个百分比就不再派活，把剩下的留给用户自己的客户端；
   * 100 表示只有上游明确说额度耗尽才停。
   */
  exhaustedPercent: number;
  /**
   * 请求的模型属于 A 家、池子里却只有 B 家账户时，允不允许转换协议后发给 B。
   * 默认不允许：模型能力和计费都不一样，静悄悄换一家比直接报错更难排查。
   */
  crossProvider: boolean;
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  enabled: false,
  apiKeys: [],
  strategy: 'fill-first',
  maxAttempts: 3,
  maxConsecutiveFailures: 3,
  cooldownSeconds: 60,
  exhaustedPercent: 100,
  crossProvider: false,
};

/** 单个账户在网关里的设置，存在状态库里。 */
export interface GatewayAccountSetting {
  /** 这个账户参不参与转发。默认不参与：额度是用户的，得他自己点一下。 */
  enabled: boolean;
  /** 越大越先被派活；同值时按已用额度少的优先。 */
  priority: number;
}

export const DEFAULT_ACCOUNT_SETTING: GatewayAccountSetting = { enabled: false, priority: 0 };

/** 单个账户的转发统计，累计值，存在状态库里。 */
export interface GatewayAccountStat {
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  /** 最近一次被派活的时刻，毫秒时间戳；从未派过时为 0。 */
  lastUsedAt: number;
}

export const EMPTY_STAT: GatewayAccountStat = {
  requests: 0,
  failures: 0,
  inputTokens: 0,
  outputTokens: 0,
  lastUsedAt: 0,
};

/**
 * 账户此刻在网关里的状态。
 *
 * - `off`：用户没让它参与。
 * - `ready`：随时可以接活。
 * - `busy`：正在处理转发请求（仍然可以再接，这里只是给界面看的）。
 * - `cooling`：连续失败太多，暂时不派活。
 * - `exhausted`：已用额度过了阈值，或上游明说耗尽。
 * - `unusable`：账户被禁用，或这个 provider 根本不支持转发。
 */
export type GatewayAccountState = 'off' | 'ready' | 'busy' | 'cooling' | 'exhausted' | 'unusable';

/** 卡片上展示的那一块网关信息。 */
export interface GatewayAccountView extends GatewayAccountSetting, GatewayAccountStat {
  state: GatewayAccountState;
  /** 正在处理的转发请求数。 */
  inFlight: number;
  /** 冷却结束时刻，毫秒时间戳；没在冷却时为 null。 */
  cooldownUntil: number | null;
  /** 最近一次转发失败的原因；成功一次就清空。 */
  lastError: string;
  /** 这个 provider 支不支持转发；不支持时 state 恒为 unusable。 */
  supported: boolean;
  /**
   * 转发是否需要在卡片上单独设一个 PAT。只有 Qoder 是这样：它转发用的不是导入登录那份
   * 令牌，而是账户页面单独申请的 PAT。Claude / Codex 用登录令牌直接转发，这里为 false。
   */
  needsPat: boolean;
  /** 是否已经设过 PAT。needsPat 为 false 时无意义，恒为 false。 */
  hasPat: boolean;
}

/**
 * 能用于转发的 provider。
 *
 * Qoder 也在其中：它的推理端点确实要求每个请求带一份客户端原生签名（官方 IDE 里由内置的
 * signer 产生），而那份签名的产生逻辑被抽成了一段 WASM，本程序进程内跑它就能算出来（见
 * server/gateway/qoder-signer.ts），因此 Qoder 账户可以和 Claude / Codex 一样对外转发。
 * 只是它转发用的不是导入登录时那份 OAuth 令牌，而是账户页面上单独设置的 PAT——两者是
 * 相互独立的凭证。
 *
 * 这里用 string 而不是 Provider 类型：types.ts 已经 import 了这个文件，反过来再 import
 * 回去就成环了，而这一条判断本来也不需要认识那套枚举。
 */
export const FORWARDABLE_PROVIDERS: readonly string[] = ['claude', 'codex', 'qoder'];

export function isForwardable(provider: string): boolean {
  return FORWARDABLE_PROVIDERS.includes(provider);
}

/** 这个 provider 转发时要不要单独设 PAT。目前只有 Qoder。 */
export function needsPat(provider: string): boolean {
  return provider === 'qoder';
}

/** 没开网关、或这个 provider 压根不支持转发时，卡片上该看到的那一块。 */
export function offGatewayView(provider: string): GatewayAccountView {
  return {
    ...DEFAULT_ACCOUNT_SETTING,
    ...EMPTY_STAT,
    state: isForwardable(provider) ? 'off' : 'unusable',
    inFlight: 0,
    cooldownUntil: null,
    lastError: '',
    supported: isForwardable(provider),
    needsPat: needsPat(provider),
    hasPat: false,
  };
}

/** 网关整体状态，界面上用来告诉用户「接到哪里、带什么 key」。 */
export interface GatewayStatus {
  enabled: boolean;
  /** 形如 `http://127.0.0.1:8686`，直接给客户端当 base URL 用。 */
  baseUrl: string;
  /** 打开了转发开关的账户数。 */
  enabledAccounts: number;
  /** 其中此刻真能接活的账户数。 */
  readyAccounts: number;
  /** 有没有配置 key；具体的 key 不从这里返回。 */
  keyRequired: boolean;
}
