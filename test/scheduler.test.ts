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
/**
 * 不为 null 时，这个账户的每一发都按上游拒绝处理。
 * windows 用来摆出「额度接口不肯说话，只剩 CLI 原话」那种响应。
 */
let failWith: { id: string; status: number; windows?: Window[] } | null = null;
/** 不为 null 时，发送响应就按这份窗口回答；用来摆出「这一发只报得出周窗口」这种情形。 */
let sendWindows: Window[] | null = null;
/**
 * 额度接口的回答。发送失败之后调度器会回头问它一次，确认是「额度还没重置」还是真的坏了；
 * 默认答“问不出窗口”，个别用例再摆一个未到点的窗口进去。
 */
let usageOk = false;
let usageWindows: Window[] = [];
/** 上游对「现在能不能发」的结论；只有 codex 会给，Claude 那边恒为 null。 */
/** 令牌能不能用。跟随客户端的账户在客户端续期之前，ensureFresh 就是答不出来的。 */
let tokenReady = true;
/** 账户文件里记的到期时间。别处（后台额度刷新、界面上查额度）换到新令牌时，变的就是它。 */
let diskExpiresAt = Date.now() + 86400_000;

const ON_DISK = [
  { id: 'codex:a@x.com', provider: 'codex', email: 'a@x.com', path: '/tmp/a.json', accountId: 'aid' },
  { id: 'codex:b@x.com', provider: 'codex', email: 'b@x.com', path: '/tmp/b.json', accountId: 'bid' },
];
/** 此刻账户目录里还剩哪些；改它就等于用户在界面上删掉了一个账户。 */
let diskAccountIds = ON_DISK.map((a) => a.id);
/** 置真时读账户目录直接抛错，用来分清「账户没了」和「磁盘抖了一下」。 */
let loadAccountsFails = false;

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
          windows: failWith.windows ?? [],
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
          : sendWindows ?? [
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
    // 调度器经 clientsync 用到它来判断目标配置文件原先属于谁，经 inuse 用后两个认出
    // 本机客户端在用哪个账户；模块里少一个导出，整条 import 链都起不来
    emailOf: () => '',
    identityOf: () => ({ kind: 'unknown', who: '' }),
    whoOf: () => '',
    loadAccounts: async () => {
      if (loadAccountsFails) throw new Error('EIO: 账户目录读不动');
      return ON_DISK.filter((a) => diskAccountIds.includes(a.id)).map((a) => ({
        ...a,
        accessToken: 't',
        refreshToken: 'r',
        expiresAt: diskExpiresAt,
        disabled: false,
      }));
    },
  },
});

const { Scheduler, sleepUntil } = await import('../src/server/scheduler.js');
const { Store } = await import('../src/server/store.js');
const { DEFAULT_CONFIG } = await import('../src/server/config.js');
const { loadAccounts } = await import('../src/server/creds.js');
const { nextSendWindow } = await import('../src/server/ratelimit.js');

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'quotahot-'));
  return new Store(join(dir, 'state.db'));
}

/** Equal ends mean an all-day window, i.e. the daily schedule never gates the test. */
const ALL_DAY = { dailyStart: '00:00', dailyEnd: '00:00' };

/**
 * 等待期间醒来的粒度；调小到 0.1 秒，好在一个用例里看到改期。
 * 生产里是一分钟，见 WINDOW_TICK_MS。
 */
const FAST_TICK = 100;

/**
 * 模拟「界面上点了一次查询额度」：把窗口写进库。
 *
 * 等待中的账户认的就是这份数据换了新的——程序自己不会在等待期去问上游，额度查询只发生在
 * 发送前后和这个按钮上。
 */
