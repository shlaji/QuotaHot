import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import {
  GatewayPool,
  blamesAccount,
  emptyRuntime,
  isAvailable,
  rank,
  stateOf,
  viewOf,
  type PoolEntry,
} from '../src/server/gateway/pool.js';
import { DEFAULT_ACCOUNT_SETTING, DEFAULT_GATEWAY_CONFIG, EMPTY_STAT } from '../src/shared/gateway.js';
import type { Account } from '../src/server/creds.js';
import type { AccountState } from '../src/server/store.js';
import type { GatewayConfig } from '../src/shared/gateway.js';

function tempStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'quotahot-')), 'state.db'));
}

function account(id: string, provider: Account['provider'] = 'claude', disabled = false): Account {
  return {
    id,
    provider,
    email: id,
    path: `/tmp/${id}.json`,
    accountId: '',
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAt: 0,
    disabled,
    plan: '',
    subscriptionEndsAt: 0,
    userId: '',
    loginMethod: '',
    source: 'oauth',
    autoRefresh: true,
    syncPath: '',
    syncSource: '',
    idToken: '',
  };
}

function entry(id: string, over: Partial<PoolEntry> = {}): PoolEntry {
  return {
    account: account(id),
    row: { ...DEFAULT_ACCOUNT_SETTING, ...EMPTY_STAT, enabled: true },
    runtime: emptyRuntime(),
    usedPercent: null,
    ...over,
  };
}

const CFG: GatewayConfig = { ...DEFAULT_GATEWAY_CONFIG, enabled: true };
const NOW = 1_700_000_000_000;

test('没打开开关的账户不接活，打开了就待命', () => {
  const off = entry('a', { row: { ...DEFAULT_ACCOUNT_SETTING, ...EMPTY_STAT } });
  assert.equal(stateOf(off, CFG, NOW), 'off');
  assert.equal(isAvailable('off'), false);
  assert.equal(stateOf(entry('a'), CFG, NOW), 'ready');
});

test('不支持转发的 provider 和被禁用的账户一律不可用', () => {
  const qoder = entry('q', { account: account('q', 'qoder') });
  assert.equal(stateOf(qoder, CFG, NOW), 'unusable', 'Qoder 的推理端点要官方签名，转不了');
  const disabled = entry('d', { account: account('d', 'claude', true) });
  assert.equal(stateOf(disabled, CFG, NOW), 'unusable');
});

test('冷却优先于额度判定：还在冷却里就不该说它是额度用尽', () => {
  const cooling = entry('a', {
    runtime: { ...emptyRuntime(), cooldownUntil: NOW + 5_000 },
    usedPercent: 100,
  });
  assert.equal(stateOf(cooling, CFG, NOW), 'cooling');
  // 冷却到点之后才轮到额度那条判定说话
  assert.equal(stateOf(cooling, CFG, NOW + 6_000), 'exhausted');
});

test('额度阈值按配置比，没查过额度的按能接活处理', () => {
  const cfg: GatewayConfig = { ...CFG, exhaustedPercent: 80 };
  assert.equal(stateOf(entry('a', { usedPercent: 85 }), cfg, NOW), 'exhausted');
  assert.equal(stateOf(entry('a', { usedPercent: 79 }), cfg, NOW), 'ready');
  // 用户没点过「查询额度」不该让一个好账户被排除在外
  assert.equal(stateOf(entry('a', { usedPercent: null }), cfg, NOW), 'ready');
});

test('正在转发的账户仍然可以再接：busy 是状态，不是拒绝', () => {
  const busy = entry('a', { runtime: { ...emptyRuntime(), inFlight: 2 } });
  assert.equal(stateOf(busy, CFG, NOW), 'busy');
  assert.equal(isAvailable('busy'), true);
});

