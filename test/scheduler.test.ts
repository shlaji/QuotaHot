import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Window } from '../src/shared/types.js';

/**
 * Compresses the 5-hour window down to 3 seconds to verify:
 *   fires when due -> schedules the next beat from the upstream reset ->
 *   persists state -> stops at endAt -> resumes after a restart
 * Upstream is fully mocked; no network traffic.
 */

const sends: { id: string; at: number }[] = [];
const windowMs = 3000;
let omitResetFor: string | null = null;
let resetOffsetMs = 0;
/** 不为 null 时，这个账户的每一发都按上游拒绝处理。 */
let failWith: { id: string; status: number } | null = null;
/**
 * 额度接口的回答。发送失败之后调度器会回头问它一次，确认是「额度还没重置」还是真的坏了；
 * 默认答“问不出窗口”，个别用例再摆一个未到点的窗口进去。
 */
let usageOk = false;
let usageWindows: Window[] = [];
/** 令牌能不能用。跟随客户端的账户在客户端续期之前，ensureFresh 就是答不出来的。 */
let tokenReady = true;
/** 账户文件里记的到期时间。别处（后台额度刷新、界面上查额度）换到新令牌时，变的就是它。 */
let diskExpiresAt = Date.now() + 86400_000;

mock.module('../src/server/usage.js', {
  exports: {
    queryUsage: async () => ({
      ok: usageOk,
      status: 200,
      error: '',
      windows: usageWindows,
      plan: '',
      subscriptionEndsAt: null,
      resetCredits: null,
      resetCreditsExpiresAt: null,
    }),
  },
});

mock.module('../src/server/providers.js', {
  exports: {
    send: async (acct: { id: string }) => {
      const sentAt = Date.now();
      sends.push({ id: acct.id, at: sentAt });
      if (failWith !== null && failWith.id === acct.id) {
        return {
          ok: false,
          status: failWith.status,
          sentAt,
          headers: {},
          error: 'upstream said no',
          windows: [],
        };
      }
      return {
        ok: true,
        status: 200,
        sentAt,
        headers: {},
        error: '',
        windows: acct.id === omitResetFor
          ? []
          : [
              {
                name: 'primary',
                resetAt: sentAt + windowMs + resetOffsetMs,
                usedPercent: sends.length * 10,
                windowMinutes: 300,
                source: 'header:fake',
              },
            ],
      };
    },
  },
});

mock.module('../src/server/creds.js', {
  exports: {
    ensureFresh: async () => tokenReady,
    // 调度器经 clientsync 用到它来判断目标配置文件原先属于谁；
    // 模块里少一个导出，整条 import 链都起不来
    emailOf: () => '',
    loadAccounts: async () => [
      {
        id: 'codex:a@x.com', provider: 'codex', email: 'a@x.com', path: '/tmp/a.json',
        accountId: 'aid', accessToken: 't', refreshToken: 'r',
        expiresAt: diskExpiresAt, disabled: false,
      },
      {
        id: 'codex:b@x.com', provider: 'codex', email: 'b@x.com', path: '/tmp/b.json',
        accountId: 'bid', accessToken: 't', refreshToken: 'r',
        expiresAt: diskExpiresAt, disabled: false,
      },
    ],
  },
});

const { Scheduler, sleepUntil } = await import('../src/server/scheduler.js');
const { Store } = await import('../src/server/store.js');
const { DEFAULT_CONFIG } = await import('../src/server/config.js');
const { loadAccounts } = await import('../src/server/creds.js');

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'quotahot-'));
  return new Store(join(dir, 'state.db'));
}

/** Equal ends mean an all-day window, i.e. the daily schedule never gates the test. */
const ALL_DAY = { dailyStart: '00:00', dailyEnd: '00:00' };