function publishUsage(store: InstanceType<typeof Store>, id: string, windows: Window[]): void {
  const checkedAt = Date.now();
  store.recordUsage(
    id,
    { windows, plan: '', subscriptionEndsAt: null, checkedAt },
    nextSendWindow(windows, checkedAt),
  );
}

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
    assert.equal(account.state, 'waiting', '读不出窗口不是终局，等一会儿再发一次就是了');
    assert.match(account.lastError, /未取得限额窗口重置时间/);

    const due = account.nextDueAt ?? 0;
    assert.ok(due > Date.now(), '下一拍照退避排出来，而不是停掉');
    assert.ok(due < Date.now() + 10 * 60_000, '这是重来的退避，不是凭空造出来的窗口');
    const stored = store.getState('codex:a@x.com');
    assert.equal(stored?.plannedResetAt ?? 0, 0, '这一拍不是照窗口排的，别在库里记一个假窗口');
  } finally {
    omitResetFor = null;
    await sched.stop();
    store.close();
  }
});

test('发送时缺少 resetAt 应把残留的 nextDue 换成重来那一拍', async () => {
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
    assert.equal(account.state, 'waiting');
    const due = account.nextDueAt ?? 0;
    assert.ok(due > Date.now(), '已经过点的那个旧 nextDue 不应残留');
    const stored = store.getState('codex:a@x.com');
    assert.equal(stored?.nextDueAt ?? 0, due, '持久化的也是重来那一拍');
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
    assert.equal(account.state, 'waiting');
    assert.match(account.lastError, /未取得限额窗口重置时间/);
    assert.equal(sends.length - before, 1, '无效 resetAt 后要退避着等，不能立刻接着发');
  } finally {
    resetOffsetMs = 0;
    await sched.stop();
    store.close();
  }
});

/**
 * 额度接口自己也在限流、只剩 CLI 那句原话可用时，走的是 providers.hintedWindow：
 * name 7d、usedPercent 为 null。它既不算「用满」也不是 5 小时窗口，一旦被当成兜底窗口，
 * cappedResetAt 会把等待砍到 5 小时——于是整整一周每 5 小时去撞一次，次次被顶回来，
 * 而 noteLimited 每次都清掉失败计数，日志里看着一切正常。
 */
test('CLI 报出来的周限要照它的重置时刻等，不能按 5 小时封顶', async () => {
  const store = makeStore();
  const resetAt = Date.now() + 7 * 24 * 3600_000;
  failWith = {
    id: 'codex:a@x.com',
    status: 429,
    // usedPercent 为 null 正是 hintedWindow 的样子：CLI 只说了什么时候重置，没说用了多少
    windows: [{ name: '7d', resetAt, usedPercent: null, windowMinutes: 10080, source: 'cli-message' }],
  };
  usageOk = false;
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
    assert.equal(account.state, 'waiting', '撞周限不是故障');
    assert.equal(account.nextDueAt, resetAt, '应等到 CLI 报的那个重置时刻');
    assert.ok(
      (account.nextDueAt ?? 0) - Date.now() > 6 * 24 * 3600_000,
      '不能被砍成 5 小时后再撞一次',
    );
    assert.equal(account.consecutiveFailures, 0, '等额度不算失败');
  } finally {
    failWith = null;
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

/**
 * 额度是满的还发不出去，那就是真的出问题了：这一拍要计进失败，而不是被当成「在等额度」
 * 清零重来。但也不能就此把账户停死——见下面「重试耗尽不停掉账户」那条。
 */
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
    assert.ok(account.consecutiveFailures > 0, '这一拍要计进失败，不能当成在等额度清零');
    const due = account.nextDueAt ?? 0;
    assert.ok(
      due > 0 && due < Date.now() + 10 * 60_000,
      '不该假装在等额度排一拍去睡几个小时，退避之后再来一次',
    );
  } finally {
    failWith = null;
    usageOk = false;
    usageWindows = [];
    await sched.stop();
    store.close();
  }
});

/**
 * 一整拍都发不出去，仍然只是「这一阵子不行」：上游 5xx、网络抖一下都长这个样子，等下一个
 * 周期再发一次就是了。停掉账户才是真正的坏结果——保活断到有人发现并手动重启为止，而这
 * 恰恰是最不容易被发现的一种断。认证被拒那种另说，它等谁都不会好，见 giveUp。
 */
