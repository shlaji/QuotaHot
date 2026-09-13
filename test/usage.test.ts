import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClaudeUsage,
  parseCodexUsage,
  parseProfile,
  parseResetCredits,
  summarize,
} from '../src/server/usage.js';
import { nextSendWindow } from '../src/server/ratelimit.js';

const NOW = 1_800_000_000_000;

test('解析 Claude /api/oauth/usage 的窗口', () => {
  const payload = {
    subscription_type: 'max',
    rate_limits: {
      five_hour: { utilization: 42.5, resets_at: '2027-01-15T09:00:00Z' },
      seven_day: { utilization: 8, resets_at: '2027-01-20T09:00:00Z' },
    },
  };
  const windows = parseClaudeUsage(payload, NOW);
  assert.equal(windows.length, 2);

  const five = windows.find((w) => w.name === '5h')!;
  assert.ok(five, 'five_hour 应改名成 5h');
  assert.equal(five.usedPercent, 42.5);
  assert.equal(five.windowMinutes, 300);
  assert.equal(five.resetAt, Date.parse('2027-01-15T09:00:00Z'));

  // 5 小时窗口还开着，下一发就该等它
  assert.equal(nextSendWindow(windows, NOW)!.name, '5h');
});

test('窗口摊平到响应根上（无 rate_limits 包装）也能解析', () => {
  // 2026-09 的真实响应体，标识符已抹去；spend 这类非窗口字段必须被滤掉
  const payload = {
    five_hour: {
      utilization: 27.0,
      resets_at: '2026-09-05T04:00:00.099165+00:00',
      limit_dollars: null,
      locked_reason: null,
    },
    seven_day: { utilization: 53.0, resets_at: '2026-09-06T14:00:00.099183+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: null,
    spend: { used: { amount_minor: 0, currency: 'USD' }, percent: 0, enabled: false },
    member_dashboard_available: false,
  };
  const windows = parseClaudeUsage(payload, NOW);
  assert.deepEqual(
    windows.map((w) => w.name).sort(),
    ['5h', 'seven_day'],
    'spend / member_dashboard_available 不该被当成窗口',
  );

  const five = windows.find((w) => w.name === '5h')!;
  assert.equal(five.usedPercent, 27);
  assert.equal(five.windowMinutes, 300);
  // 微秒精度的时间戳要截断到毫秒，不能变成 NaN
  assert.equal(five.resetAt, Date.parse('2026-09-05T04:00:00.099Z'));

  const week = windows.find((w) => w.name === 'seven_day')!;
  assert.equal(week.usedPercent, 53);
  // 这份响应是 2026-09 抓的，得按它自己的时点去问下一发等谁，否则两个窗口都已经过去了
  assert.equal(nextSendWindow(windows, Date.parse('2026-09-05T00:00:00Z'))!.name, '5h');
});

test('缺 resets_at 的窗口被跳过，而不是记成 1970 年', () => {
  const windows = parseClaudeUsage(
    { rate_limits: { five_hour: { utilization: 10 }, seven_day: { utilization: 1, resets_at: 1800003600 } } },
    NOW,
  );
  assert.deepEqual(windows.map((w) => w.name), ['seven_day']);
  assert.equal(windows[0].resetAt, 1800003600 * 1000, 'unix 秒应转成毫秒');
});

test('Codex 流式形状：rate_limits.primary', () => {
  const windows = parseCodexUsage(
    { rate_limits: { primary: { used_percent: 30, window_minutes: 300, resets_in_seconds: 600 } } },
    NOW,
  );
  assert.equal(windows.length, 1);
  assert.equal(windows[0].name, 'primary');
  assert.equal(windows[0].usedPercent, 30);
  assert.equal(windows[0].resetAt, NOW + 600_000);
});

test('Codex 快照形状：rate_limit.primary_window', () => {
  const windows = parseCodexUsage(
    {
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 900 },
        secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_after_seconds: 1000 },
      },
    },
    NOW,
  );
  assert.equal(windows.length, 2);
  const primary = windows.find((w) => w.name === 'primary')!;
  assert.equal(primary.windowMinutes, 300, 'limit_window_seconds 应换算成分钟');
  assert.equal(primary.resetAt, NOW + 900_000);
  assert.equal(nextSendWindow(windows, NOW)!.name, 'primary');
});

test('认不出的响应返回空数组而不是抛错', () => {
  for (const junk of [null, {}, { hello: 'world' }, [1, 2, 3], 'nope']) {
    assert.deepEqual(parseClaudeUsage(junk, NOW), []);
    assert.deepEqual(parseCodexUsage(junk, NOW), []);
  }
});

/**
 * The body chatgpt.com/backend-api/wham/usage actually returned, trimmed to the
 * fields the parser reads. Kept verbatim so a rename upstream fails here first.
 */