test('两账户并行，各自按上游 reset 排下一拍', async () => {
  const store = makeStore();
  const t0 = Date.now();
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    ...ALL_DAY,
    bufferSeconds: 0.5,
    jitterSeconds: 0.2,
  });

  await sched.start();
  assert.equal(sched.running, true, '启动后应处于运行态');

  await new Promise((r) => setTimeout(r, 9500));
  await sched.stop();

  assert.ok(sends.length >= 4, `两账户各应至少发 2 轮，实际共 ${sends.length} 次`);

  const byAccount = new Map<string, number[]>();
  for (const s of sends) {
    if (!byAccount.has(s.id)) byAccount.set(s.id, []);
    byAccount.get(s.id)!.push(s.at - t0);
  }
  assert.equal(byAccount.size, 2, '两个账户都应被调度');

  // Consecutive sends for one account should be window(3s) + buffer(0.5s) + jitter(0-0.2s) apart
  for (const [id, times] of byAccount) {
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      assert.ok(gap >= 3400 && gap <= 4500, `${id} 第 ${i} 次间隔 ${gap}ms 应落在 3.4~4.5s`);
    }
  }

  // State must be persisted so a restart can resume
  const states = store.allStates();
  assert.equal(states.size, 2);
  for (const st of states.values()) {
    assert.ok(st.nextDueAt > 0, 'nextDueAt 应已持久化');
    assert.ok(st.lastResetAt > 0, 'lastResetAt 应已持久化');
    assert.equal(st.consecutiveFailures, 0);
  }
  store.close();
});

test('多账户首拍要错开，不能启动那一秒一起打上游', async () => {
  const store = makeStore();
  const before = sends.length;
  // 摊开的宽度就是 jitterSeconds，给足够大的值，用例窗口内谁都不该到点
  const sched = new Scheduler(store, { ...DEFAULT_CONFIG, ...ALL_DAY, jitterSeconds: 600 });

  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(sends.length, before, '两个账户都该先错开一段再发');
    for (const id of ['codex:a@x.com', 'codex:b@x.com']) {
      const due = store.getState(id)?.nextDueAt ?? 0;
      assert.ok(due > Date.now(), `${id} 的首拍应排到将来，而不是当下`);
    }
  } finally {
    await sched.stop();
    store.close();
  }
});

test('只跑一个账户时不必错开，到点就发', async () => {
  const store = makeStore();
  const before = sends.length;
  // jitterSeconds 保持默认的 120 秒：单账户没有「一起发」这回事，不该被它拖住
  const sched = new Scheduler(store, { ...DEFAULT_CONFIG, ...ALL_DAY, include: ['a@x.com'] });

  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 150));

    assert.ok(sends.length > before, '点了启动就该立刻有动静');
  } finally {
    await sched.stop();
    store.close();
  }
});

/**
 * 没有可续的排期不等于「该补一发」：5 小时窗口还在计时的话，这一发既开不出新窗口，
 * 也换不来新的重置时刻，白费一次额度，还把这个账户的节奏整体往后拖。
 */
test('起跑时窗口仍在计时就照它排，不补发', async () => {
  const store = makeStore();
  const fiveHourReset = Date.now() + 3600_000;
  usageOk = true;
  usageWindows = [
    { name: 'five_hour', resetAt: fiveHourReset, usedPercent: 35, windowMinutes: 300, source: 'usage:five_hour' },
  ];

  const before = sends.length;
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG, ...ALL_DAY, include: ['a@x.com'], bufferSeconds: 0, jitterSeconds: 0,
  });
  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(sends.length, before, '窗口还开着，不该补这一发');
    const view = (await sched.snapshot()).find((a) => a.id === 'codex:a@x.com')!;
    assert.equal(view.state, 'waiting');
    assert.equal(view.nextDueAt, fiveHourReset, '应照仍在计时的那条窗口排下一拍');
  } finally {
    usageOk = false;
    usageWindows = [];
    await sched.stop();
    store.close();
  }
});