test('重试耗尽不停掉账户，退避之后照样再来一拍', async () => {
  const store = makeStore();
  const before = sends.length;
  failWith = { id: 'codex:a@x.com', status: 500 };
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG, ...ALL_DAY, include: ['a@x.com'], maxRetries: 1, retryBackoffSeconds: 1,
  });
  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 1500));

    const view = (await sched.snapshot()).find((a) => a.id === 'codex:a@x.com')!;
    assert.ok(sends.length - before >= 2, '退避到点之后要自己再发一次，不用人来重启');
    assert.notEqual(view.state, 'error', '还在调度里，不是停掉的状态');
    assert.ok((view.nextDueAt ?? 0) > 0, '界面上要看得见下一拍什么时候');
    assert.ok(view.consecutiveFailures > 0, '失败计数照常留着，连着失败多少次得看得见');
  } finally {
    failWith = null;
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
  const finished = await sleepUntil(Date.now() + 60_000, ac.signal, 50);
  assert.equal(finished, false);
  assert.ok(Date.now() - started < 1000, '应立刻返回而不是等满 60 秒');
});

test('sleepUntil 对已过去的时刻立即返回 true', async () => {
  const ac = new AbortController();
  assert.equal(await sleepUntil(Date.now() - 1000, ac.signal), true);
});

/**
 * 点「查询额度」的人正盯着卡片：改期要当场看见，而不是等下一次醒来。
 * 这里把醒来粒度放到 5 秒，再断言半秒内就改完——靠的只能是 usageChanged 那一声叫醒。
 */
