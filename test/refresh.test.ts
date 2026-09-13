import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Window } from '../src/shared/types.js';

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
    // 这两个是 import 链上别的模块要的；少一个导出，整条链都起不来
    emailOf: () => '',
    auditOf: () => ({}),
    loadAccounts: async () => [
      {
        id: 'claude:a@x.com', provider: 'claude', email: 'a@x.com', path: '/tmp/a.json',
        accountId: 'aid', accessToken: 't', refreshToken: 'r',
        expiresAt: Date.now() + 86400_000, disabled: false,
      },
    ],
  },
});

const { refreshAccountUsage } = await import('../src/server/refresh.js');
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
