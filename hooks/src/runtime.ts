/** OpenCode 事件入口：识别额度信号，交由 switcher 选择并同步账户。 */
import { quotaCheckOutcome, switchAccount, type SwitchOptions, type SwitchResult } from './switcher.js';
import type { Window } from './types.js';
import { queryHookUsage } from './usage.js';
import { classifyQuotaSignal } from './quota-signal.js';

export interface LimitSignal {
  /** 判定为限额。 */
  hit: boolean;
  /** 这个结论怎么来的，会原样进结果里的 reason。 */
  reason: string;
  windows: Window[];
}

const NO_SIGNAL: LimitSignal = { hit: false, reason: '', windows: [] };

/**
 * OpenCode 的事件里有没有限额的迹象。
 *
 * 插件只把错误类事件送过来，所以这里可以放心按原话匹配；再叠一条 429，因为上游有时
 * 只给状态码不给人话。故意不认单独的 'limit' 或 'overloaded'——上下文超长和服务端过载
 * 都会那么说，换账户对它们没有任何帮助。
 */
export function opencodeSignal(payload: unknown): LimitSignal {
  const signal = classifyQuotaSignal(payload);
  if (signal === 'status_429') {
    return { hit: true, reason: 'OpenCode 收到上游 429', windows: [] };
  }
  if (signal === 'quota_phrase') {
    return { hit: true, reason: 'OpenCode 报告明确的额度用尽信息', windows: [] };
  }
  return NO_SIGNAL;
}

/* ── 入口 ───────────────────────────────────────────────────────────────── */

export interface HookOutput {
  /** 写到 stdout 的内容，格式由客户端决定。 */
  stdout: string;
  /** 这次到底做了什么，供 --verbose 和测试断言。 */
  result: SwitchResult | null;
  /** 没有触发切换判断时的说明。 */
  skipped: string;
  outcome: HookOutcome;
}

export type HookOutcome =
  | 'switched'
  | 'available'
  | 'skipped_no_signal'
  | 'no_candidate'
  | 'lock_contended'
  | 'network_error'
  | 'check_failed'
  | 'unknown';

function parse(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 跑一次钩子。
 *
 * 无论有没有本地证据，只要事件本身值得看，就交给 switchAccount 定夺：它自己会先判断
 * 当前账户是不是真的用尽（缓存够新时不出网），够用就原样返回不切。钩子这一层不重复
 * 那套判断，免得两处阈值各说各话。
 */
export async function runHook(
  client: 'opencode' | 'omo',
  input: string,
  opts: Partial<SwitchOptions> = {},
): Promise<HookOutput> {
  const payload = parse(input);
  if (client === 'omo' && (payload.source !== 'omo' || payload.provider !== 'chatgpt-subscription')) {
    return { stdout: JSON.stringify({ switched: false, outcome: 'skipped_no_signal' }), result: null, skipped: 'OmO 来源或模型不匹配', outcome: 'skipped_no_signal' };
  }

  if (payload.source === 'opencode' && payload.recover === true && payload.provider === 'openai'
    && !opencodeSignal(payload).hit) {
    const result = await switchAccount({
      ...opts,
      provider: 'codex',
      triggerClient: 'opencode',
      recover: true,
      exhausted: false,
      threshold: 100,
      cacheMs: 0,
      minIntervalMs: 0,
      ...(typeof payload.quotaCheckAfter === 'number' && Number.isFinite(payload.quotaCheckAfter)
        ? { quotaCheckAfter: payload.quotaCheckAfter } : {}),
      reason: 'OpenCode 额度恢复检查',
      usageQuery: opts.usageQuery ?? queryHookUsage,
    });
    const latestData = result.quotaCheck?.latestData ?? result.checked.some((account) => account.source === 'live');
    const outcome: HookOutcome = result.lockContended ? 'lock_contended' : result.quotaCheck?.outcome ?? quotaCheckOutcome(result, true);
    return {
      stdout: JSON.stringify({ switched: result.switched, outcome, latestData, ...(result.waitUntil ? { waitUntil: result.waitUntil } : {}) }),
      result, skipped: '', outcome,
    };
  }
  const signal = opencodeSignal(payload);
  if (!signal.hit) {
    return { stdout: JSON.stringify({ switched: false, message: '', outcome: 'skipped_no_signal' }), result: null, skipped: '事件里没有限额迹象', outcome: 'skipped_no_signal' };
  }
  const request = payload.omoRequest;
  const omoRequest = client === 'omo' && request !== null && typeof request === 'object' && !Array.isArray(request)
    && 'accountId' in request && typeof request.accountId === 'string' && request.accountId.length > 0
    && 'email' in request && typeof request.email === 'string'
    && 'loginId' in request && typeof request.loginId === 'string'
    ? { accountId: request.accountId, email: request.email, loginId: request.loginId }
    : undefined;
  if (client === 'omo' && !omoRequest) {
    return { stdout: JSON.stringify({ switched: false, outcome: 'skipped_no_signal' }), result: null, skipped: '缺少 OmO 请求账户身份', outcome: 'skipped_no_signal' };
  }
  const result = await switchAccount({
    ...opts,
    provider: opts.provider ?? 'codex',
    triggerClient: client === 'omo' ? 'omo-agent' : 'opencode',
    exhausted: client === 'omo' ? opts.check === false : true,
    ...(omoRequest ? { omoRequest } : {}),
    cacheMs: 0,
    threshold: 100,
    ...(typeof payload.quotaCheckAfter === 'number' && Number.isFinite(payload.quotaCheckAfter)
      ? { quotaCheckAfter: payload.quotaCheckAfter } : {}),
    reason: signal.reason,
    usageQuery: opts.usageQuery ?? queryHookUsage,
  });
  const latestData = result.quotaCheck?.latestData ?? result.checked.some((account) => account.source === 'live');
  const resume = client === 'omo' && !result.switched && result.checked[0]?.usable === true;
  const outcome: HookOutcome = result.lockContended ? 'lock_contended' : resume ? 'available' : result.quotaCheck?.outcome ?? quotaCheckOutcome(result, false);
  return {
      stdout: JSON.stringify({
        switched: result.switched,
        ...(resume ? { resume: true } : {}),
        outcome,
        message: result.switched ? '账户已切换' : '',
        reason: result.reason,
        from: result.switched ? '[redacted]' : '',
        to: result.switched ? '[redacted]' : '',
        latestData,
        ...(result.waitUntil ? { waitUntil: result.waitUntil } : {}),
    }),
    result,
    skipped: '',
    outcome,
  };
}