test('查过额度之后立刻改期，不必等下一次醒来', async () => {
  const store = makeStore();
  const fiveHourReset = Date.now() + 3600_000;
  const weeklyReset = Date.now() + 7200_000;
  store.setNextDue('codex:a@x.com', weeklyReset);
  usageOk = true;
  usageWindows = [
    { name: 'five_hour', resetAt: fiveHourReset, usedPercent: 8, windowMinutes: 300, source: 'usage:five_hour' },
    { name: 'seven_day', resetAt: weeklyReset, usedPercent: 46, windowMinutes: 10080, source: 'usage:seven_day' },
  ];
  // 醒来粒度远大于这个用例的时长：不叫醒就绝无可能在断言之前改期
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    ...ALL_DAY,
    include: ['a@x.com'],
    bufferSeconds: 0,
    jitterSeconds: 0,
  }, 5000);

  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(store.getState('codex:a@x.com')?.nextDueAt, weeklyReset, '还没查过，照原计划等');

    publishUsage(store, 'codex:a@x.com', usageWindows);
    sched.usageChanged(['codex:a@x.com']);
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(
      store.getState('codex:a@x.com')?.nextDueAt,
      fiveHourReset,
      '查完就该照 5 小时窗口改期，而不是等满一个醒来周期',
    );
  } finally {
    usageOk = false;
    usageWindows = [];
    await sched.stop();
    store.close();
  }
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
  }, FAST_TICK);

  const before = sends.length;
  try {
    await sched.start();
    // 界面上点一次「查询额度」，等待中的账户才有新数据可照着改期
    publishUsage(store, 'codex:a@x.com', usageWindows);
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
  }, FAST_TICK);

  const before = sends.length;
  try {
    await sched.start();
    // 界面上点一次「查询额度」，等待中的账户才有新数据可照着改期
    publishUsage(store, 'codex:a@x.com', usageWindows);
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
  }, FAST_TICK);

  const before = sends.length;
  try {
    await sched.start();
    // 界面上点一次「查询额度」，等待中的账户才有新数据可照着改期
    publishUsage(store, 'codex:a@x.com', usageWindows);
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
  }, FAST_TICK);

  try {
    await sched.start();
    // 界面上点一次「查询额度」，等待中的账户才有新数据可照着改期
    publishUsage(store, 'codex:a@x.com', usageWindows);
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
    ...DEFAULT_CONFIG, ...ALL_DAY, include: ['a@x.com'],
  }, FAST_TICK);

  try {
    await sched.start();
    // 界面上点一次「查询额度」，等待中的账户才有新数据可照着改期
    publishUsage(store, 'codex:a@x.com', usageWindows);
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

/**
 * 守卫和 abort 赋值之间隔着一次读账户目录，两次启动都能挤进来的话，同一个账户会有
 * 两条循环并发发送，而日志里看不出任何异常。
 */
test('连点两次启动只起一套循环', async () => {
  const store = makeStore();
  const before = sends.length;
  const sched = new Scheduler(store, { ...DEFAULT_CONFIG, ...ALL_DAY, include: ['a@x.com'] });

  try {
    await Promise.all([sched.start(), sched.start()]);
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(sends.length - before, 1, '起跑那一拍只该发一次');
    assert.deepEqual(sched.status().accountIds, ['codex:a@x.com']);
  } finally {
    await sched.stop();
    store.close();
  }
});

/** 启动途中点停止，不该被无视。 */
test('启动还没铺开 worker 时点停止，不会照常跑起来', async () => {
  const store = makeStore();
  const sched = new Scheduler(store, { ...DEFAULT_CONFIG, ...ALL_DAY, include: ['a@x.com'] });
  const before = sends.length;

  const starting = sched.start();
  await sched.stop();
  await starting;
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(sched.running, false, '停止之后不该还在运行');
  assert.equal(sends.length, before, '已经喊停了就不该再发');
  store.close();
});

/**
 * 真实形状的回归：5 小时窗口没在计时时，上游响应里可能根本不带它的 resets_at
 * （见 usage.test.ts「缺 resets_at 的窗口被跳过」），解析下来只剩一条周窗口。
 *
 * 周额度用掉三成，丝毫不妨碍 5 小时窗口被这一发打开。凭它判定「窗口仍在计时」，
 * 第一拍会被排到周重置——而 5 小时窗口不发就永远开不出来，于是一直缺席，
 * replan 也没有它可以据此提前，账户就这么锁死好几天，日志里还写着一切正常。
 */
test('起跑时只读得到在计时的周窗口，照常发第一拍', async () => {
  const store = makeStore();
  usageOk = true;
  usageWindows = [
    {
      name: 'seven_day',
      resetAt: Date.now() + 3 * 86400_000,
      usedPercent: 30,
      windowMinutes: 10080,
      source: 'usage:seven_day',
    },
  ];

  const before = sends.length;
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG, ...ALL_DAY, include: ['a@x.com'], bufferSeconds: 0, jitterSeconds: 0,
  });
  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(sends.length > before, '周窗口不是门槛，5 小时窗口该被这一发打开');
  } finally {
    usageOk = false;
    usageWindows = [];
    await sched.stop();
    store.close();
  }
});

/**
 * hasStarted 的容差读不出刚开一分钟以内的窗口（Claude 的重置时刻按整点对齐，
 * 用量又还是 0），此时上次发送时刻才是更硬的证据：同一个窗口里补第二发同样是白发。
 */
test('起跑时窗口看着没计时，但上次发送还在这个窗口里，就不补发', async () => {
  const store = makeStore();
  const resetAt = Date.now() + 300 * 60_000;
  store.recordSend({
    accountId: 'codex:a@x.com', sentAt: Date.now() - 60_000, ok: true,
    resetAt: null, source: '', usedPercent: null, error: '',
  });
  usageOk = true;
  usageWindows = [
    { name: 'primary', resetAt, usedPercent: 0, windowMinutes: 300, source: 'usage:primary_window' },
  ];

  const before = sends.length;
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG, ...ALL_DAY, include: ['a@x.com'], bufferSeconds: 0, jitterSeconds: 0,
  });
  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(sends.length, before, '窗口是刚开的，不该补这一发');
    assert.equal(store.getState('codex:a@x.com')?.nextDueAt, resetAt, '照这个窗口排下一拍');
  } finally {
    usageOk = false;
    usageWindows = [];
    await sched.stop();
    store.close();
  }
});