const WHAM_USAGE = {
  user_id: 'user-xxxxxxxxxxxxxxxxxxxxxxxx',
  account_id: '00000000-0000-0000-0000-000000000000',
  email: 'someone@example.com',
  plan_type: 'plus',
  rate_limit: {
    allowed: false,
    limit_reached: true,
    primary_window: {
      used_percent: 0,
      limit_window_seconds: 18000,
      reset_after_seconds: 18000,
      reset_at: 1788552704,
    },
    secondary_window: {
      used_percent: 100,
      limit_window_seconds: 604800,
      reset_after_seconds: 215346,
      reset_at: 1788750050,
    },
  },
  credits: { has_credits: false, unlimited: false, balance: '0' },
  rate_limit_reset_credits: { available_count: 1, applicable_available_count: 1 },
};

test('读取 codex 真实响应：套餐、两个窗口、重置次数', () => {
  const s = summarize('codex', WHAM_USAGE, NOW);
  assert.equal(s.plan, 'plus');
  assert.equal(s.userId, 'user-xxxxxxxxxxxxxxxxxxxxxxxx');
  assert.equal(s.resetCredits, 1);
  assert.equal(s.quotaAvailable, false);

  const five = s.windows.find((w) => w.name === 'primary')!;
  assert.equal(five.windowMinutes, 300);
  assert.equal(five.usedPercent, 0);
  const weekly = s.windows.find((w) => w.name === 'secondary')!;
  assert.equal(weekly.windowMinutes, 10080);
  assert.equal(weekly.usedPercent, 100);
  // reset_after_seconds is relative, reset_at absolute; either resolves to the same moment
  assert.equal(weekly.resetAt, NOW + 215_346_000);
});

test('Codex 额度响应优先使用服务端的 allowed / limit_reached 判定', () => {
  assert.equal(
    summarize('codex', { rate_limit: { allowed: true, limit_reached: false } }, NOW).quotaAvailable,
    true,
  );
  assert.equal(
    summarize('codex', { rate_limit: { allowed: true, limit_reached: true } }, NOW).quotaAvailable,
    false,
  );
  assert.equal(
    summarize('codex', { rate_limit: { allowed: false, limit_reached: false } }, NOW).quotaAvailable,
    false,
  );
  assert.equal(summarize('codex', { rate_limit: {} }, NOW).quotaAvailable, null);
  assert.equal(summarize('claude', { rate_limit: { allowed: false } }, NOW).quotaAvailable, null);
});

test('没有重置次数字段时返回 null，而不是 0', () => {
  const s = summarize('claude', { rate_limits: {} }, NOW);
  assert.equal(s.resetCredits, null);
  assert.equal(s.subscriptionEndsAt, null);
  assert.equal(s.plan, '');
});

test('订阅到期时间认 unix 秒也认 ISO 串', () => {
  assert.equal(
    summarize('codex', { subscription_active_until: 1_800_100_000 }, NOW).subscriptionEndsAt,
    1_800_100_000_000,
  );
  assert.equal(
    summarize('claude', { current_period_end: '2027-01-15T09:00:00Z' }, NOW).subscriptionEndsAt,
    Date.parse('2027-01-15T09:00:00Z'),
  );
});

test('profile 接口的 organization_type 决定套餐名', () => {
  const p = parseProfile({
    account: { email_address: 'someone@example.com', uuid: 'user-1' },
    organization: { organization_type: 'claude_max' },
  });
  assert.equal(p.orgType, 'claude_max');
  assert.equal(p.plan, 'Max');
  assert.equal(p.email, 'someone@example.com');
  assert.equal(p.userId, 'user-1');
});

test('未知的 organization_type 不猜套餐名', () => {
  const p = parseProfile({ organization: { organization_type: 'claude_future' } });
  assert.equal(p.orgType, 'claude_future');
  assert.equal(p.plan, '');
});

test('重置次数明细取最早的过期时间', () => {
  const r = parseResetCredits(
    {
      data: {
        credits: [
          { status: 'available', expires_at: '2027-01-20T09:00:00Z' },
          { status: 'available', expires_at: '2027-01-15T09:00:00Z' },
          { status: 'redeemed', expires_at: '2027-01-10T09:00:00Z' },
        ],
      },
    },
    NOW,
  );
  // 已用掉的那张虽然过期更早，但它不该影响“最近一张什么时候过期”
  assert.equal(r.availableCount, 2);
  assert.equal(r.nextExpiresAt, Date.parse('2027-01-15T09:00:00Z'));
});

test('明细缺 available_count 时按可用条目数兜底，全空则返回 null', () => {
  assert.equal(parseResetCredits({ credits: [] }, NOW).availableCount, null);
  assert.equal(parseResetCredits({ credits: [{ status: 'used' }] }, NOW).availableCount, 0);
  // 上游自己报的数字优先于本地计数
  assert.equal(
    parseResetCredits({ available_count: 5, credits: [{ status: 'available' }] }, NOW)
      .availableCount,
    5,
  );
});

test('明细没有过期时间时不编造一个', () => {
  assert.equal(parseResetCredits({ credits: [{ status: 'available' }] }, NOW).nextExpiresAt, null);
});
