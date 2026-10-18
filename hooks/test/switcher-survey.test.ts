import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { Account, UsageResult } from '../src/types.js';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

let assessmentStarted = deferred();
let resumeAssessment = deferred();

mock.module('../src/usage.js', {
  exports: {
    queryHookUsage: async (account: Account): Promise<UsageResult> => {
      if (account.email === 'a@x.com') {
        assessmentStarted.resolve();
        await resumeAssessment.promise;
      }
      return {
        accountId: account.id, provider: account.provider, email: account.email,
        ok: true, status: 200, error: '', plan: '', subscriptionEndsAt: null,
        userId: '', quotaAvailable: true, endpoint: 'test', windows: [
          { name: 'primary', usedPercent: 30, resetAt: 0, windowMinutes: 300, source: 'test' },
        ],
      };
    },
  },
});

const { reset, writeAccount, switchWithUsage, usageByEmail, usageWindow } = await import('./switcher-fixture.js');
const { surveyAccounts } = await import('../src/switcher.js');
const { readState, writeState, withSwitchLock } = await import('../src/state.js');

test('survey preserves a concurrent switch receipt, clients and conflicting memos', async () => {
  reset();
  writeAccount('c@x.com');
  const originalMemo = { usedPercent: 1, resetAt: 0, checkedAt: 1, blockedUntil: 0 };
  await writeState({
    accounts: { 'codex:a@x.com': originalMemo, 'codex:b@x.com': originalMemo, 'codex:c@x.com': originalMemo },
    clients: {},
  });
  usageByEmail.set('b@x.com', [usageWindow('primary', 5, 3_600_000)]);
  const survey = surveyAccounts('codex', { threshold: 80, cacheMs: 0, check: true });
  await assessmentStarted.promise;

  let switchedState;
  try {
    const switched = await switchWithUsage({
      clients: ['opencode'], triggerClient: 'opencode', exhausted: true,
      minIntervalMs: 0, cacheMs: 0,
    });
    assert.equal(switched.switched, true);
    switchedState = await readState();
    assert.equal(switchedState.lastQuotaCheck?.outcome, 'switched');
    assert.equal(switchedState.clients.opencode.email, 'b@x.com');
  } finally {
    resumeAssessment.resolve();
  }
  const result = await survey;
  const persisted = await readState();

  assert.deepEqual(persisted.lastQuotaCheck, switchedState.lastQuotaCheck);
  assert.deepEqual(persisted.clients, switchedState.clients);
  assert.deepEqual(persisted.accounts['codex:a@x.com'], switchedState.accounts['codex:a@x.com']);
  assert.deepEqual(persisted.accounts['codex:b@x.com'], switchedState.accounts['codex:b@x.com']);
  assert.equal(persisted.accounts['codex:c@x.com'].usedPercent, 30);
  assert.notDeepEqual(persisted.accounts['codex:c@x.com'], originalMemo);
  assert.equal(result.statuses.length, 3);
  assert.ok(result.statuses.every((status) => status.source === 'live' && status.usedPercent === 30));
  assert.equal(result.active.opencode, 'b@x.com');
});

test('survey returns results without persisting when the switch lock is held', async () => {
  reset();
  assessmentStarted = deferred();
  resumeAssessment = deferred();
  const original = { accounts: {}, clients: {} };
  await writeState(original);
  const survey = surveyAccounts('codex', { threshold: 80, cacheMs: 0, check: true });
  await assessmentStarted.promise;

  await withSwitchLock(async () => {
    resumeAssessment.resolve();
    const result = await survey;
    assert.equal(result.statuses.length, 2);
    assert.ok(result.statuses.every((status) => status.source === 'live'));
    assert.equal(result.active.opencode, 'a@x.com');
    assert.deepEqual(await readState(), original);
  });
});
