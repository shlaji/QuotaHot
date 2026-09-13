import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SwitchOptions, SwitchResult } from '../src/switcher.js';
import { opencodePlugin } from '../src/install.js';

/**
 * 钩子这一层只做一件事：把 codex / OpenCode 各自的载荷翻译成「撞没撞上限额」。
 * 所以真正的切换被替换掉了，断言集中在两处容易出错的地方——从会话记录尾部认限额数字，
 * 以及别把上下文超长、服务端过载这些跟限额无关的报错也当成限额。
 */
  const dir = mkdtempSync(join(tmpdir(), 'quotahot-hook-'));

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

const real = await import('../src/switcher.js');
  mock.module('../src/switcher.js', {
  exports: {
    ...real,
    switchAccount: async (opts: Partial<SwitchOptions>): Promise<SwitchResult> => {
      calls.push(opts);
      return { ...reply, reason: opts.reason ?? '' };
    },
  },
});

const { runHook, codexWindows, opencodeSignal } = await import('../src/runtime.js');

/** 造一份 codex 的会话记录：每行一条 JSON，限额信息藏在中间那条。 */
function rollout(lines: string[], prefix = ''): string {
  const path = join(dir, `rollout-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, prefix + lines.join('\n'), 'utf8');
  return path;
}

function turn(primaryPercent: number, resetSeconds: number): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      rate_limits: {
        primary: {
          used_percent: primaryPercent,
          window_minutes: 300,
          resets_at: Math.floor(Date.now() / 1000) + resetSeconds,
        },
      },
    },
  });
}

test('从会话记录尾部读出最近一轮的限额数字', async () => {
  const path = rollout([
    turn(10, 3600),
    turn(88, 3600),
    JSON.stringify({ type: 'function_call', name: 'shell' }),
  ]);
  const windows = await codexWindows(path);

  assert.equal(windows.length, 1);
  // 取的是最后一条带 rate_limits 的，不是第一条
  assert.equal(Math.round(windows[0].usedPercent ?? 0), 88);
});

test('开头那行被截断也照样能读后面的', async () => {
  // 只读末尾若干字节意味着第一行几乎总是半截 JSON，解析失败必须跳过而不是放弃整份文件
  const path = rollout([turn(77, 3600)], '{"type":"session_meta","payl\n');
  const windows = await codexWindows(path);

  assert.equal(Math.round(windows[0]?.usedPercent ?? 0), 77);
});

test('没有会话记录时不报错，只是没有本地证据', async () => {
  assert.deepEqual(await codexWindows(''), []);
  assert.deepEqual(await codexWindows(join(dir, '并不存在.jsonl')), []);
  assert.deepEqual(await codexWindows(rollout([JSON.stringify({ type: 'response_item' })])), []);
});

test('与额度无关的 codex 事件直接放过，不去碰账户', async () => {
  calls = [];
  const out = await runHook('codex', JSON.stringify({ hook_event_name: 'PreToolUse' }));

  assert.equal(out.stdout, '{}');
  assert.equal(out.result, null);
  assert.deepEqual(calls, []);
});

test('会话记录显示用尽时，带着 exhausted 交给切换', async () => {
  calls = [];
  const path = rollout([turn(99, 3600)]);
  const out = await runHook('codex', JSON.stringify({ hook_event_name: 'Stop', transcript_path: path }));

  assert.equal(calls[0].exhausted, true);
  assert.equal(calls[0].usageTransport, undefined);
  assert.equal(calls[0].usageQuery, undefined);
  assert.equal(calls[0].triggerClient, 'codex-cli');
  assert.match(calls[0].reason ?? '', /99%/);
  // 换完必须提醒重开会话：codex 会话中途不会重载 auth.json
  const stdout = JSON.parse(out.stdout);
  assert.match(stdout.systemMessage, /新会话/);
});

test('额度还够时也走一遍例行检查，但不声称已用尽', async () => {
  calls = [];
  reply = { ...reply, switched: false, message: 'a@x.com 仍有额度（已用 30%），不切换', to: '' };
  const path = rollout([turn(30, 3600)]);
  const out = await runHook('codex', JSON.stringify({ hook_event_name: 'UserPromptSubmit', transcript_path: path }));

  assert.equal(calls[0].exhausted, false);
  // 没撞上限额又没换成：不该往用户屏幕上弹任何东西
  assert.equal(out.stdout, '{}');
});

test('撞上限额却没换成时，把原因告诉用户', async () => {
  calls = [];
  reply = { ...reply, switched: false, message: '所有 codex 账户都已用尽', to: '' };
  const path = rollout([turn(100, 3600)]);
  const out = await runHook('codex', JSON.stringify({ hook_event_name: 'Stop', transcript_path: path }));

  const stdout = JSON.parse(out.stdout);
  assert.match(stdout.systemMessage, /都已用尽/);
});

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

test('OpenCode 插件只监听错误，不再生成请求前例行检查', () => {
  const source = opencodePlugin('/usr/local/bin/quotahot-hook');

  assert.match(source, /event: async/);
  assert.doesNotMatch(source, /chat\.params/);
  assert.doesNotMatch(source, /check:\s*true/);
});

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

test('Codex 输出不回显切换结果中的邮箱或账户文本', async () => {
  reply = { ...reply, switched: true, message: 'secret@example.invalid account-secret', to: 'secret@example.invalid' };
  const path = rollout([turn(100, 3600)]);
  const out = await runHook('codex', JSON.stringify({ hook_event_name: 'Stop', transcript_path: path }));
  assert.doesNotMatch(out.stdout, /secret@example|account-secret/);
});

test('载荷不是 JSON 也不会把用户的会话弄停', async () => {
  calls = [];
  const codex = await runHook('codex', '这不是 json');
  assert.equal(codex.stdout, '{}');

  const opencode = await runHook('opencode', '');
  assert.equal(JSON.parse(opencode.stdout).switched, false);
  assert.deepEqual(calls, []);
});
