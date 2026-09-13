/**
 * 让每个账户产生一次最小的真实用量，并带回限额信息。
 *
 * 两家上游的发送方式不一样，这是刻意的：
 *
 *   - **Claude 交给本机的官方 `claude` CLI 去发**。OAuth 令牌只在 Claude Code 身份下签发，
 *     自己拼 `/v1/messages` 的请求已经不被受理了，见 claudecli.ts 开头的说明。
 *     代价是拿不到限额响应头，因此窗口重置时间要另外向只读的额度接口问一次。
 *   - **Codex 仍然直连 `/backend-api/codex/responses`**，它的限额信息就在响应头和流里。
 *
 * 无论走哪条路，请求都被压到尽可能小，目的是打开并观测 5 小时窗口，而不是消耗它。
 */
import { noteError, recordOutbound, request, type HttpResponse } from './http.js';
import { codexResponsesHeaders, diagnose } from './headers.js';
import { sendViaCli, type LimitHint } from './claudecli.js';
import { queryUsage } from './usage.js';
import * as rl from './ratelimit.js';
import { auditOf, type Account } from './creds.js';
import type { UsageResult, Window } from '../shared/types.js';

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';

/**
 * 发完之后最多向额度接口问几次窗口。
 *
 * 计数偶尔会比这一发慢上一两秒，只问一次就有可能空手而归。查询本身是只读的，
 * 多问一次很便宜。
 */
const USAGE_ATTEMPTS = 3;
/** 计数还没跟上时的间隔：这种“空”过几秒自己就好了。 */
const USAGE_RETRY_MS = 3_000;
/**
 * 额度接口自己回 429 时的等待。
 *
 * 这种 429 说的是“这个接口现在不想被问”，与账户额度无关，3 秒后再问一次只会再被拒
 * 一次，而每追一次都在给同一个计数器加数。所以退避要按秒级往上抬，而不是沿用上面
 * 那个为“计数慢一拍”准备的间隔。
 */
const USAGE_LIMITED_BACKOFF_MS = [15_000, 45_000];
/** 上游给的 retry-after 再长也不会为它一直等下去；超过就按估算窗口走。 */
const USAGE_RETRY_AFTER_CAP_MS = 60_000;

/**
 * 5 小时滚动窗口的长度。Claude 与 Codex 的主窗口都是这个量级。
 * 只用在读不到真实窗口、必须自己推算下一拍的时候。
 */
const WINDOW_5H_MS = 5 * 3_600_000;

/**
 * 单次发送的超时。
 * 请求本身极小，正常都在数秒内返回；给到 60 秒是为了容忍代理链路抖动，
 * 但绝不能不设上限——挂死的连接会把这个账户的整条循环一起卡住。
 */
const SEND_TIMEOUT_MS = 60_000;

/** 发送时需要用到、但属于全局配置的那几项。 */
export interface SendOptions {
  /** 出站代理；CLI 是独立进程，不共享本进程的 dispatcher，只能靠环境变量告诉它。 */
  proxy?: string;
  noProxy?: readonly string[];
  claudeCliTimeoutMs?: number;
}

export interface SendResult {
  ok: boolean;
  status: number;
  windows: Window[];
  headers: Record<string, string>;
  sentAt: number;
  error: string;
}