/**
 * chatgpt.com 真实响应的形态（见 usage.test.ts 的 WHAM_USAGE）：周窗口用满、账户被禁发，
 * 而 5 小时窗口的 used_percent 是 0、剩余时间还是整整一个窗口——单看它会判成「额度是满的，
 * 该发了」。nextSendWindow 先还用满的那个窗口，这一拍才不会一头撞上去。
 */
test('周额度用满时，5 小时窗口看着是空的也不发这一拍', async () => {
  const store = makeStore();
  const fiveHourReset = Date.now() + 300 * 60_000;
  const weeklyReset = Date.now() + 215_346_000;
  usageOk = true;
  usageWindows = [
    { name: 'primary', resetAt: fiveHourReset, usedPercent: 0, windowMinutes: 300, source: 'usage:primary_window' },
    { name: 'secondary', resetAt: weeklyReset, usedPercent: 100, windowMinutes: 10080, source: 'usage:secondary_window' },
  ];

  const before = sends.length;
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG, ...ALL_DAY, include: ['a@x.com'], bufferSeconds: 0, jitterSeconds: 0,
  });
  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(sends.length, before, '周额度用满就是发不出去，5 小时窗口再空也别去撞');
    assert.equal(
      store.getState('codex:a@x.com')?.nextDueAt,
      weeklyReset,
      '等的是周窗口重置，不是 5 小时那个',
    );
  } finally {
    usageOk = false;
    usageWindows = [];
    await sched.stop();
    store.close();
  }
});

/**
 * 兜底窗口不能用来把下一拍推到几天后，这条在等待期的核对里已经拦着了（见「不把下一拍往后拖」），
 * 但发完那一刻排下一拍时同样要拦：5 小时窗口没出现在响应里，多半只是它已经关了，
 * 正等着被下一发打开，不发就永远开不出来。
 */
test('发送后只读得到周窗口时，下一拍按 5 小时封顶，不睡到一周后', async () => {
  const store = makeStore();
  sendWindows = [
    {
      name: 'seven_day',
      resetAt: Date.now() + 7 * 86400_000,
      usedPercent: 46,
      windowMinutes: 10080,
      source: 'header:fake',
    },
  ];

  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG, ...ALL_DAY, include: ['a@x.com'], bufferSeconds: 0, jitterSeconds: 0,
  });
  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 300));

    const view = (await sched.snapshot()).find((a) => a.id === 'codex:a@x.com')!;
    const due = view.nextDueAt ?? 0;
    assert.ok(due > Date.now() + 4 * 3600_000, '封顶之后仍然是一个完整的 5 小时窗口');
    assert.ok(due < Date.now() + 6 * 3600_000, '周窗口只用了 46%，它管不着这一发');
  } finally {
    sendWindows = null;
    await sched.stop();
    store.close();
  }
});

/**
 * 真故障不能被装扮成等额度：重试耗尽之后那次核对，只有窗口真用满了才算「等额度」。
 * 否则一个 46% 的周窗口就能把账户哄去睡上一觉，失败计数还跟着清零，保活断了没人知道。
 */
test('重试耗尽而没有窗口用满时，不拿兜底窗口把账户哄去睡觉', async () => {
  const store = makeStore();
  failWith = { id: 'codex:a@x.com', status: 500 };
  usageOk = true;
  usageWindows = [
    {
      name: 'seven_day',
      resetAt: Date.now() + 7 * 86400_000,
      usedPercent: 46,
      windowMinutes: 10080,
      source: 'usage:seven_day',
    },
  ];

  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG, ...ALL_DAY, include: ['a@x.com'], maxRetries: 1,
  });
  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 400));

    const view = (await sched.snapshot()).find((a) => a.id === 'codex:a@x.com')!;
    const due = view.nextDueAt ?? 0;
    assert.ok(view.consecutiveFailures > 0, '发不出去又没有窗口用满，那就是真的坏了');
    assert.ok(due > 0 && due < Date.now() + 10 * 60_000, '绝不能照周窗口把下一拍推到一周后');
  } finally {
    failWith = null;
    usageOk = false;
    usageWindows = [];
    await sched.stop();
    store.close();
  }
});

