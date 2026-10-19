/** OpenCode 事件入口：识别额度信号，交由 switcher 选择并同步账户。 */
import { switchAccount, type SwitchOptions, type SwitchResult } from './switcher.js';
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
  _client: 'opencode',
  input: string,
  opts: Partial<SwitchOptions> = {},
): Promise<HookOutput> {
  const payload = parse(input);

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
      reason: 'OpenCode 额度恢复检查',
      usageQuery: opts.usageQuery ?? queryHookUsage,
    });
    const outcome: HookOutcome = result.lockContended ? 'lock_contended' : result.switched ? 'switched' : result.checked[0]?.usable ? 'available' :
      result.checked.some((account) => account.source === 'error') || result.written.some((write) => write.error)
        ? 'check_failed'
        : 'no_candidate';
    return {
      stdout: JSON.stringify({ switched: result.switched, outcome, ...(result.waitUntil ? { waitUntil: result.waitUntil } : {}) }),
      result, skipped: '', outcome,
    };
  }
  const signal = opencodeSignal(payload);
  if (!signal.hit) {
    return { stdout: JSON.stringify({ switched: false, message: '', outcome: 'skipped_no_signal' }), result: null, skipped: '事件里没有限额迹象', outcome: 'skipped_no_signal' };
  }
  const result = await switchAccount({
    ...opts,
    provider: opts.provider ?? 'codex',
    triggerClient: 'opencode',
    exhausted: true,
    cacheMs: 0,
    threshold: 100,
    reason: signal.reason,
    usageQuery: opts.usageQuery ?? queryHookUsage,
  });
  const outcome: HookOutcome = result.lockContended ? 'lock_contended' : result.switched ? 'switched' :
    result.checked.some((account) => account.source === 'error') || result.written.some((write) => write.error)
      ? 'check_failed'
      : 'no_candidate';
  return {
      stdout: JSON.stringify({
        switched: result.switched,
        outcome,
        message: result.switched ? '账户已切换' : '',
        reason: result.reason,
        from: result.switched ? '[redacted]' : '',
        to: result.switched ? '[redacted]' : '',
        ...(result.waitUntil ? { waitUntil: result.waitUntil } : {}),
    }),
    result,
    skipped: '',
    outcome,
  };
}
