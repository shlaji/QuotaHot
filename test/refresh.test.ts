import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig, Window } from '../src/shared/types.js';

/**
 * 只读刷新（界面上的查额度按钮、后台定时器）写回库里的那个窗口，必须和调度器排下一拍
 * 跟的是同一个：两边一旦各挑各的，卡片上显示的重置时刻就和实际等待的时刻对不上。
 */

let usageOk = true;
let usageWindows: Window[] = [];

mock.module('../src/server/usage.js', {
  exports: {
    queryUsage: async () => ({
      ok: usageOk,
      status: 200,
      error: '',
      windows: usageWindows,
      plan: 'max',
      subscriptionEndsAt: null,
      resetCredits: null,
      resetCreditsExpiresAt: null,
    }),
  },
});

mock.module('../src/server/creds.js', {
  exports: {
    ensureFresh: async () => true,
    // 这几个是 import 链上别的模块要的；少一个导出，整条链都起不来
    emailOf: () => '',
    auditOf: () => ({}),
    identityOf: () => ({ kind: 'unknown', who: '' }),
    whoOf: () => '',
    loadAccounts: async () => [
      {
        id: 'claude:a@x.com', provider: 'claude', email: 'a@x.com', path: '/tmp/a.json',
        accountId: 'aid', accessToken: 't', refreshToken: 'r',
        expiresAt: Date.now() + 86400_000, disabled: false,
      },
    ],
  },
});

const { refreshAccountUsage, nextRefreshDelay, shouldRefreshUsage } = await import(
  '../src/server/refresh.js'
);
const { nextSendWindow } = await import('../src/server/ratelimit.js');
const { Store } = await import('../src/server/store.js');

function makeStore() {
  return new Store(join(mkdtempSync(join(tmpdir(), 'quotahot-')), 'state.db'));
}

const ID = 'claude:a@x.com';

test('刷新跟踪的窗口跟调度器一致：周额度用满时记周窗口，而不是更早重置的 5 小时窗口', async () => {
  const store = makeStore();
  const now = Date.now();
  usageOk = true;
  usageWindows = [
    { name: '5h', resetAt: now + 3600_000, usedPercent: 12, windowMinutes: 300, source: 'usage:5h' },
    { name: 'seven_day', resetAt: now + 111_600_000, usedPercent: 100, windowMinutes: 10080, source: 'usage:seven_day' },
  ];

  await refreshAccountUsage(store, ID);

  const st = store.getState(ID)!;
  const target = nextSendWindow(usageWindows, now)!;
  assert.equal(target.name, 'seven_day', '前提：挡路的是周窗口');
  assert.equal(st.lastResetAt, target.resetAt, '记的应是挡路的窗口，不是先重置的那个');
  assert.equal(st.usedPercent, 100);
  assert.equal(st.lastSource, 'usage:seven_day');
  assert.equal(st.windows.length, 2, '两个窗口都要留给界面显示');
  store.close();
});

test('窗口全过点时不覆盖上一次记录，免得界面上写着一个过去的重置时刻', async () => {
  const store = makeStore();
  const now = Date.now();
  usageOk = true;
  usageWindows = [
    { name: '5h', resetAt: now + 3600_000, usedPercent: 40, windowMinutes: 300, source: 'usage:5h' },
  ];
  await refreshAccountUsage(store, ID);
  const tracked = store.getState(ID)!.lastResetAt;
  assert.equal(tracked, now + 3600_000);

  // 上游偶尔会把已经重置掉的窗口继续报回来
  usageWindows = [
    { name: '5h', resetAt: now - 1000, usedPercent: 100, windowMinutes: 300, source: 'usage:stale' },
  ];
  await refreshAccountUsage(store, ID);

  const st = store.getState(ID)!;
  assert.equal(st.lastResetAt, tracked, '过期窗口不该顶掉上一次跟踪的时刻');
  assert.equal(st.lastSource, 'usage:5h');
  assert.equal(st.windows[0].source, 'usage:stale', '但最新查到的窗口本身照常写回');
  store.close();
});

test('查询失败时什么都不写', async () => {
  const store = makeStore();
  usageOk = false;
  usageWindows = [];
  const r = await refreshAccountUsage(store, ID);
  assert.equal(r?.ok, false);
  assert.equal(store.getState(ID), null, '失败的查询不该留下状态行');
  store.close();
});

test('账户不存在时交白卷，由调用方给 404', async () => {
  const store = makeStore();
  assert.equal(await refreshAccountUsage(store, 'claude:nobody@x.com'), null);
  store.close();
});

/**
 * 界面上的刷新按钮和后台定时器走的是同一个 refreshOne，两边都得把这一轮的查询时刻写回：
 * 调度器读缓存时靠 usage_checked_at 判断这份窗口新不新，时刻不往前走，它就分不出
 * 手里这份是刚查的还是上一轮的。
 */