/** 反过来：窗口都过点了（额度是满的），那才是真该发的时候。 */
test('起跑时窗口都已过点，照常发第一拍', async () => {
  const store = makeStore();
  usageOk = true;
  usageWindows = [
    { name: 'five_hour', resetAt: Date.now() - 1000, usedPercent: 0, windowMinutes: 300, source: 'usage:five_hour' },
  ];

  const before = sends.length;
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG, ...ALL_DAY, include: ['a@x.com'], bufferSeconds: 0, jitterSeconds: 0,
  });
  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(sends.length > before, '没有窗口在计时，点了启动就该发');
  } finally {
    usageOk = false;
    usageWindows = [];
    await sched.stop();
    store.close();
  }
});

test('重启后从库里的 nextDue 续跑，不重开新窗口', async () => {
  const store = makeStore();
  const future = Date.now() + 3600_000;
  store.setNextDue('codex:a@x.com', future);

  const before = sends.length;
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    ...ALL_DAY,
    include: ['a@x.com'],
  });
  await sched.start();
  await new Promise((r) => setTimeout(r, 800));

  assert.equal(sends.length, before, '库里记着 1 小时后才到点，不应立刻发送');
  const view = (await sched.snapshot()).find((a) => a.id === 'codex:a@x.com')!;
  assert.equal(view.state, 'waiting', '应处于等待窗口状态');
  assert.equal(view.nextDueAt, future, '应沿用库里的下次发送时刻');

  await sched.stop();
  assert.equal(sched.running, false);
  store.close();
});

test('未返回重置时间时不伪造下一次发送', async () => {
  const store = makeStore();
  omitResetFor = 'codex:a@x.com';
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    ...ALL_DAY,
    include: ['a@x.com'],
  });

  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 100));

    const account = (await sched.snapshot()).find((a) => a.id === 'codex:a@x.com')!;
    assert.equal(account.state, 'error');
    assert.equal(account.nextDueAt, null);
    assert.match(account.lastError, /未取得限额窗口重置时间/);

    const stored = store.getState('codex:a@x.com');
    assert.equal(stored?.nextDueAt ?? 0, 0, '停止调度时清掉旧的 nextDueAt，避免界面残留或重启沿用');
  } finally {
    omitResetFor = null;
    await sched.stop();
    store.close();
  }
});

test('发送时缺少 resetAt 应清掉残留的 nextDue', async () => {
  const store = makeStore();
  store.setNextDue('codex:a@x.com', Date.now() - 1000);
  omitResetFor = 'codex:a@x.com';
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    ...ALL_DAY,
    include: ['a@x.com'],
  });

  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 150));

    const account = (await sched.snapshot()).find((a) => a.id === 'codex:a@x.com')!;
    assert.equal(account.state, 'error');
    assert.equal(account.nextDueAt, null, '旧 nextDue 不应残留');
    const stored = store.getState('codex:a@x.com');
    assert.equal(stored?.nextDueAt ?? 0, 0, '持久化的 nextDueAt 也应清空');
  } finally {
    omitResetFor = null;
    await sched.stop();
    store.close();
  }
});

test('上游返回的 resetAt 早于本次发送时按无效处理', async () => {
  const store = makeStore();
  const before = sends.length;
  resetOffsetMs = -60_000;
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    ...ALL_DAY,
    include: ['a@x.com'],
    bufferSeconds: 0,
    jitterSeconds: 0,
  });

  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 200));

    const account = (await sched.snapshot()).find((a) => a.id === 'codex:a@x.com')!;
    assert.equal(account.state, 'error');
    assert.match(account.lastError, /未取得限额窗口重置时间/);
    assert.equal(sends.length - before, 1, '无效 resetAt 后不应循环再次发送');
  } finally {
    resetOffsetMs = 0;
    await sched.stop();
    store.close();
  }
});

/**
 * 真实事故的回归：本机 CLI 回了「You've hit your weekly limit · resets 10pm」，
 * 调度器把它当成接口故障，重试耗尽后判「连续失败过多」把账户停了——而当时只是额度没到点。
 */
