/**
 * 钩子入口：由 codex 或 OpenCode 在自己的生命周期里拉起，判断这次要不要换账户。
 *
 * 两边的钩子协议完全不同，但要做的判断是同一个，所以这里只负责把各自的载荷翻译成
 * 「当前账户是不是撞上限额了」，真正的挑人和写文件都交给 switcher.ts。
 *
 * 判定优先用**本地**证据：codex 会把每一轮的 rate_limits 原样写进会话记录，OpenCode 的
 * 错误事件里带着上游的状态码和原话。有这些就不必再问当前账户一次；OpenCode 确认触限后
 * 会立即现查候选账户，避免拿旧缓存把用户切到同样不可用的账户。
 *
 * 无论出什么岔子都以退出码 0 结束：钩子是附加在别人工作流上的东西，它自己的失败不该
 * 让用户的 codex 或 OpenCode 停下来。
 */
import { open, stat } from 'node:fs/promises';
import { parseBody } from './rate-limit.js';
import { exhaustionOf, switchAccount, type SwitchOptions, type SwitchResult } from './switcher.js';
import type { Window } from './types.js';
import { queryHookUsage } from './usage.js';
import { classifyQuotaSignal } from './quota-signal.js';

/** 会话记录只读末尾这么多字节：限额信息每轮都写，最新那条一定在最后。 */
const TAIL_BYTES = 512 * 1024;

export interface LimitSignal {
  /** 判定为限额。 */
  hit: boolean;
  /** 这个结论怎么来的，会原样进结果里的 reason。 */
  reason: string;
  windows: Window[];
}

const NO_SIGNAL: LimitSignal = { hit: false, reason: '', windows: [] };

/* ── codex ─────────────────────────────────────────────────────────────── */

/** 会在这几个事件上做判断；其余（PreToolUse 之类）与额度无关，来了也直接放过。 */
const CODEX_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'Stop']);

/** 读文件末尾若干字节。整份会话记录可能有几十兆，全读进来只为看最后一行不值当。 */
async function readTail(path: string, bytes = TAIL_BYTES): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const size = (await stat(path)).size;
    const length = Math.min(bytes, size);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    return buf.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * codex 的会话记录里最近一次的限额数字。
 *
 * 每轮响应带回的 rate_limits 都会原样落进 rollout 的 jsonl，因此不必再查一次上游就能知道
 * 刚才那一轮之后还剩多少。从后往前找第一条解析得出窗口的行——最后几行常常是工具调用，
 * 没有限额信息。头一行大概率被截断在半截，解析失败跳过即可。
 */
export async function codexWindows(transcriptPath: string): Promise<Window[]> {
  if (!transcriptPath) return [];
  let text: string;
  try {
    text = await readTail(transcriptPath);
  } catch {
    return [];
  }
  const lines = text.split('\n');
  const now = Date.now();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') || !line.includes('rate_limits')) continue;
    try {
      const windows = parseBody(JSON.parse(line), now);
      if (windows.length > 0) return windows;
    } catch {
      // 截断的行或者不是 JSON 的行：跳过，往前接着找
    }
  }
  return [];
}

async function codexSignal(payload: Record<string, unknown>, threshold: number): Promise<LimitSignal> {
  const windows = await codexWindows(String(payload.transcript_path ?? ''));
  if (windows.length === 0) return NO_SIGNAL;

  const { exhausted, resetAt } = exhaustionOf(windows, threshold, Date.now());
  if (!exhausted) return { ...NO_SIGNAL, windows };
  const worst = windows
    .filter((w) => w.usedPercent !== null && w.usedPercent >= threshold)
    .map((w) => `${w.name} 已用 ${Math.round(w.usedPercent ?? 0)}%`)
    .join('、');
  return {
    hit: true,
    reason: `codex 会话记录显示 ${worst}，${new Date(resetAt).toLocaleString()} 才重置`,
    windows,
  };
}

/* ── OpenCode ──────────────────────────────────────────────────────────── */

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
  | 'skipped_no_signal'
  | 'no_candidate'
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
  client: 'codex' | 'opencode',
  input: string,
  opts: Partial<SwitchOptions> = {},
): Promise<HookOutput> {
  const payload = parse(input);
  const threshold = opts.threshold ?? 95;

  if (client === 'codex') {
    const event = String(payload.hook_event_name ?? '');
    if (!CODEX_EVENTS.has(event)) {
      return { stdout: '{}', result: null, skipped: `codex 的 ${event || '未知'} 事件与额度无关`, outcome: 'skipped_no_signal' };
    }
    const signal = await codexSignal(payload, threshold);
    const result = await switchAccount({
      ...opts,
      provider: opts.provider ?? 'codex',
      triggerClient: 'codex-cli',
      exhausted: signal.hit,
      reason: signal.hit ? signal.reason : `codex ${event} 例行检查`,
    });
    return { stdout: codexStdout(result, signal), result, skipped: '', outcome: result.switched ? 'switched' : signal.hit ? 'no_candidate' : 'skipped_no_signal' };
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
  const outcome: HookOutcome = result.switched ? 'switched' :
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
    }),
    result,
    skipped: '',
    outcome,
  };
}

/**
 * codex 钩子的回话。
 *
 * 只用 systemMessage：它显示给用户，不进模型上下文——「换了个账号登录」是给人看的运维信息，
 * 塞进对话只会占着上下文还可能让模型跟着聊起来。
 *
 * 换完之后必须提醒重开会话：codex 在会话中途重读 auth.json 时，发现账户 ID 和这次会话对不上
 * 就会跳过不重载（它自己的日志写的是「Skipping auth reload due to account id mismatch」），
 * 所以新账户要到下一个会话才真正生效。不说清楚，用户会以为切换没成功。
 */
function codexStdout(result: SwitchResult, signal: LimitSignal): string {
  if (!result.switched) {
    // 没换成但确实撞上了限额：这件事得让用户知道，否则他只会看到模型一直报错
    if (signal.hit) {
      return JSON.stringify({ systemMessage: 'QuotaHot: 所有账户都已用尽，未切换账户' });
    }
    return '{}';
  }
  return JSON.stringify({
    systemMessage: 'QuotaHot: 已切换账户。codex 不会在会话中途换账户，请开一个新会话让它生效。',
  });
}