test('刷新把这一轮的查询时刻写回，后一轮盖过前一轮', async () => {
  const store = makeStore();
  const resetAt = Date.now() + 300 * 60_000;
  usageOk = true;
  usageWindows = [
    { name: '5h', resetAt, usedPercent: 10, windowMinutes: 300, source: 'usage:5h' },
  ];

  const before = Date.now();
  await refreshAccountUsage(store, ID);
  const first = store.getState(ID)!;
  assert.ok(first.usageCheckedAt >= before, '查询时刻要记下来');

  // 后台定时器那一轮走的是同一条路径
  usageWindows = [
    { name: '5h', resetAt, usedPercent: 40, windowMinutes: 300, source: 'usage:5h' },
  ];
  await new Promise((r) => setTimeout(r, 20));
  await refreshAccountUsage(store, ID);
  const second = store.getState(ID)!;
  assert.ok(second.usageCheckedAt > first.usageCheckedAt, '时刻要跟着这一轮往前走');
  assert.equal(second.windows[0].usedPercent, 40, '窗口也是这一轮的');
  store.close();
});

/**
 * 后台刷新的门禁：只在每日时段内刷。
 *
 * 时段外没有账户会发送，那时还按周期去打上游的额度接口，只是在给它自己的限流计数加数，
 * 而那个计数和发送共用——凌晨白加的每一笔，都可能让天亮后第一拍的窗口查询撞上 429。
 */
const { DEFAULT_CONFIG } = await import('../src/server/config.js');

function cfgWith(over: Partial<AppConfig>): AppConfig {
  return { ...DEFAULT_CONFIG, ...over };
}

/** 今天本地时间的 HH:MM 那一刻。 */
function todayAt(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

test('时段内按周期刷，时段外一轮都不刷', () => {
  const cfg = cfgWith({ usageRefreshMinutes: 10, dailyStart: '06:00', dailyEnd: '23:00' });
  assert.equal(shouldRefreshUsage(cfg, todayAt('06:00')), true, '开窗那一刻就该刷');
  assert.equal(shouldRefreshUsage(cfg, todayAt('12:00')), true);
  assert.equal(shouldRefreshUsage(cfg, todayAt('22:59')), true);
  assert.equal(shouldRefreshUsage(cfg, todayAt('23:00')), false, '关窗那一刻起就停');
  assert.equal(shouldRefreshUsage(cfg, todayAt('03:00')), false);
});

test('跨零点的时段照样认，全天时段则一直刷', () => {
  const overnight = cfgWith({ usageRefreshMinutes: 10, dailyStart: '22:00', dailyEnd: '06:00' });
  assert.equal(shouldRefreshUsage(overnight, todayAt('23:30')), true);
  assert.equal(shouldRefreshUsage(overnight, todayAt('02:00')), true);
  assert.equal(shouldRefreshUsage(overnight, todayAt('12:00')), false);

  const allDay = cfgWith({ usageRefreshMinutes: 10, dailyStart: '06:00', dailyEnd: '06:00' });
  assert.equal(shouldRefreshUsage(allDay, todayAt('03:00')), true, '两端相等是全天');
});

test('周期设成 0 就只剩手动，时段内也不刷', () => {
  const cfg = cfgWith({ usageRefreshMinutes: 0, dailyStart: '06:00', dailyEnd: '23:00' });
  assert.equal(shouldRefreshUsage(cfg, todayAt('12:00')), false);
});

/**
 * 时段外醒来一次做不成任何事，因此干脆睡到开窗。但不能真睡到那一刻就不管了：用户随时可能
 * 把时段改宽，睡过头的话，改完要等到按旧时段算出来的开窗时刻才认账。
 */
test('时段外睡到开窗，但以一个周期封顶', () => {
  const cfg = cfgWith({ usageRefreshMinutes: 10, dailyStart: '06:00', dailyEnd: '23:00' });
  const period = 10 * 60_000;

  assert.equal(nextRefreshDelay(cfg, todayAt('12:00')), period, '时段内就是一个周期');

  // 23:55 距开窗还有 6 小时 05 分，远超一个周期
  assert.equal(nextRefreshDelay(cfg, todayAt('23:55')), period, '离开窗太远时按周期回来看一眼');

  // 05:57 距开窗只剩 3 分钟，这时就该正好睡到开窗，而不是错过 6 分钟
  assert.equal(nextRefreshDelay(cfg, todayAt('05:57')), 3 * 60_000, '临近开窗就睡到那一刻');
});

test('周期为 0 时仍会回来看一眼，好让改回非 0 能生效', () => {
  const cfg = cfgWith({ usageRefreshMinutes: 0, dailyStart: '06:00', dailyEnd: '23:00' });
  assert.equal(nextRefreshDelay(cfg, todayAt('03:00')), 10 * 60_000);
});