test('发送失败但额度还没重置时，等到重置时刻而不是停掉账户', async () => {
  const store = makeStore();
  const resetAt = Date.now() + 60_000;
  failWith = { id: 'codex:a@x.com', status: 429 };
  usageOk = true;
  usageWindows = [
    { name: '5h', resetAt: resetAt + 3600_000, usedPercent: 10, windowMinutes: 300, source: 'usage:5h' },
    { name: '7d', resetAt, usedPercent: 100, windowMinutes: 10080, source: 'usage:seven_day' },
  ];
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    ...ALL_DAY,
    include: ['a@x.com'],
    bufferSeconds: 0,
    jitterSeconds: 0,
  });

  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 300));

    const account = (await sched.snapshot()).find((a) => a.id === 'codex:a@x.com')!;
    assert.equal(account.state, 'waiting', '额度没到点不是故障，账户应继续等待');
    assert.equal(account.lastError, '', '不该留下错误');
    assert.equal(account.nextDueAt, resetAt, '应排到用满的那个窗口的重置时刻');
    assert.equal(account.windowResetAt, resetAt, '有效的新窗口应写回调度器跟踪的重置时刻');
    assert.equal(account.windowSource, 'usage:seven_day');
    // 用满的窗口才是这一发被拒的原因；5 小时窗口只用了 10%，重置得再早也不是它
    assert.equal(account.consecutiveFailures, 0, '等额度不算失败');
  } finally {
    failWith = null;
    usageOk = false;
    usageWindows = [];
    await sched.stop();
    store.close();
  }
});

test('额度接口说窗口都已重置时，失败仍然按失败处理', async () => {
  const store = makeStore();
  failWith = { id: 'codex:a@x.com', status: 500 };
  usageOk = true;
  usageWindows = [
    { name: '5h', resetAt: Date.now() - 1000, usedPercent: 3, windowMinutes: 300, source: 'usage:5h' },
  ];
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    ...ALL_DAY,
    include: ['a@x.com'],
    maxRetries: 1,
  });

  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 400));

    const account = (await sched.snapshot()).find((a) => a.id === 'codex:a@x.com')!;
    assert.equal(account.state, 'error', '额度已重置还发不出去，就是真的出问题了');
    assert.equal(account.nextDueAt, null);
  } finally {
    failWith = null;
    usageOk = false;
    usageWindows = [];
    await sched.stop();
    store.close();
  }
});