test('fill-first 按优先级降序，同优先级按 id 定序，于是一个账户会被一直用到底', () => {
  const entries = [
    entry('c', { row: { ...DEFAULT_ACCOUNT_SETTING, ...EMPTY_STAT, enabled: true, priority: 1 } }),
    entry('a', { row: { ...DEFAULT_ACCOUNT_SETTING, ...EMPTY_STAT, enabled: true, priority: 1 } }),
    entry('b', { row: { ...DEFAULT_ACCOUNT_SETTING, ...EMPTY_STAT, enabled: true, priority: 5 } }),
  ];
  assert.deepEqual(
    rank(entries, 'fill-first').map((e) => e.account.id),
    ['b', 'a', 'c'],
  );
});

test('round-robin 在同优先级里让最久没派活的先上', () => {
  const entries = [
    entry('a', { runtime: emptyRuntime(NOW) }),
    entry('b', { runtime: emptyRuntime(NOW - 10_000) }),
    entry('c', { runtime: emptyRuntime(NOW - 5_000) }),
  ];
  assert.deepEqual(
    rank(entries, 'round-robin').map((e) => e.account.id),
    ['b', 'c', 'a'],
  );
  // 优先级仍然压过轮转：高优先级的那个哪怕刚用过也排前面
  const mixed = [
    entry('a', { runtime: emptyRuntime(NOW), row: { ...DEFAULT_ACCOUNT_SETTING, ...EMPTY_STAT, enabled: true, priority: 3 } }),
    entry('b', { runtime: emptyRuntime(NOW - 10_000) }),
  ];
  assert.equal(rank(mixed, 'round-robin')[0].account.id, 'a');
});

test('限流和上游抖动不记在账户头上，凭证问题才记', () => {
  assert.equal(blamesAccount(401), true);
  assert.equal(blamesAccount(403), true);
  assert.equal(blamesAccount(402), true);
  // 换个账户照样撞的，不该消耗这个账户的失败预算
  assert.equal(blamesAccount(429), false);
  assert.equal(blamesAccount(500), false);
  assert.equal(blamesAccount(529), false);
});

test('卡片视图带上冷却剩余时间，冷却过去之后就不再显示', () => {
  const cooling = entry('a', {
    runtime: { ...emptyRuntime(), cooldownUntil: NOW + 3_000, lastError: '401 unauthorized' },
  });
  const view = viewOf(cooling, CFG, NOW);
  assert.equal(view.state, 'cooling');
  assert.equal(view.cooldownUntil, NOW + 3_000);
  assert.equal(view.lastError, '401 unauthorized');
  assert.equal(viewOf(cooling, CFG, NOW + 4_000).cooldownUntil, null);
});

test('pick 只在同一家里挑，且不会把已经试过的账户再派一次', () => {
  const store = tempStore();
  const pool = new GatewayPool(store);
  for (const id of ['a', 'b']) store.setGatewayAccount(id, { enabled: true });
  store.setGatewayAccount('a', { priority: 5 });
  const accounts = [account('a'), account('b'), account('x', 'codex')];
  const states = new Map<string, AccountState>();

  assert.equal(pool.pick(accounts, states, CFG, 'claude', new Set())?.id, 'a', '优先级高的先上');
  assert.equal(
    pool.pick(accounts, states, CFG, 'claude', new Set(['a']))?.id,
    'b',
    '这一次已经试过 a，就该换下一个',
  );
  assert.equal(
    pool.pick(accounts, states, CFG, 'claude', new Set(['a', 'b'])),
    null,
    '都试过了就明说没有，别再绕回去',
  );
  assert.equal(pool.pick(accounts, states, CFG, 'codex', new Set()), null, 'codex 那个没开开关');
  store.close();
});

