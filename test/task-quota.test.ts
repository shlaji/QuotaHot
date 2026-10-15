import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UsageResult, Window } from '../src/shared/types.js';
import { hasTaskQuota } from '../src/server/task-quota.js';

export const quotaResult: UsageResult = {
  accountId: 'test', provider: 'claude', email: '', ok: true, status: 200, error: '',
  plan: '', subscriptionEndsAt: null, userId: '', resetCredits: null,
  resetCreditsExpiresAt: null, orgType: '', quotaAvailable: null, windows: [], endpoint: '', raw: '',
};
const now = 1000;
const window: Window = { name: '5h', resetAt: 10000, usedPercent: 10, windowMinutes: 300, source: 'usage' };

for (const [name, result, expected] of [
  ['failed query', { ...quotaResult, ok: false, quotaAvailable: true }, false],
  ['empty windows', quotaResult, false],
  ['unknown percentage', { ...quotaResult, windows: [{ ...window, usedPercent: null }] }, false],
  ['denied explicitly', { ...quotaResult, quotaAvailable: false, windows: [window] }, false],
  ['allowed explicitly', { ...quotaResult, quotaAvailable: true }, true],
  ['available percentage', { ...quotaResult, windows: [window] }, true],
  ['full window overrides allowed', { ...quotaResult, quotaAvailable: true, windows: [{ ...window, usedPercent: 100 }] }, false],
  ['expired snapshot window', { ...quotaResult, windows: [{ ...window, resetAt: 500 }] }, false],
  ['NaN percentage', { ...quotaResult, windows: [{ ...window, usedPercent: NaN }] }, false],
  ['Qoder credits', { ...quotaResult, provider: 'qoder', windows: [{ ...window, name: 'credits', resetAt: 0 }] }, true],
] satisfies [string, UsageResult, boolean][]) {
  test(`quota decision handles ${name}`, () => {
    assert.equal(hasTaskQuota(result, 'anthropic/claude-sonnet', now), expected);
  });
}

test('ignores unrelated model and overage windows but blocks the requested model', () => {
  const result = { ...quotaResult, windows: [window,
    { ...window, name: 'seven_day_opus', usedPercent: 100 },
    { ...window, name: 'seven_day_overage_included', usedPercent: 100 },
  ] };
  assert.equal(hasTaskQuota(result, 'anthropic/claude-sonnet', now), true);
  assert.equal(hasTaskQuota(result, 'anthropic/claude-opus', now), false);
});