function headersToObject(h: HttpResponse['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function fallbackFrom429(headers: HttpResponse['headers'], nowMs: number, name: string): Window[] {
  const reset = rl.parseRetryAfter(headers, nowMs);
  if (reset === null) return [];
  return [{ name, resetAt: reset, usedPercent: null, windowMinutes: 300, source: 'retry-after' }];
}

/** 等一小会儿；只在重问额度接口之间用得上。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 这一次问不到窗口，下一次隔多久再问。 */
export function waitBefore(usage: UsageResult, limitedSoFar: number): number {
  if (usage.status !== 429) return USAGE_RETRY_MS;
  const hinted = usage.retryAfterAt ?? null;
  // 上游说了等到什么时候就听它的，但不为一个离谱的值把整条循环挂住
  if (hinted !== null) return Math.min(Math.max(hinted - Date.now(), 0), USAGE_RETRY_AFTER_CAP_MS);
  return USAGE_LIMITED_BACKOFF_MS[Math.min(limitedSoFar, USAGE_LIMITED_BACKOFF_MS.length - 1)];
}

/**
 * 刚发出去那一发打开的窗口。
 *
 * CLI 不会把限额响应头交出来，所以只能回头问一次官方的只读额度接口——它读到的正是
 * 这一发打开的那个窗口，而查询本身既不消耗额度，也不会再开新窗口。
 *
 * 问不到有两种，退避方式完全不同：计数比这一发慢一两拍，几秒后自己就有了；而接口
 * 回 429 是它在限流我们，紧追只会把限流拖得更久。两种都问不出来时返回空，由调用方
 * 按估算窗口兜底——绝不能因为“读不到”就让这个账户没有下一拍。
 */
async function windowsAfterCliSend(acct: Account): Promise<Window[]> {
  let limited = 0;
  for (let attempt = 1; attempt <= USAGE_ATTEMPTS; attempt++) {
    const usage = await queryUsage(acct, { windowsOnly: true });
    if (usage.ok && usage.windows.length > 0) return usage.windows;
    if (attempt === USAGE_ATTEMPTS) break;
    const wait = waitBefore(usage, limited);
    if (usage.status === 429) limited++;
    await delay(wait);
  }
  return [];
}

/**
 * 读不到窗口时自己推算的那一条。
 *
 * 刚才那一发确实打开了一个 5 小时窗口，只是额度接口这会儿不肯说。发送时刻 + 5 小时
 * 是可以自己算出来的**上界**：账户本来就在窗口里时真实重置只会更早，那样我们只是晚发
 * 一点，下一拍再问一次就自己纠正回来了。而什么都不给的后果要严重得多——调度器会
 * 认定“取不到重置时间”，直接把这个账户停掉，保活就此中断。
 *
 * 两个 provider 都要用：Claude 走 CLI 时额度接口可能在限流，Codex 则可能返回 200
 * 却既没有限额响应头、流里也没有 rate_limits。
 *
 * 来源标成 assumed，界面和日志里一眼能看出这条不是上游说的。
 */
function assumedWindow(sentAt: number): Window {
  return {
    name: '5h',
    resetAt: sentAt + WINDOW_5H_MS,
    usedPercent: null,
    windowMinutes: 300,
    source: 'assumed',
  };
}

/**
 * CLI 触限时自己说出来的那个重置时刻。
 *
 * 比 assumedWindow 靠谱：它是上游的原话，而且撞的是周额度时，估算的 5 小时会差出好几天。
 * 只在额度接口不肯说话时才用得上，因此来源单独标出来。
 */
function hintedWindow(hint: LimitHint): Window {
  return {
    name: hint.name,
    resetAt: hint.resetAt,
    usedPercent: null,
    windowMinutes: hint.name === '7d' ? 10080 : 300,
    source: 'cli-message',
  };
}

async function sendClaude(
  acct: Account,
  text: string,
  model: string,
  opts: SendOptions,
): Promise<SendResult> {
  const outcome = await sendViaCli({
    accountId: acct.id,
    accessToken: acct.accessToken,
    text,
    model,
    proxy: opts.proxy,
    noProxy: opts.noProxy,
    timeoutMs: opts.claudeCliTimeoutMs,
  });

  // 走 CLI 也要在请求日志里留一条：它是这条路上唯一能看到“到底发了什么、CLI 回了什么”
  // 的地方，否则界面上这一发只剩一个状态码
  recordOutbound(
    auditOf(acct),
    outcome.sentAt,
    outcome.record,
    outcome.status,
    outcome.durationMs,
    outcome.error,
    outcome.output,
  );

  // 触限时同样要问一次：额度接口给的窗口比错误文案里那句话精确
  const asked = outcome.ok || outcome.status === 429;
  let windows = asked ? await windowsAfterCliSend(acct) : [];
  // 发出去了却读不到窗口时，先用 CLI 自己报的重置时刻，再退回 5 小时估算，
  // 总之别让这个账户失去下一拍
  if (asked && windows.length === 0) {
    windows = [outcome.limit ? hintedWindow(outcome.limit) : assumedWindow(outcome.sentAt)];
  }

  return {
    ok: outcome.ok,
    status: outcome.status,
    windows,
    headers: {},
    sentAt: outcome.sentAt,
    // 出错时把命令行一起带上：多半是命令找不到或参数不被这一版认，看到它就能定位
    error: outcome.error === '' ? '' : `${outcome.error}\n$ ${outcome.commandLine}`,
  };
}

async function sendCodex(acct: Account, text: string, model: string): Promise<SendResult> {
  const sentAt = Date.now();
  const audit = auditOf(acct);
  const reqHeaders = codexResponsesHeaders(acct.accessToken, acct.accountId);
  const reqBody = JSON.stringify({
    model,
    instructions: 'You are a helpful assistant.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
    stream: true, // Codex 端点只接受流式请求
    store: false,
  });

  let resp: HttpResponse;
  try {
    resp = await request(CODEX_URL, {
      method: 'POST',
      headers: reqHeaders,
      timeoutMs: SEND_TIMEOUT_MS,
      body: reqBody,
      audit,
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      windows: [],
      headers: {},
      sentAt,
      error: `network: ${String((err as Error).cause ?? err)}`,
    };
  }

  const headers = headersToObject(resp.headers);

  if (resp.status !== 200) {
    let windows = rl.parseHeaders(resp.headers, sentAt);
    if (resp.status === 429 && windows.length === 0) {
      windows = fallbackFrom429(resp.headers, sentAt, 'primary');
    }
    const body = await resp.text();
    // 诊断串里的 request-id / cf-ray 能区分“边缘节点挡掉”和“业务层拒绝”，二者状态码常常相同
    const error = `${body.slice(0, 300)}${diagnose(resp.headers, body)}`;
    noteError(audit, error);
    return { ok: false, status: resp.status, windows, headers, sentAt, error };
  }

  // 限额信息在 response.completed 事件里；读到它就够了，无需把整条流耗尽
  const bodyWindows = await readRateLimitsFromStream(resp, sentAt);

  // 响应头优先级高于 body，因此合并时放前面
  const merged = rl.merge(rl.parseHeaders(resp.headers, sentAt), bodyWindows);
  // 发出去了却一条窗口都没读到时按 5 小时估算兜底，和 Claude 那边同一个道理：
  // 这一发是成功的，不能因为上游没报限额就让这个账户失去下一拍、被调度器停掉
  const windows = merged.length > 0 ? merged : [assumedWindow(sentAt)];
  return { ok: true, status: 200, windows, headers, sentAt, error: '' };
}

async function readRateLimitsFromStream(resp: HttpResponse, sentAt: number): Promise<Window[]> {
  if (!resp.body) return [];
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for await (const value of resp.body) {
      buffer += decoder.decode(value as Buffer, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // 尾部可能是不完整行，要带到下一轮继续拼

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const chunk = line.slice(5).trim();
        if (!chunk || chunk === '[DONE]') continue;
        try {
          const found = rl.parseBody(JSON.parse(chunk), sentAt);
          if (found.length > 0) return found;
        } catch {
          /* 不完整的 JSON 片段，直接忽略 */
        }
      }
    }
  } finally {
    // 一旦拿到需要的数据就立刻断开，不必等完整回答结束
    resp.body.destroy();
  }
  return [];
}

export async function send(
  acct: Account,
  text: string,
  model: string,
  opts: SendOptions = {},
): Promise<SendResult> {
  if (acct.provider === 'claude') return sendClaude(acct, text, model, opts);
  return sendCodex(acct, text, model);
}