test('连续失败到阈值才进冷却，成功一次就把计数清零', () => {
  const store = tempStore();
  const pool = new GatewayPool(store);
  store.setGatewayAccount('a', { enabled: true });
  const cfg: GatewayConfig = { ...CFG, maxConsecutiveFailures: 2, cooldownSeconds: 30 };
  const accounts = [account('a')];
  const states = new Map<string, AccountState>();

  pool.begin('a', NOW);
  pool.fail('a', '401', true, cfg, NOW);
  assert.equal(pool.views(accounts, states, cfg, NOW).get('a')!.state, 'ready', '一次失败还不至于停它');

  pool.begin('a', NOW);
  pool.fail('a', '401', true, cfg, NOW);
  const cooling = pool.views(accounts, states, cfg, NOW).get('a')!;
  assert.equal(cooling.state, 'cooling');
  assert.equal(cooling.cooldownUntil, NOW + 30_000);

  pool.reset('a');
  assert.equal(pool.views(accounts, states, cfg, NOW).get('a')!.state, 'ready', '用户点了归队就该立刻能用');
  store.close();
});

test('不记在账户头上的失败不会把它推进冷却', () => {
  const store = tempStore();
  const pool = new GatewayPool(store);
  store.setGatewayAccount('a', { enabled: true });
  const cfg: GatewayConfig = { ...CFG, maxConsecutiveFailures: 1 };
  for (let i = 0; i < 5; i++) {
    pool.begin('a', NOW);
    pool.fail('a', '429 rate limited', false, cfg, NOW);
  }
  const view = pool.views([account('a')], new Map(), cfg, NOW).get('a')!;
  assert.equal(view.state, 'ready', '一次网络抖动不该让整池子集体进冷却');
  assert.equal(view.failures, 5, '但失败次数照记，界面上要看得到');
  assert.equal(view.lastError, '429 rate limited');
  store.close();
});

test('在飞计数有借有还，转发结束后账户不会永远显示在忙', () => {
  const store = tempStore();
  const pool = new GatewayPool(store);
  store.setGatewayAccount('a', { enabled: true });
  const accounts = [account('a')];

  pool.begin('a', NOW);
  pool.begin('a', NOW);
  assert.equal(pool.views(accounts, new Map(), CFG, NOW).get('a')!.inFlight, 2);
  pool.succeed('a', 100, 20);
  pool.fail('a', 'boom', false, CFG, NOW);
  const view = pool.views(accounts, new Map(), CFG, NOW).get('a')!;
  assert.equal(view.inFlight, 0);
  assert.equal(view.state, 'ready');
  store.close();
});

test('统计落进库里：成功只加 tokens，失败只加失败数', () => {
  const store = tempStore();
  const pool = new GatewayPool(store);
  pool.begin('a', NOW);
  pool.succeed('a', 120, 34);
  pool.begin('a', NOW);
  pool.fail('a', '401', true, CFG, NOW);

  const row = store.gatewayAccount('a')!;
  assert.equal(row.requests, 2, '失败的那次也算转发过');
  assert.equal(row.failures, 1);
  assert.equal(row.inputTokens, 120);
  assert.equal(row.outputTokens, 34);
  assert.equal(row.lastUsedAt, NOW);
  store.close();
});

test('设置和统计各走各的：改开关不会把统计清掉', () => {
  const store = tempStore();
  store.recordGatewayUse('a', true, 10, 5, NOW);
  store.setGatewayAccount('a', { enabled: true, priority: 7 });
  const row = store.gatewayAccount('a')!;
  assert.equal(row.enabled, true);
  assert.equal(row.priority, 7);
  assert.equal(row.requests, 1, '改设置不该动统计');
  assert.equal(row.inputTokens, 10);
  store.close();
});

test('单账户查询和整表查询给出同一份数据', () => {
  const store = tempStore();
  const pool = new GatewayPool(store);
  store.setGatewayAccount('a', { enabled: true, priority: 3 });
  const a = account('a');
  assert.deepEqual(
    pool.viewOf(a, 42, CFG, NOW),
    pool.views([a], new Map([['a', { usedPercent: 42 } as AccountState]]), CFG, NOW).get('a'),
  );
  store.close();
});