for (const invalidRefresh of [
  { name: '空窗口', ok: false, windows: [] },
  { name: '成功但空窗口', ok: true, windows: [] },
  {
    name: '已过期窗口',
    ok: true,
    windows: [
      { name: '5h', resetAt: Date.now() - 1000, usedPercent: 100, windowMinutes: 300, source: 'usage:expired' },
    ],
  },
  {
    name: 'NaN resetAt',
    ok: true,
    windows: [
      { name: '5h', resetAt: Number.NaN, usedPercent: 100, windowMinutes: 300, source: 'usage:nan' },
    ],
  },
  {
    name: 'Infinity resetAt',
    ok: true,
    windows: [
      { name: '5h', resetAt: Number.POSITIVE_INFINITY, usedPercent: 100, windowMinutes: 300, source: 'usage:infinity' },
    ],
  },
  {
    name: '有效与已过期窗口混合',
    ok: true,
    windows: [
      { name: '5h', resetAt: Date.now() + 60_000, usedPercent: 100, windowMinutes: 300, source: 'usage:valid' },
      { name: '7d', resetAt: Date.now() - 1000, usedPercent: 100, windowMinutes: 10080, source: 'usage:expired' },
    ],
  },
]) {
  test(`额度刷新返回${invalidRefresh.name}时保留原调度并告警`, async () => {
    const store = makeStore();
    const previousWindow: Window = {
      name: '5h',
      resetAt: Date.now() + 60_000,
      usedPercent: 100,
      windowMinutes: 300,
      source: 'usage:previous',
    };
    const previousDue = previousWindow.resetAt + 5000;
    store.recordUsage(
      'codex:a@x.com',
      { windows: [previousWindow], plan: '', subscriptionEndsAt: null, checkedAt: Date.now() - 1000 },
      previousWindow,
    );
    store.setNextDue('codex:a@x.com', previousDue);
    usageOk = invalidRefresh.ok;
    usageWindows = invalidRefresh.windows;
    const sched = new Scheduler(store, { ...DEFAULT_CONFIG, ...ALL_DAY, include: ['a@x.com'] });
    const account = (await loadAccounts(''))[0];
    assert.ok(account);

    try {
      const pending = await sched['quotaReset'](account, true);
      const state = store.getState(account.id);

      assert.deepEqual(pending, previousWindow, '应继续使用上一次有效窗口');
      assert.equal(state?.lastResetAt, previousWindow.resetAt, '无效刷新不能覆盖已跟踪窗口');
      assert.equal(state?.nextDueAt, previousDue, '无效刷新不能改写下一拍');
      assert.deepEqual(state?.windows, [previousWindow], '无效刷新不能覆盖完整窗口快照');
      assert.ok(
        store.recentLogs().some((entry) => entry.level === 'warn' && entry.accountId === account.id),
        '无效刷新应留下警告',
      );
    } finally {
      usageOk = false;
      usageWindows = [];
      store.close();
    }
  });
}

/**
 * 真实事故的回归：跟随客户端的账户 token 过期，客户端还没续期，调度器把「暂时拿不到令牌」
 * 当成终局，写下「未取得限额窗口重置时间，停止调度」就把账户停了——而客户端续期之后本来
 * 一切照旧，代价却是保活断到有人发现为止。
 */
test('令牌还没续期时接着等，不把账户停掉', async () => {
  const store = makeStore();
  const before = sends.length;
  tokenReady = false;
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    ...ALL_DAY,
    include: ['a@x.com'],
    bufferSeconds: 0,
    jitterSeconds: 0,
    // 等令牌的间隔从它翻倍，压到 0.2 秒才好在一个用例里看到两轮
    retryBackoffSeconds: 0.2,
  });

  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 300));

    let account = (await sched.snapshot()).find((a) => a.id === 'codex:a@x.com')!;
    assert.equal(account.state, 'waiting', '等客户端续期不是故障，账户该继续等');
    assert.ok((account.nextDueAt ?? 0) > Date.now(), '应排出下一次再看的时刻');
    assert.equal(account.consecutiveFailures, 0, '拿不到令牌不是发送失败');
    assert.equal(sends.length, before, '没令牌就不该真的发出去');

    // 客户端续期之后，下一次重试就该照常发出去，并按上游窗口接着排
    tokenReady = true;
    await new Promise((r) => setTimeout(r, 1200));

    assert.ok(sends.length > before, '令牌一恢复就该继续保活');
    account = (await sched.snapshot()).find((a) => a.id === 'codex:a@x.com')!;
    assert.equal(account.state, 'waiting');
    assert.equal(account.lastError, '', '发出去之后不该留着等令牌时的提示');
    assert.ok((account.nextDueAt ?? 0) > Date.now(), '应按上游窗口排下一拍');
  } finally {
    tokenReady = true;
    await sched.stop();
    store.close();
  }
});

/**
 * 令牌是在 worker 之外换掉的：后台额度刷新从客户端同步到新的一份，写回磁盘。
 * 快照要是只认 worker 启动那一刻读进来的账户，卡片上的有效期就一直停在换之前。
 */
