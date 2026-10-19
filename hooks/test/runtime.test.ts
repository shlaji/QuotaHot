import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { SwitchOptions, SwitchResult } from '../src/switcher.js';

/** 每次调用 switchAccount 时收到的选项，用来断言钩子传下去的 exhausted / reason。 */
let calls: Array<Partial<SwitchOptions> & { usageTransport?: string }> = [];
let reply: SwitchResult = {
  switched: true,
  message: '已切换到 b@x.com（已用 3%）· Codex CLI',
  reason: '',
  from: 'a@x.com',
  to: 'b@x.com',
  written: [],
  waitUntil: 0,
  checked: [],
};

const state = await import('../src/state.js');
mock.module('../src/state.js', {
  exports: { ...state, withSwitchLock: async () => null },
});
let useContendedSwitch = false;
const real = await import('../src/switcher.js');
mock.module('../src/switcher.js', {
  exports: {
    ...real,
    switchAccount: async (opts: Partial<SwitchOptions>): Promise<SwitchResult> => {
      calls.push(opts);
      if (useContendedSwitch) return real.switchAccount(opts);
      return { ...reply, reason: opts.reason ?? '' };
    },
  },
});

const { runHook, opencodeSignal } = await import('../src/runtime.js');

test('认得出 OpenCode 事件里的限额', () => {
  assert.equal(opencodeSignal({ event: { properties: { error: { status: 429 } } } }).hit, true);
  assert.equal(opencodeSignal({ event: { message: 'You have hit your usage limit' } }).hit, true);
  assert.equal(opencodeSignal({ event: { message: 'rate_limit_exceeded' } }).hit, true);
  assert.equal(opencodeSignal({ event: { message: 'insufficient_quota' } }).hit, true);
  assert.equal(opencodeSignal({ event: { message: 'usage_limit_reached' } }).hit, true);
  assert.equal(opencodeSignal({ event: { error: { code: 'quota_exceeded' } } }).hit, true);
  assert.equal(opencodeSignal({ event: { error: { data: { message: 'quota has been exhausted' } } } }).hit, true);
});

test('不把别的报错当成限额', () => {
  // 这三种换账户都救不了：换了只会白白烧掉另一个账户的额度
  assert.equal(opencodeSignal({ event: { message: 'context length exceeded' } }).hit, false);
  assert.equal(opencodeSignal({ event: { message: 'server overloaded, try again' } }).hit, false);
  assert.equal(opencodeSignal({ event: { message: 'ECONNRESET' } }).hit, false);
  assert.equal(opencodeSignal({}).hit, false);
  // 429 得是独立的状态码，不能是别的数字里正好带这三位
  assert.equal(opencodeSignal({ event: { message: 'took 14290ms' } }).hit, false);
  assert.equal(opencodeSignal({
    event: {
      type: 'session.error',
      properties: {
        sessionID: 'quota_exceeded',
        error: {
          statusCode: 500,
          message: 'Internal Server Error',
          responseHeaders: { 'x-ratelimit-limit-requests': '1000' },
          body: 'usage_limit_reached',
        },
      },
    },
  }).hit, false);
});

test('OpenCode 的普通事件不触发切换', async () => {
  calls = [];
  const out = await runHook('opencode', JSON.stringify({ source: 'opencode', event: { type: 'message.updated' } }));

  assert.deepEqual(calls, []);
  assert.equal(JSON.parse(out.stdout).switched, false);
});

test('OpenCode 的旧版例行检查载荷也不再触发切换', async () => {
  calls = [];
  const out = await runHook('opencode', JSON.stringify({ source: 'opencode', check: true }));

  assert.deepEqual(calls, []);
  assert.equal(out.result, null);
});

