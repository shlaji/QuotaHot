import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rl from '../src/server/ratelimit.js';

const now = Date.now();

test('解析 Anthropic 统一限额头（真实字段名）', () => {
  const ws = rl.parseHeaders(
    {
      'Anthropic-Ratelimit-Unified-5h-Reset': String(Math.floor(now / 1000) + 12345),
      'Anthropic-Ratelimit-Unified-5h-Status': 'allowed',
      'Anthropic-Ratelimit-Unified-7d-Reset': String(Math.floor(now / 1000) + 500000),
    },
    now,
  );
  const five = ws.find((w) => w.name === '5h')!;
  assert.ok(five, '应解析出 5h 窗口');
  assert.equal(rl.isFiveHour(five), true);
  assert.ok(Math.abs((five.resetAt - now) / 1000 - 12345) < 2);
  assert.equal(rl.isFiveHour(ws.find((w) => w.name === '7d')!), false);
  assert.equal(rl.nextSendWindow(ws, now)!.name, '5h', '5h 窗口还开着，下一发就等它');
});

test('解析 Codex 头：相对秒数 + 百分比 + 窗口长度', () => {
  const ws = rl.parseHeaders(
    {
      'x-codex-primary-used-percent': '12.5',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '9000',
      'x-codex-secondary-used-percent': '3',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-after-seconds': '400000',
    },
    now,
  );
  assert.equal(ws.length, 2);
  const primary = rl.nextSendWindow(ws, now)!;
  assert.equal(primary.name, 'primary');
  assert.equal(primary.usedPercent, 12.5);
  assert.equal(primary.windowMinutes, 300);
  assert.ok(Math.abs((primary.resetAt - now) / 1000 - 9000) < 2);
});

test('解析 Codex SSE body 里的 rate_limits', () => {
  const event = {
    type: 'response.completed',
    response: {
      rate_limits: {
        primary: { used_percent: 40, window_minutes: 300, resets_in_seconds: 7200 },
        secondary: { used_percent: 5, window_minutes: 10080, resets_in_seconds: 300000 },
      },
    },
  };
  const ws = rl.parseBody(event, now);
  assert.equal(ws.length, 2);
  const p = ws.find((w) => w.name === 'primary')!;
  assert.equal(p.usedPercent, 40);
  assert.equal(p.source, 'body:rate_limits');
});

test('绝对时间戳、相对秒数、RFC3339 三种写法都能解析', () => {
  const abs = Math.floor(now / 1000) + 3600;
  assert.ok(Math.abs(rl.toEpochMs(String(abs), now)! - (now + 3600_000)) < 1500);
  assert.ok(Math.abs(rl.toEpochMs('600', now)! - (now + 600_000)) < 2);
  assert.equal(rl.toEpochMs('2026-09-05T09:00:00Z', now), Date.parse('2026-09-05T09:00:00Z'));
  assert.equal(rl.toEpochMs('', now), null);
  assert.equal(rl.toEpochMs('garbage', now), null);
});

test('合并时响应头优先于 body', () => {
  const headerWins = rl.parseHeaders({ 'x-codex-primary-reset-after-seconds': '9000' }, now);
  const bodyWindows = rl.parseBody({ rate_limits: { primary: { resets_in_seconds: 1 } } }, now);
  const merged = rl.merge(headerWins, bodyWindows);
  assert.equal(merged.length, 1);
  assert.ok(merged[0].source.startsWith('header:'), '同名窗口应保留响应头的值');
});

test('429 的 retry-after 作为兜底', () => {
  const h = new Headers({ 'retry-after': '1800' });
  assert.ok(Math.abs(rl.parseRetryAfter(h, now)! - (now + 1800_000)) < 2);
  assert.equal(rl.parseRetryAfter(new Headers(), now), null);
});

test('限额解析接受 undici 的 Headers（不能依赖 instanceof 全局 Headers）', async () => {
  const { Headers: UndiciHeaders } = await import('undici');
  const reset = Math.floor(now / 1000) + 3600;

  // undici 的 Headers 与全局 Headers 是两个类，instanceof 判断会漏掉它
  const undici = new UndiciHeaders({ 'anthropic-ratelimit-unified-5h-reset': String(reset) });
  assert.equal(undici instanceof Headers, false, '前提：它确实不是全局 Headers');

  for (const [label, h] of [
    ['undici Headers', undici],
    ['全局 Headers', new Headers({ 'anthropic-ratelimit-unified-5h-reset': String(reset) })],
    ['普通对象', { 'Anthropic-RateLimit-Unified-5h-Reset': String(reset) }],
  ] as const) {
    const ws = rl.parseHeaders(h, now);
    assert.equal(ws.length, 1, `${label} 应解析出窗口`);
    assert.ok(Math.abs((ws[0].resetAt - now) / 1000 - 3600) < 2, `${label} 重置时间应正确`);
  }

  assert.ok(rl.parseRetryAfter(new UndiciHeaders({ 'retry-after': '120' }), now), 'undici Headers 的 retry-after');
  assert.ok(rl.parseRetryAfter({ 'Retry-After': '120' }, now), '普通对象的 retry-after');
});

