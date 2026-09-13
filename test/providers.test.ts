import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { UsageResult } from '../src/shared/types.js';

/**
 * Claude 那条路发完之后要回头问额度接口，而那个接口自己会限流。
 * 这里把 CLI 和额度查询都换掉，验证的是**问不到窗口时会发生什么**——
 * 真实链路上这一步失手，账户就会被停掉。
 */

const usageCalls: { windowsOnly?: boolean }[] = [];
let usageReplies: UsageResult[] = [];

function usageResult(over: Partial<UsageResult>): UsageResult {
  return {
    accountId: 'claude:a@x.com',
    provider: 'claude',
    email: 'a@x.com',
    ok: false,
    status: 0,
    error: '',
    plan: '',
    subscriptionEndsAt: null,
    userId: '',
    resetCredits: null,
    resetCreditsExpiresAt: null,
    orgType: '',
    windows: [],
    endpoint: '',
    raw: '',
    ...over,
  };
}

const RATE_LIMITED = usageResult({
  status: 429,
  error: '{"error":{"type":"rate_limit_error"}}',
});

let cliOk = true;

mock.module('../src/server/claudecli.js', {
  exports: {
    sendViaCli: async () => ({
      ok: cliOk,
      status: cliOk ? 200 : 401,
      error: cliOk ? '' : 'Failed to authenticate',
      sentAt: Date.now(),
      commandLine: 'claude --print',
      record: { method: 'EXEC', url: 'cli://claude', headers: {}, body: 'claude --print' },
      output: '{"is_error":false}',
      durationMs: 12,
    }),
  },
});

mock.module('../src/server/usage.js', {
  exports: {
    queryUsage: async (_acct: unknown, opts: { windowsOnly?: boolean } = {}) => {
      usageCalls.push(opts);
      return usageReplies[usageCalls.length - 1] ?? RATE_LIMITED;
    },
  },
});

const { send, waitBefore } = await import('../src/server/providers.js');

const ACCOUNT = {
  id: 'claude:a@x.com',
  provider: 'claude',
  email: 'a@x.com',
  accessToken: 'sk-ant-oat01-TOKEN',
} as never;

/**
 * 跑完整条发送，期间把退避用掉的时间快进过去。
 *
 * 退避是一个个排出来的（上一次查询有结果了才知道下一次等多久），所以要在每次
 * 让出事件循环之后再 runAll 一遍，而不是一次性推到底。
 */
async function sendWithFastClock(): Promise<Awaited<ReturnType<typeof send>>> {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = send(ACCOUNT, 'ping', 'claude-sonnet-5');
    let done = false;
    void pending.then(() => {
      done = true;
    });
    for (let i = 0; i < 20 && !done; i++) {
      await new Promise((r) => setImmediate(r));
      mock.timers.runAll();
    }
    return await pending;
  } finally {
    mock.timers.reset();
  }
}

test('额度接口一直 429 时，发送仍然给出一条按 5 小时估算的窗口', async () => {
  usageCalls.length = 0;
  usageReplies = [];
  cliOk = true;

  const r = await sendWithFastClock();

  assert.equal(r.ok, true);
  assert.equal(usageCalls.length, 3);
  // 发送路径只要窗口，不该顺带再打一次 profile——那是同一个限流计数器
  assert.ok(usageCalls.every((o) => o.windowsOnly === true));

  assert.equal(r.windows.length, 1);
  const [w] = r.windows;
  // 标成 assumed，界面和日志里一眼能看出这条不是上游说的
  assert.equal(w.source, 'assumed');
  assert.equal(w.name, '5h');
  assert.equal(w.resetAt, r.sentAt + 5 * 3_600_000);
});

test('额度接口回过神来时用它给的真实窗口，不再估算', async () => {
  usageCalls.length = 0;
  cliOk = true;
  const resetAt = Date.now() + 4 * 3_600_000;
  usageReplies = [
    RATE_LIMITED,
    usageResult({
      ok: true,
      status: 200,
      windows: [
        { name: '5h', resetAt, usedPercent: 3, windowMinutes: 300, source: 'usage:five_hour' },
      ],
    }),
  ];

  const r = await sendWithFastClock();

  assert.equal(usageCalls.length, 2);
  assert.deepEqual(r.windows.map((w) => w.source), ['usage:five_hour']);
  assert.equal(r.windows[0].resetAt, resetAt);
});

test('压根没发出去时不去问额度，也不编一个窗口出来', async () => {
  usageCalls.length = 0;
  usageReplies = [];
  cliOk = false;

  const r = await send(ACCOUNT, 'ping', 'claude-sonnet-5');

  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.equal(usageCalls.length, 0);
  assert.deepEqual(r.windows, []);
});

test('“计数慢一拍”几秒后再问，“接口在限流”则按秒级往上抬', () => {
  // 200 但窗口还是空的：过几秒自己就有了
  assert.equal(waitBefore(usageResult({ ok: true, status: 200 }), 0), 3_000);
  // 429 没给 retry-after：自己按档位退避，紧追只会把限流拖得更久
  assert.equal(waitBefore(RATE_LIMITED, 0), 15_000);
  assert.equal(waitBefore(RATE_LIMITED, 1), 45_000);
  assert.equal(waitBefore(RATE_LIMITED, 9), 45_000);
});

test('上游给了 retry-after 就听它的，但不为一个离谱的值把循环挂住', () => {
  const now = Date.now();
  assert.ok(
    Math.abs(waitBefore(usageResult({ status: 429, retryAfterAt: now + 8_000 }), 0) - 8_000) < 500,
  );
  // 已经过期的重试时刻不能变成负数
  assert.equal(waitBefore(usageResult({ status: 429, retryAfterAt: now - 1_000 }), 0), 0);
  assert.equal(waitBefore(usageResult({ status: 429, retryAfterAt: now + 3_600_000 }), 0), 60_000);
});