/**
 * 窗口交替那一刻读到的就是这种混合结果：5 小时窗口刚重置，上游还挂着旧的 7d resets_at。
 * 有一条过点就把整份新数据否决掉，账户会转而沿用一份更旧的记录。
 */
test('额度刷新返回有效与已过期窗口混合时，采用其中有效的那条', async () => {
  const store = makeStore();
  const previous: Window = {
    name: '5h', resetAt: Date.now() + 60_000, usedPercent: 100, windowMinutes: 300,
    source: 'usage:previous',
  };
  store.recordUsage(
    'codex:a@x.com',
    { windows: [previous], plan: '', subscriptionEndsAt: null, checkedAt: Date.now() - 1000 },
    previous,
  );
  const valid: Window = {
    name: '5h', resetAt: Date.now() + 3600_000, usedPercent: 100, windowMinutes: 300,
    source: 'usage:valid',
  };
  const expired: Window = {
    name: '7d', resetAt: Date.now() - 1000, usedPercent: 100, windowMinutes: 10080,
    source: 'usage:expired',
  };
  usageOk = true;
  usageWindows = [valid, expired];
  const sched = new Scheduler(store, { ...DEFAULT_CONFIG, ...ALL_DAY, include: ['a@x.com'] });
  const account = (await loadAccounts(''))[0];
  assert.ok(account);

  try {
    const pending = await sched['quotaReset'](account, true);
    const state = store.getState(account.id);

    assert.deepEqual(pending, valid, '过点的那条不该把有效的那条一起否决掉');
    assert.equal(state?.lastResetAt, valid.resetAt, '跟踪窗口应换成新读到的那条');
    assert.deepEqual(state?.windows, [valid, expired], '写回库的仍是原样的整份快照');
    assert.ok(
      !store.recentLogs().some((entry) => entry.level === 'warn' && entry.accountId === account.id),
      '这不是一次失败的刷新，不该告警',
    );
  } finally {
    usageOk = false;
    usageWindows = [];
    store.close();
  }
});

/**
 * 每日时段是用户在界面上随时会改的，而改完那一刻已经有一拍排在那儿了。
 * 只靠 replan 顺手纠正不行：它要等「上游窗口恰好也动了一次」才会重排。
 */
test('每日时段改窄后，已经排定的那一拍跟着挪出窗口外', async () => {
  const store = makeStore();
  const due = Date.now() + 500;
  store.setNextDue('codex:a@x.com', due);
  const before = sends.length;
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG, ...ALL_DAY, include: ['a@x.com'],
  }, FAST_TICK);

  try {
    await sched.start();
    // 改成一个一小时前就关掉的一分钟窗口：这一拍不该再发出去
    const past = new Date(Date.now() - 3600_000);
    const hhmm = (d: Date) =>
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    sched.setConfig({
      ...sched.getConfig(),
      dailyStart: hhmm(past),
      dailyEnd: hhmm(new Date(past.getTime() + 60_000)),
    });
    await new Promise((r) => setTimeout(r, 900));

    assert.equal(sends.length, before, '时段已经把这一拍框在窗口外了，不该照旧发出去');
    const next = store.getState('codex:a@x.com')?.nextDueAt ?? 0;
    assert.ok(next > Date.now() + 3600_000, '应顺延到下一次开窗');
  } finally {
    await sched.stop();
    store.close();
  }
});

/** 反过来：时段放宽了，被顺延到明天早上的那一拍其实现在就该发。 */
test('每日时段放宽后，被顺延到明天的那一拍提前回来', async () => {
  const store = makeStore();
  const past = new Date(Date.now() - 3600_000);
  const hhmm = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const before = sends.length;
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    dailyStart: hhmm(past),
    dailyEnd: hhmm(new Date(past.getTime() + 60_000)),
    include: ['a@x.com'],
  }, FAST_TICK);

  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sends.length, before, '时段关着，先不发');

    sched.setConfig({ ...sched.getConfig(), ...ALL_DAY });
    await new Promise((r) => setTimeout(r, 900));
    assert.ok(sends.length > before, '时段放宽之后不该还等到明天');
  } finally {
    await sched.stop();
    store.close();
  }
});