test('nextReset 只看还没到点的窗口，全过去了就交白卷', () => {
  const w = (name: string, offset: number) => ({
    name,
    resetAt: now + offset,
    usedPercent: 100,
    windowMinutes: null,
    source: 'h',
  });
  // 「还有窗口没到点」正是判断“这是额度限制而不是接口故障”的依据
  assert.equal(rl.nextReset([w('7d', 90_000), w('5h', 30_000)], now)!.name, '5h');
  assert.equal(rl.nextReset([w('5h', -1), w('7d', 60_000)], now)!.name, '7d');
  assert.equal(rl.nextReset([w('5h', -1_000)], now), null);
  assert.equal(rl.nextReset([], now), null);
});

/**
 * 真实事故的回归：周额度用满，5 小时窗口一小时后就重置，调度器跟着更早的那个排，
 * 于是一小时后发出去又被顶回来——周额度没到点之前，发几次都是一样的结果。
 */
test('周额度用满时等它重置，而不是更早重置的 5 小时窗口', () => {
  const windows = [
    { name: 'five_hour', resetAt: now + 3600_000, usedPercent: 12, windowMinutes: 300, source: 'usage' },
    { name: 'seven_day', resetAt: now + 111_600_000, usedPercent: 100, windowMinutes: 10080, source: 'usage' },
  ];
  assert.equal(rl.blockingWindow(windows, now)!.name, 'seven_day');
  assert.equal(rl.nextSendWindow(windows, now)!.name, 'seven_day', '用满的那个才是门槛');
});

test('两个窗口都用满时等最晚的那个：先重置的那个不解开限制', () => {
  const windows = [
    { name: 'five_hour', resetAt: now + 1000, usedPercent: 100, windowMinutes: 300, source: 'usage' },
    { name: 'seven_day', resetAt: now + 90_000, usedPercent: 99, windowMinutes: 10080, source: 'usage' },
  ];
  assert.equal(rl.nextSendWindow(windows, now)!.name, 'seven_day');
});

test('周额度还有时跟 5 小时窗口，哪怕周窗口重置得更早', () => {
  const windows = [
    { name: 'seven_day', resetAt: now + 1000, usedPercent: 40, windowMinutes: 10080, source: 'usage' },
    { name: 'five_hour', resetAt: now + 60_000, usedPercent: 40, windowMinutes: 300, source: 'usage' },
  ];
  // 5 小时窗口还开着，这期间再发一条也开不出新窗口
  assert.equal(rl.nextSendWindow(windows, now)!.name, 'five_hour');
});

test('nextSendWindow 只认还没到点的窗口，一个都没有就交白卷', () => {
  const stale = [
    { name: 'five_hour', resetAt: now - 1000, usedPercent: 100, windowMinutes: 300, source: 'usage' },
  ];
  assert.equal(rl.nextSendWindow(stale, now), null, '已经重置的窗口不该再拿来排下一拍');
  assert.equal(rl.blockingWindow(stale, now), null, '已经重置的窗口挡不住任何人');
  assert.equal(rl.nextSendWindow([], now), null);
  assert.equal(
    rl.nextSendWindow(
      [{ name: '5h', resetAt: Number.NaN, usedPercent: 100, windowMinutes: 300, source: 'h' }],
      now,
    ),
    null,
    'NaN 不是时刻',
  );
});

/**
 * seven_day_opus / seven_day_sonnet 是模型专属的子窗口，保活只发配置里那一个模型，
 * 拿别的模型的额度去挡它，账户会白等到那个周窗口重置——好几天。
 */
test('模型专属的周窗口用满也不算门槛', () => {
  const windows = [
    { name: '5h', resetAt: now + 3600_000, usedPercent: 35, windowMinutes: 300, source: 'usage' },
    { name: 'seven_day', resetAt: now + 111_600_000, usedPercent: 62, windowMinutes: 10080, source: 'usage' },
    { name: 'seven_day_opus', resetAt: now + 345_600_000, usedPercent: 100, windowMinutes: 10080, source: 'usage' },
  ];
  assert.equal(rl.blockingWindow(windows, now), null, 'Opus 额度满挡不住 Sonnet 那一发');
  assert.equal(rl.nextSendWindow(windows, now)!.name, '5h', '照常跟 5 小时窗口');
});

