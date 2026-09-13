import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQoderLoginUrl,
  parseQoderQuota,
  profileOf,
  qoderStateDbPath,
  qoderStatusError,
} from '../src/server/qoder.js';
import { qoderHeaders, qoderMachineOS } from '../src/server/headers.js';

/** 官方响应的形状，各测试按需改字段。 */
function usage(over: Record<string, unknown> = {}) {
  return {
    userQuota: { used: 125, total: 500, remaining: 375, unit: 'credits' },
    totalUsagePercentage: 25,
    expiresAt: 1_767_225_600,
    ...over,
  };
}

test('Qoder 额度：credits 档带绝对数量和订阅周期的重置时刻', () => {
  const quota = parseQoderQuota(usage());
  assert.equal(quota.windows.length, 1);
  const w = quota.windows[0];
  assert.equal(w.name, 'credits');
  assert.equal(w.used, 125);
  assert.equal(w.total, 500);
  assert.equal(w.unit, 'credits');
  assert.equal(w.usedPercent, 25);
  // 没有滚动窗口，长度必须留空，否则界面会按 5 小时窗口那套去排序和展示
  assert.equal(w.windowMinutes, null);
  // 秒级时间戳要换算成毫秒
  assert.equal(w.resetAt, 1_767_225_600_000);
  assert.equal(quota.expiresAt, 1_767_225_600_000);
});

test('Qoder 额度：没给百分比时用 used/total 自己算', () => {
  const quota = parseQoderQuota({ userQuota: { used: 25, total: 200 } });
  assert.equal(quota.windows[0].usedPercent, 12.5);
});

test('Qoder 额度：0–1 的比例统一换算成百分数', () => {
  const quota = parseQoderQuota({ userQuota: { percentage: 0.42, total: 100 } });
  assert.equal(quota.windows[0].usedPercent, 42);
});

test('Qoder 额度：9999 年的哨兵值当作没有到期时间', () => {
  const quota = parseQoderQuota(usage({ expiresAt: Date.UTC(9999, 11, 31) / 1000 }));
  assert.equal(quota.expiresAt, null);
  // 界面据此显示“无重置窗口”，而不是一个几千年的倒计时
  assert.equal(quota.windows[0].resetAt, 0);
});

test('Qoder 额度：加油包单列一档，且不随订阅周期重置', () => {
  const quota = parseQoderQuota(usage({ addOnQuota: { used: 10, total: 100, unit: 'credits' } }));
  assert.deepEqual(
    quota.windows.map((w) => w.name),
    ['credits', 'credits_addon'],
  );
  const addon = quota.windows[1];
  assert.equal(addon.resetAt, 0);
  assert.equal(addon.total, 100);
  assert.equal(addon.usedPercent, 10);
});

test('Qoder 额度：没买加油包时不显示这一档', () => {
  const quota = parseQoderQuota(usage({ addOnQuota: { used: 0, total: 0 } }));
  assert.deepEqual(quota.windows.map((w) => w.name), ['credits']);
});

test('Qoder 额度：内容包在 data 下面也认', () => {
  const quota = parseQoderQuota({ data: usage() });
  assert.equal(quota.windows[0].total, 500);
});

test('Qoder 额度：完全没有额度信息时不造窗口', () => {
  assert.deepEqual(parseQoderQuota({}).windows, []);
  assert.deepEqual(parseQoderQuota(null).windows, []);
});

test('Qoder 额度：套餐名按上游的几种叫法依次找', () => {
  assert.equal(parseQoderQuota({ plan_tier_name: 'Pro' }).plan, 'Pro');
  assert.equal(parseQoderQuota({ tierName: 'Ultra' }).plan, 'Ultra');
  assert.equal(parseQoderQuota({ userTag: 'Free' }).plan, 'Free');
});