test('别处换到的新令牌要反映到卡片的有效期上', async () => {
  const store = makeStore();
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    ...ALL_DAY,
    include: ['a@x.com'],
  });

  try {
    await sched.start();
    const before = (await sched.snapshot()).find((a) => a.id === 'codex:a@x.com')!;
    assert.equal(before.tokenExpiresAt, diskExpiresAt);

    diskExpiresAt += 3600_000;
    const after = (await sched.snapshot()).find((a) => a.id === 'codex:a@x.com')!;
    assert.equal(after.tokenExpiresAt, diskExpiresAt, '磁盘上更新的那份才是当前令牌');
  } finally {
    await sched.stop();
    store.close();
  }
});

test('每日窗口关着时不发送，等到下一次开窗', async () => {
  const store = makeStore();
  // A one-minute window that closed an hour ago, so today's slot is already over
  const past = new Date(Date.now() - 3600_000);
  const hhmm = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const end = new Date(past.getTime() + 60_000);

  const before = sends.length;
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    dailyStart: hhmm(past),
    dailyEnd: hhmm(end),
    include: ['a@x.com'],
  });
  await sched.start();
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(sends.length, before, '窗口外不应发送');
  const status = sched.status();
  assert.equal(status.withinWindow, false);
  assert.ok(status.windowEdgeAt !== null && status.windowEdgeAt > Date.now(), '应给出下次开窗时刻');

  const view = (await sched.snapshot()).find((a) => a.id === 'codex:a@x.com')!;
  assert.equal(view.state, 'waiting');

  await sched.stop();
  store.close();
});

test('只启动选中的账户，其余账户照常出现在界面上但不跑', async () => {
  const store = makeStore();
  const sched = new Scheduler(store, { ...DEFAULT_CONFIG, ...ALL_DAY });

  const before = sends.length;
  try {
    await sched.start(['codex:b@x.com']);
    await new Promise((r) => setTimeout(r, 300));

    assert.deepEqual(sched.status().accountIds, ['codex:b@x.com'], '只有选中的账户进调度');

    const fired = sends.slice(before).map((s) => s.id);
    assert.ok(fired.length > 0, '选中的账户应该真的发出去了');
    assert.ok(!fired.includes('codex:a@x.com'), '没选中的账户不应发送');

    // 没选中的账户仍要留在列表里，否则它在运行期间会整个从界面上消失
    const snap = await sched.snapshot();
    assert.equal(snap.length, 2);
    assert.equal(snap.find((a) => a.id === 'codex:a@x.com')!.state, 'stopped');
  } finally {
    await sched.stop();
    store.close();
  }
});

test('选中的账户一个都不可保活时不退回全部账户', async () => {
  const store = makeStore();
  const sched = new Scheduler(store, { ...DEFAULT_CONFIG, ...ALL_DAY });

  const before = sends.length;
  await sched.start(['codex:nobody@x.com']);
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(sched.running, false, '没有可跑的账户就不该进入运行态');
  assert.equal(sends.length, before, '不应悄悄按“全部账户”启动');
  store.close();
});

test('include / exclude 过滤生效', async () => {
  const store = makeStore();
  const sched = new Scheduler(store, { ...DEFAULT_CONFIG, include: ['b@x.com'] });
  const snap = await sched.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].id, 'codex:b@x.com');
  store.close();
});

test('sleepUntil 被中止时立即返回 false', async () => {
  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(), 100);
  const finished = await sleepUntil(Date.now() + 60_000, ac.signal, undefined, 50);
  assert.equal(finished, false);
  assert.ok(Date.now() - started < 1000, '应立刻返回而不是等满 60 秒');
});

test('sleepUntil 对已过去的时刻立即返回 true', async () => {
  const ac = new AbortController();
  assert.equal(await sleepUntil(Date.now() - 1000, ac.signal), true);
});

/**
 * 真实事故的回归：09/08 那一发撞上周额度用满，下一拍排到 09/13 周窗口重置。几天后周额度
 * 早就放出来了，5 小时窗口一小时后就重置，账户却还在那儿等着 09/13——排一次就定死的话，
 * 保活会在最需要它的时候整整停一周。
 */