/**
 * nextWindowOpen 顺延时返回的是精确到毫秒的窗口起点，抖动加在顺延之前的时刻上，一顺延
 * 就被抹平了：跨夜等着的账户会在 06:00:00.000 一起打向上游，正是 jitterSeconds 要避免的。
 */
test('跨夜顺延的多个账户不挤在开窗那一毫秒', async () => {
  const store = makeStore();
  const before = sends.length;
  // 一个今天晚些时候才开、现在关着的时段
  const open = new Date(Date.now() + 2 * 3600_000);
  const close = new Date(open.getTime() + 3600_000);
  const hhmm = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const cfg = {
    ...DEFAULT_CONFIG,
    dailyStart: hhmm(open),
    dailyEnd: hhmm(close),
    jitterSeconds: 120,
  };

  const sched = new Scheduler(store, cfg);
  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sends.length, before, '时段关着，一个都不该发');

    const dues = ['codex:a@x.com', 'codex:b@x.com'].map((id) => store.getState(id)?.nextDueAt ?? 0);
    const openAt = new Date(open).setSeconds(0, 0);
    for (const due of dues) {
      assert.ok(due >= openAt, '这一拍不能早于开窗');
      assert.ok(due <= openAt + cfg.jitterSeconds * 1000, '错开的幅度不该超过 jitterSeconds');
      assert.ok(due > openAt, '顺延过来的这一拍要再摊开，不能正好压在开窗那一毫秒上');
    }
    assert.notEqual(dues[0], dues[1], '两个账户不该被排到同一时刻');

    // 错开量按账户派生，不是每次重摇：否则 reclamp 每分钟重框一次就会一直改期
    await sched.stop();
    await sched.start();
    await new Promise((r) => setTimeout(r, 200));
    const again = ['codex:a@x.com', 'codex:b@x.com'].map((id) => store.getState(id)?.nextDueAt ?? 0);
    assert.deepEqual(again, dues, '同一个账户每次算出来的错开量要一样');
  } finally {
    await sched.stop();
    store.close();
  }
});

/**
 * 重启续跑要把「这一拍照哪个窗口排的」一起接回来，否则等待期第一次核对必定判「变了」，
 * 于是拿一份没动过的窗口重排一次——缓冲或抖动改过之后，节奏就这么被白挪一次。
 */
test('重启续跑接回原来的排期依据，核对时不白改一次期', async () => {
  const store = makeStore();
  const resetAt = Date.now() + 3600_000;
  store.recordSend({
    accountId: 'codex:a@x.com',
    sentAt: Date.now() - 1000,
    ok: true,
    resetAt,
    source: 'header:fake',
    usedPercent: 20,
    error: '',
  });
  // 上次是照 resetAt + 30 秒缓冲排的；这次配置里的缓冲已经改成 10 分钟
  const due = resetAt + 30_000;
  store.setNextDue('codex:a@x.com', due);
  usageOk = true;
  usageWindows = [
    { name: 'primary', resetAt, usedPercent: 20, windowMinutes: 300, source: 'usage:primary' },
  ];

  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    ...ALL_DAY,
    include: ['a@x.com'],
    bufferSeconds: 600,
    jitterSeconds: 0,
  }, FAST_TICK);
  try {
    await sched.start();
    // 界面上点一次「查询额度」，等待中的账户才有新数据可照着改期
    publishUsage(store, 'codex:a@x.com', usageWindows);
    await new Promise((r) => setTimeout(r, 600));

    assert.equal(
      store.getState('codex:a@x.com')?.nextDueAt,
      due,
      '窗口一点没动，就不该照新缓冲把这一拍重排一遍',
    );
  } finally {
    usageOk = false;
    usageWindows = [];
    await sched.stop();
    store.close();
  }
});

/**
 * 「测试文本」那一发是真的会打开 5 小时窗口的。不告诉正在等的 worker，卡片上的「下次发送」
 * 就一直是旧的那个，真到点了还会白发一条被上游顶回来。
 */