test('Qoder 快照：身份信息可以横跨三份缓存拼出来', () => {
  const profile = profileOf({
    userInfo: { token: 'qd-token', name: '张三', userId: 'u-1' },
    userPlan: { plan_tier_name: 'Pro' },
    creditUsage: usage({ email: 'A@Example.COM' }),
  });
  assert.equal(profile.accessToken, 'qd-token');
  assert.equal(profile.displayName, '张三');
  assert.equal(profile.userId, 'u-1');
  assert.equal(profile.plan, 'Pro');
  // 邮箱统一小写，避免同一个账户因大小写导入成两份
  assert.equal(profile.email, 'a@example.com');
  assert.equal(profile.quota.windows[0].total, 500);
});

test('Qoder 快照：读不到令牌时导入方要能识别出来', () => {
  const profile = profileOf({ userInfo: null, userPlan: null, creditUsage: null });
  assert.equal(profile.accessToken, '');
  assert.equal(profile.expiresAt, 0);
});

test('Qoder 请求头：没有机器信息时也能发出可用的一组', () => {
  const h = qoderHeaders('tok');
  assert.equal(h.authorization, 'Bearer tok');
  assert.equal(h['Cosy-ClientType'], '0');
  assert.equal(h['Cosy-MachineOS'], qoderMachineOS());
  // 缺失的机器字段一律不发，而不是发空串——上游会把空值当成非法设备
  assert.equal('Cosy-MachineToken' in h, false);
});

test('Qoder 请求头：有机器信息时逐项带上', () => {
  const h = qoderHeaders('tok', {
    token: 'mt',
    machineType: 'desktop',
    machineCode: 'code',
    machineId: 'mid',
    machineHostname: 'host',
    machineOS: 'aarch64_darwin',
    cosyVersion: '1.2.3',
  });
  assert.equal(h['Cosy-MachineToken'], 'mt');
  assert.equal(h['Cosy-MachineOS'], 'aarch64_darwin');
  assert.equal(h['Cosy-Version'], '1.2.3');
  assert.equal(h['Cosy-MachineHostname'], 'host');
});

test('Qoder 路径：凭证库在 VS Code 式的 globalStorage 下', () => {
  assert.equal(
    qoderStateDbPath('/tmp/Qoder'),
    '/tmp/Qoder/User/globalStorage/state.vscdb',
  );
});

test('Qoder 登录链接：带上机器标识时多一个参数，缺失时照发', () => {
  const withId = new URL(buildQoderLoginUrl('n1', 'c1', 'machine-1'));
  assert.equal(withId.searchParams.get('machine_id'), 'machine-1');
  assert.equal(withId.searchParams.get('nonce'), 'n1');
  assert.equal(withId.searchParams.get('challenge'), 'c1');

  // 本机没装过 Qoder 时读不到设备标识，这条链路仍然可用
  const without = new URL(buildQoderLoginUrl('n1', 'c1'));
  assert.equal(without.searchParams.has('machine_id'), false);
});

test('Qoder 用户状态：企业侧的几种拒绝都要在登录时就挡住', () => {
  assert.match(qoderStatusError({ id: 'u-1', whitelistStatus: 'NoIpPermission' }), /IP/);
  assert.match(qoderStatusError({ id: 'u-1', whitelistStatus: 'AppDisable' }), /停用/);
  assert.match(qoderStatusError({ id: 'u-1', whitelistStatus: 'NOT_ALLOW' }), /权限/);
  // 没有 id 说明这份状态根本不对应一个已登录用户
  assert.match(qoderStatusError({ whitelistStatus: 'PASS' }), /没有 id/);
  assert.match(qoderStatusError(null), /不是对象/);
});

test('Qoder 用户状态：正常和仅待审核的都放行', () => {
  assert.equal(qoderStatusError({ id: 'u-1', whitelistStatus: 'PASS' }), '');
  assert.equal(qoderStatusError({ id: 'u-1', whitelistStatus: 'WAIT' }), '');
  // 上游加了新状态时不该把人挡在外面，能不能用交给接口自己说
  assert.equal(qoderStatusError({ id: 'u-1', whitelistStatus: 'BrandNewStatus' }), '');
  assert.equal(qoderStatusError({ id: 'u-1' }), '');
});