test('等待期间周额度放开后，改到 5 小时窗口那一拍', async () => {
  const store = makeStore();
  const fiveHourReset = Date.now() + 1500;
  const weeklyReset = Date.now() + 3600_000;
  // 上一拍是照用满的周窗口排的，等到一小时后
  store.setNextDue('codex:a@x.com', weeklyReset);
  usageOk = true;
  usageWindows = [
    { name: 'five_hour', resetAt: fiveHourReset, usedPercent: 8, windowMinutes: 300, source: 'usage:five_hour' },
    { name: 'seven_day', resetAt: weeklyReset, usedPercent: 46, windowMinutes: 10080, source: 'usage:seven_day' },
  ];
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    ...ALL_DAY,
    include: ['a@x.com'],
    bufferSeconds: 0,
    jitterSeconds: 0,
    // 0.3 秒核对一次，好在一个用例里看到改期
    usageRefreshMinutes: 0.005,
  });

  const before = sends.length;
  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 600));

    const view = (await sched.snapshot()).find((a) => a.id === 'codex:a@x.com')!;
    assert.equal(view.state, 'waiting');
    assert.equal(view.nextDueAt, fiveHourReset, '周额度还有，就该等 5 小时窗口');
    assert.equal(sends.length, before, '改期不等于立刻发送');

    // 改完的那一拍到点时要真的发出去
    await new Promise((r) => setTimeout(r, 1200));
    assert.ok(sends.length > before, '应按改过的时刻发出去');
  } finally {
    usageOk = false;
    usageWindows = [];
    await sched.stop();
    store.close();
  }
});

test('周额度仍然用满时不提前，继续等周窗口', async () => {
  const store = makeStore();
  const weeklyReset = Date.now() + 3600_000;
  store.setNextDue('codex:a@x.com', weeklyReset);
  usageOk = true;
  usageWindows = [
    { name: 'five_hour', resetAt: Date.now() + 1500, usedPercent: 8, windowMinutes: 300, source: 'usage:five_hour' },
    { name: 'seven_day', resetAt: weeklyReset, usedPercent: 100, windowMinutes: 10080, source: 'usage:seven_day' },
  ];
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    ...ALL_DAY,
    include: ['a@x.com'],
    bufferSeconds: 0,
    jitterSeconds: 0,
    usageRefreshMinutes: 0.005,
  });

  const before = sends.length;
  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 2000));

    const view = (await sched.snapshot()).find((a) => a.id === 'codex:a@x.com')!;
    assert.equal(view.nextDueAt, weeklyReset, '周额度没到点，5 小时窗口重置了也发不出去');
    assert.equal(sends.length, before, '不该在周窗口重置之前发送');
  } finally {
    usageOk = false;
    usageWindows = [];
    await sched.stop();
    store.close();
  }
});

/**
 * 兜底窗口只能用来提前，不能用来往后拖：上游这一刻只报得出周窗口时，把下一拍推到一周后
 * 就等于放着 5 小时窗口不管——而它多半只是已经关了，按原计划发出去就好。
 */
test('核对时只读得到周窗口，不把下一拍往后拖', async () => {
  const store = makeStore();
  const soon = Date.now() + 1200;
  store.setNextDue('codex:a@x.com', soon);
  usageOk = true;
  usageWindows = [
    { name: 'seven_day', resetAt: Date.now() + 3600_000, usedPercent: 30, windowMinutes: 10080, source: 'usage:seven_day' },
  ];
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    ...ALL_DAY,
    include: ['a@x.com'],
    bufferSeconds: 0,
    jitterSeconds: 0,
    usageRefreshMinutes: 0.005,
  });

  const before = sends.length;
  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(
      store.getState('codex:a@x.com')?.nextDueAt,
      soon,
      '说不清的窗口不该把已经排好的那一拍推走',
    );

    await new Promise((r) => setTimeout(r, 900));
    assert.ok(sends.length > before, '原定那一拍照常发出去');
  } finally {
    usageOk = false;
    usageWindows = [];
    await sched.stop();
    store.close();
  }
});