test('手动发一条之后，运行中的账户跟着改期', async () => {
  const store = makeStore();
  const sched = new Scheduler(store, {
    ...DEFAULT_CONFIG,
    ...ALL_DAY,
    include: ['a@x.com'],
    bufferSeconds: 0.5,
    jitterSeconds: 0,
  }, FAST_TICK);

  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 300));
    const planned = store.getState('codex:a@x.com')?.nextDueAt ?? 0;
    assert.ok(planned > Date.now(), '起跑那一拍发完之后应排好下一拍');

    await new Promise((r) => setTimeout(r, 400));
    const result = await sched.sendNow('codex:a@x.com');
    assert.equal(result.ok, true, result.message);

    await new Promise((r) => setTimeout(r, 500));
    const after = store.getState('codex:a@x.com')?.nextDueAt ?? 0;
    assert.ok(after > planned, '手动那一发换来的新窗口应当把下一拍往后挪');
  } finally {
    await sched.stop();
    store.close();
  }
});

/**
 * 删账户、禁用、改 include/exclude 都发生在调度循环外面，而循环手里攥着启动那一刻读进来的
 * 令牌。不回头核对的话，一个已经从界面上消失的账户还会一拍一拍地发下去——用户以为删干净了，
 * 它还在打上游，而界面上连这个账户都找不到，没有任何地方看得出这件事。
 */
test('运行中删掉账户后，那条循环不再发送并退出调度', async () => {
  const store = makeStore();
  const before = sends.length;
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
    const sentWhileAlive = sends.length - before;
    assert.ok(sentWhileAlive >= 1, '前提：删之前它确实在发');
    assert.deepEqual(sched.status().accountIds, ['codex:a@x.com']);

    // 用户在界面上删掉了这个账户
    diskAccountIds = ['codex:b@x.com'];

    await new Promise((r) => setTimeout(r, windowMs + 600));
    assert.equal(sends.length - before, sentWhileAlive, '账户已删除，不该再发出任何一条');
    assert.deepEqual(sched.status().accountIds, [], '退出调度的账户不该还挂在运行列表里');
  } finally {
    diskAccountIds = ON_DISK.map((a) => a.id);
    await sched.stop();
    store.close();
  }
});

test('运行中把账户加进 exclude 后，那条循环不再发送', async () => {
  const store = makeStore();
  const before = sends.length;
  const cfg = {
    ...DEFAULT_CONFIG,
    ...ALL_DAY,
    include: ['a@x.com'],
    bufferSeconds: 0,
    jitterSeconds: 0,
  };
  const sched = new Scheduler(store, cfg);

  try {
    await sched.start();
    await new Promise((r) => setTimeout(r, 300));
    const sentWhileIncluded = sends.length - before;
    assert.ok(sentWhileIncluded >= 1, '前提：排除之前它确实在发');

    // 界面上保存了一份新配置，把它排除掉
    sched.setConfig({ ...cfg, exclude: ['a@x.com'] });

    await new Promise((r) => setTimeout(r, windowMs + 600));
    assert.equal(sends.length - before, sentWhileIncluded, '账户已被排除，不该再发出任何一条');
    assert.deepEqual(sched.status().accountIds, []);
  } finally {
    await sched.stop();
    store.close();
  }
});

/** 读不动账户目录只是一次磁盘抖动，不该把账户踢出调度——那会让保活断到有人手动重启。 */
test('重读账户目录失败时沿用手里的令牌，照常发下一拍', async () => {
  const store = makeStore();
  const before = sends.length;
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
    const sentBefore = sends.length - before;

    loadAccountsFails = true;
    await new Promise((r) => setTimeout(r, windowMs + 600));
    assert.ok(sends.length - before > sentBefore, '读盘失败不该停掉这个账户');
    assert.deepEqual(sched.status().accountIds, ['codex:a@x.com']);
  } finally {
    loadAccountsFails = false;
    await sched.stop();
    store.close();
  }
});