/** 响应头那边是 7d_opus 这样的后缀，同一条规则要认得出来。 */
test('响应头形式的模型专属窗口同样不算门槛', () => {
  const windows = [
    { name: '5h', resetAt: now + 3600_000, usedPercent: 35, windowMinutes: 300, source: 'header:5h' },
    { name: '7d_opus', resetAt: now + 345_600_000, usedPercent: 100, windowMinutes: 10080, source: 'header:7d_opus' },
  ];
  assert.equal(rl.nextSendWindow(windows, now)!.name, '5h');
});

/** overage 那条挂的是 limit_dollars / used_dollars，是钱的口径，不是能不能发。 */
test('超额计费窗口用满不算门槛', () => {
  const windows = [
    { name: '5h', resetAt: now + 3600_000, usedPercent: 35, windowMinutes: 300, source: 'usage' },
    { name: 'seven_day_overage_included', resetAt: now + 345_600_000, usedPercent: 100, windowMinutes: 10080, source: 'usage' },
    { name: '7d_oi', resetAt: now + 345_600_000, usedPercent: 100, windowMinutes: 10080, source: 'header:7d_oi' },
  ];
  assert.equal(rl.blockingWindow(windows, now), null);
  assert.equal(rl.nextSendWindow(windows, now)!.name, '5h');
});

/**
 * 筛到一个不剩时不能交白卷：调用方会把 null 当成「读不出窗口」，那是直接停掉账户，
 * 保活断到有人手动重启为止。多等一会儿是小得多的代价。
 */
test('只剩模型专属窗口时退回它，而不是交白卷', () => {
  const windows = [
    { name: 'seven_day_opus', resetAt: now + 345_600_000, usedPercent: 100, windowMinutes: 10080, source: 'usage' },
  ];
  assert.equal(rl.nextSendWindow(windows, now)!.name, 'seven_day_opus');
});

test('读不出 5 小时窗口时退回最早重置的那个', () => {
  const windows = [
    { name: 'seven_day_opus', resetAt: now + 90_000, usedPercent: 10, windowMinutes: 10080, source: 'usage' },
    { name: 'seven_day', resetAt: now + 30_000, usedPercent: 10, windowMinutes: 10080, source: 'usage' },
  ];
  assert.equal(rl.nextSendWindow(windows, now)!.name, 'seven_day');
});

/**
 * 真实事故的回归：codex 在用量为 0 时，reset_after_seconds 恒等于 window_minutes——
 * 报的是「从你问的这一刻起再过 5 小时」，每查一次就往后挪一次。调度器把它当成门槛照它
 * 改期，下一拍被推得和时间流逝一样快，账户整个上午一条都没发出去。
 */
test('用量为 0、剩余等于整窗时，窗口还没开始计时', () => {
  const primary = {
    name: 'primary',
    resetAt: now + 300 * 60_000,
    usedPercent: 0,
    windowMinutes: 300,
    source: 'usage:primary_window',
  };
  assert.equal(rl.hasStarted(primary, now), false, '这不是门槛，是「额度是满的，该发了」');
});

/** 判据要拿观测时刻去比，不能拿此刻：否则同一份数据放久了就会被算成「已经开了」。 */
test('放旧了的那份窗口不会因为变旧就被当成在计时', () => {
  const observedAt = now - 25 * 60_000;
  const primary = {
    name: 'primary',
    resetAt: observedAt + 300 * 60_000,
    usedPercent: 0,
    windowMinutes: 300,
    source: 'usage:primary_window',
  };
  assert.equal(rl.hasStarted(primary, observedAt), false, '读回来时没开始，放半小时也还是没开始');
  assert.equal(rl.hasStarted(primary, now), true, '拿此刻去比就会判错——这正是要传观测时刻的原因');
});

test('有消耗，或剩余明显短于整窗，都算已经开始计时', () => {
  const used = { name: '5h', resetAt: now + 300 * 60_000, usedPercent: 1, windowMinutes: 300, source: 'usage:5h' };
  assert.equal(rl.hasStarted(used, now), true, '窗口里有消耗，它就是开着的');

  const partway = { name: '5h', resetAt: now + 90 * 60_000, usedPercent: 0, windowMinutes: 300, source: 'usage:5h' };
  assert.equal(rl.hasStarted(partway, now), true, '只剩 90 分钟，说明它是 3.5 小时前开的');
});

/** 读不出窗口长度时无从比对，宁可多等，也好过把一道真实的门槛当成不存在。 */
test('窗口长度缺失时按在计时处理', () => {
  const w = { name: 'unified', resetAt: now + 3600_000, usedPercent: 0, windowMinutes: null, source: 'header:unified' };
  assert.equal(rl.hasStarted(w, now), true);
});