test('OpenCode recovery polls Codex with fresh current and candidate usage', async () => {
  calls = [];
  reply = { ...reply, switched: true, checked: [], written: [], to: 'private@example.invalid' };
  const out = await runHook('opencode', JSON.stringify({ source: 'opencode', recover: true, provider: 'openai' }), { provider: 'claude', threshold: 95, cacheMs: 300_000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'codex');
  assert.equal(calls[0].triggerClient, 'opencode');
  assert.equal(calls[0].recover, true);
  assert.equal(calls[0].threshold, 100);
  assert.equal(calls[0].cacheMs, 0);
  assert.equal(calls[0].minIntervalMs, 0);
  assert.equal(calls[0].exhausted, false);
  assert.equal(out.outcome, 'switched');
  assert.equal(JSON.parse(out.stdout).switched, true);
  assert.doesNotMatch(out.stdout, /private@example/);
});

test('OpenCode recovery reports available while the current account is usable', async () => {
  calls = [];
  reply = { ...reply, switched: false, checked: [{
    id: 'current', email: 'current@example.invalid', usable: true, usedPercent: 30,
    resetAt: 0, source: 'cache', error: '',
  }], written: [] };
  const out = await runHook('opencode', JSON.stringify({ source: 'opencode', recover: true, provider: 'openai' }));
  assert.equal(out.outcome, 'available');
  assert.deepEqual(JSON.parse(out.stdout), { switched: false, outcome: 'available' });
});

test('OpenCode recovery requires exact source, provider, and recover flag', async () => {
  calls = [];
  const inputs = [
    { source: 'pi', recover: true, provider: 'openai' },
    { source: 'opencode', recover: true, provider: 'anthropic' },
    { source: 'opencode', recover: 'true', provider: 'openai' },
    { source: 'opencode', check: true, provider: 'openai' },
  ] as const;
  for (const payload of inputs) {
    const out = await runHook('opencode', JSON.stringify(payload));
    assert.equal(out.result, null);
    assert.equal(out.outcome, 'skipped_no_signal');
    assert.equal(JSON.parse(out.stdout).switched ?? false, false);
  }
  assert.deepEqual(calls, []);
});

test('explicit quota error wins over a recovery-shaped OpenCode payload', async () => {
  calls = [];
  reply = { ...reply, switched: false, checked: [], written: [] };
  await runHook('opencode', JSON.stringify({ source: 'opencode', recover: true, provider: 'openai', event: { error: { status: 429 } } }));
  assert.equal(calls[0].exhausted, true);
  assert.equal(calls[0].threshold, 100);
  assert.equal(calls[0].cacheMs, 0);
});

test('OpenCode recovery returns safe check failure outcome', async () => {
  calls = [];
  reply = { ...reply, switched: false, checked: [{ id: 'private', email: 'private@example.invalid', usable: false, usedPercent: null, resetAt: 0, source: 'error', error: 'private-token' }], written: [] };
  const out = await runHook('opencode', JSON.stringify({ source: 'opencode', recover: true, provider: 'openai' }));
  assert.equal(out.outcome, 'check_failed');
  assert.equal(JSON.parse(out.stdout).outcome, 'check_failed');
  assert.doesNotMatch(out.stdout, /private|token/);
  reply = { ...reply, checked: [] };
});

test('OpenCode recovery exposes safe wait time when all accounts are exhausted', async () => {
  calls = [];
  const waitUntil = Date.now() + 60_000;
  reply = { ...reply, switched: false, checked: [], written: [], waitUntil };
  const out = await runHook('opencode', JSON.stringify({ source: 'opencode', recover: true, provider: 'openai' }));
  assert.equal(out.outcome, 'no_candidate');
  assert.deepEqual(JSON.parse(out.stdout), { switched: false, outcome: 'no_candidate', waitUntil });
  reply = { ...reply, waitUntil: 0 };
});

for (const [path, payload] of [
  ['恢复轮询', { source: 'opencode', recover: true, provider: 'openai' }],
  ['首次额度事件', { source: 'opencode', event: { error: { status: 429 } } }],
] as const) {
  test(`OpenCode ${path}将切换锁竞争传播为 lock_contended`, async () => {
    useContendedSwitch = true;
    try {
      const out = await runHook('opencode', JSON.stringify(payload));

      assert.equal(out.outcome, 'lock_contended');
      assert.equal(JSON.parse(out.stdout).outcome, 'lock_contended');
      assert.equal(JSON.parse(out.stdout).switched, false);
    } finally {
      useContendedSwitch = false;
    }
  });

  test(`OpenCode ${path}不根据提示文案将无候选误判为锁竞争`, async () => {
    reply = { ...reply, switched: false, checked: [], written: [], waitUntil: 0,
      message: '另一处正在切换账户，这次跳过', from: 'private@example.invalid', to: 'private-token' };

    const out = await runHook('opencode', JSON.stringify(payload));

    assert.equal(out.outcome, 'no_candidate');
    assert.equal(JSON.parse(out.stdout).outcome, 'no_candidate');
    assert.doesNotMatch(out.stdout, /private@example|private-token/);
  });
}

test('OpenCode 撞上 429 时切换，结果按插件认得的形状返回', async () => {
  calls = [];
  reply = { ...reply, switched: true, message: '已切换到 b@x.com', to: 'b@x.com' };
  const out = await runHook(
    'opencode',
    JSON.stringify({ source: 'opencode', event: { type: 'session.error', properties: { error: { status: 429 } } } }),
  );

  assert.equal(calls[0].exhausted, true);
  assert.equal(calls[0].cacheMs, 0);
  assert.equal(calls[0].threshold, 100);
  assert.equal(calls[0].triggerClient, 'opencode');
  assert.equal(typeof calls[0].usageQuery, 'function');
  const stdout = JSON.parse(out.stdout);
  assert.equal(stdout.switched, true);
  assert.equal(stdout.outcome, 'switched');
  assert.equal(stdout.to, '[redacted]');
  assert.match(stdout.reason, /429/);
});

test('钩子结果带稳定的跳过与无候选代码', async () => {
  calls = [];
  const skipped = await runHook('opencode', JSON.stringify({ source: 'opencode', event: { type: 'message.updated' } }));
  assert.equal(JSON.parse(skipped.stdout).outcome, 'skipped_no_signal');

  reply = { ...reply, switched: false, message: 'synthetic no candidate', to: '' };
  const noCandidate = await runHook(
    'opencode',
    JSON.stringify({ source: 'opencode', event: { type: 'session.error', properties: { error: { status: 429 } } } }),
  );
  assert.equal(JSON.parse(noCandidate.stdout).outcome, 'no_candidate');
});

test('failed candidate checks produce a safe diagnostic instead of pretending all accounts are exhausted', async () => {
  reply = { ...reply, switched: false, checked: [{
    id: 'fixture', email: 'private@example.invalid', usable: false, usedPercent: null,
    resetAt: 0, source: 'error', error: 'upstream-secret',
  }] };
  const out = await runHook('opencode', JSON.stringify({ event: { error: { status: 429 } } }));
  assert.equal(out.outcome, 'check_failed');
  assert.equal(JSON.parse(out.stdout).outcome, 'check_failed');
  assert.doesNotMatch(out.stdout, /private@example|upstream-secret/);
  reply = { ...reply, checked: [] };
});

test('failed trigger writes produce a safe diagnostic even when account checks succeeded', async () => {
  reply = {
    ...reply,
    switched: false,
    checked: [{
      id: 'fixture', email: 'private@example.invalid', usable: true, usedPercent: 3,
      resetAt: 0, source: 'live', error: '',
    }],
    written: [{
      path: '/private/auth.json', source: 'opencode', label: 'OpenCode', created: false,
      backupPath: '', changes: [], warning: '', error: 'private-write-error',
    }],
  };
  const out = await runHook('opencode', JSON.stringify({ event: { error: { status: 429 } } }));
  assert.equal(out.outcome, 'check_failed');
  assert.doesNotMatch(out.stdout, /private|write-error/);
  reply = { ...reply, checked: [], written: [] };
});

test('OpenCode 输出不回显子进程或切换结果中的敏感文本', async () => {
  reply = { ...reply, switched: true, message: 'secret@example.invalid token=sentinel', to: 'secret@example.invalid' };
  const out = await runHook(
    'opencode',
    JSON.stringify({ source: 'opencode', event: { type: 'session.error', properties: { error: { status: 429, message: 'secret-body' } } } }),
  );
  assert.doesNotMatch(out.stdout, /secret@example|sentinel|secret-body/);
});

test('载荷不是 JSON 也不会把用户的会话弄停', async () => {
  calls = [];
  const opencode = await runHook('opencode', '这不是 json');
  assert.equal(JSON.parse(opencode.stdout).switched, false);
  assert.deepEqual(calls, []);
});

test('OpenCode 不会把 Pi 消息或 Codex 会话记录当成额度事件', async () => {
  calls = [];
  const payloads = [
    { source: 'pi', role: 'assistant', provider: 'openai-codex', stopReason: 'error', errorMessage: 'usage limit reached' },
    { hook_event_name: 'Stop', transcript_path: '/not/read', rate_limits: { primary: { used_percent: 100 } } },
  ];
  for (const payload of payloads) {
    const out = await runHook('opencode', JSON.stringify(payload));
    assert.equal(out.outcome, 'skipped_no_signal');
    assert.equal(JSON.parse(out.stdout).switched, false);
  }
  assert.deepEqual(calls, []);
});