/**
 * 真实事故的回归：codex 用量为 0 时，额度接口报的 5 小时窗口是「从你问的这一刻起再过
 * 5 小时」——每查一次就往后挪一次。调度器把它当成门槛照它改期，06:00 那一拍被一路推到
 * 12:06，整个上午一条都没发出去，而日志里每半小时一条「按 primary 窗口重排」，看着一切正常。
 */
test('窗口还没开始计时时，补一发把它打开，而不是把下一拍往后推', async () => {
  const store = makeStore();
  const due = Date.now() + 3600_000;
  store.setNextDue('codex:a@x.com', due);
  usageOk = true;
  // 用量 0%，重置时刻恰好是一整个窗口之后：这不是门槛，是「额度是满的，该发了」
  usageWindows = [
    {
      name: 'primary',
      resetAt: Date.now() + 300 * 60_000,
      usedPercent: 0,
      windowMinutes: 300,
      source: 'usage:primary_window',
    },
  ];

  const before = sends.length;
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    ...ALL_DAY,
    include: ['a@x.com'],
    bufferSeconds: 0,
    jitterSeconds: 0,
    // 0.3 秒核对一次，好在一个用例里看到它的反应
    usageRefreshMinutes: 0.005,
  });

  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 600));

    assert.ok(sends.length > before, '没有窗口在计时，核对时就该补一发，而不是干等一小时');
    assert.ok(
      (store.getState('codex:a@x.com')?.nextDueAt ?? 0) < due,
      '更不该照那个会一直往后挪的重置时刻改期',
    );
  } finally {
    usageOk = false;
    usageWindows = [];
    await sched.stop();
    store.close();
  }
});

/**
 * 补发要有个上限：万一哪天上游把正在计时的窗口也报成「剩余等于整窗」，也只能每个窗口
 * 多发一条，不能变成每核对一次发一条。
 */
test('距上次发送不足一个窗口时不补发', async () => {
  const store = makeStore();
  store.recordSend({
    accountId: 'codex:a@x.com',
    sentAt: Date.now() - 1000,
    ok: true,
    resetAt: null,
    source: '',
    usedPercent: null,
    error: '',
  });
  const due = Date.now() + 3600_000;
  store.setNextDue('codex:a@x.com', due);
  usageOk = true;
  usageWindows = [
    {
      name: 'primary',
      resetAt: Date.now() + 300 * 60_000,
      usedPercent: 0,
      windowMinutes: 300,
      source: 'usage:primary_window',
    },
  ];

  const before = sends.length;
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG, ...ALL_DAY, include: ['a@x.com'], usageRefreshMinutes: 0.005,
  });

  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 600));

    assert.equal(sends.length, before, '刚发过一发，这个窗口不必再补');
    assert.equal(store.getState('codex:a@x.com')?.nextDueAt, due, '也不该改期');
  } finally {
    usageOk = false;
    usageWindows = [];
    await sched.stop();
    store.close();
  }
});

/** 反过来：起跑时读到的窗口没在计时，说明额度是满的，这一发正该发出去。 */
test('起跑时窗口还没开始计时，照常发第一拍', async () => {
  const store = makeStore();
  usageOk = true;
  usageWindows = [
    {
      name: 'primary',
      resetAt: Date.now() + 300 * 60_000,
      usedPercent: 0,
      windowMinutes: 300,
      source: 'usage:primary_window',
    },
  ];

  const before = sends.length;
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG, ...ALL_DAY, include: ['a@x.com'], bufferSeconds: 0, jitterSeconds: 0,
  });
  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(sends.length > before, '没有窗口在计时，点了启动就该发');
  } finally {
    usageOk = false;
    usageWindows = [];
    await sched.stop();
    store.close();
  }
});
