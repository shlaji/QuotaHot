import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { Account, UsageResult, Window } from '../src/types.js';

const current: Account = {
  id: 'codex:current@example.test', provider: 'codex', email: 'current@example.test', path: '/tmp/current.json',
  accountId: 'current', accessToken: 'current-token', refreshToken: '', idToken: '', expiresAt: Date.now() + 3_600_000,
  disabled: false, plan: '', subscriptionEndsAt: 0, userId: '', source: '', autoRefresh: true, syncPath: '', syncSource: '',
};
const candidate: Account = {
  ...current,
  id: 'codex:candidate@example.test', email: 'candidate@example.test', path: '/tmp/candidate.json',
  accountId: 'candidate', accessToken: 'candidate-token',
};
let candidateFreshChecks = 0;

mock.module('../src/config.js', {
  exports: { ACCOUNTS_DIR: '/tmp/accounts', loadConfig: () => ({ proxy: '', noProxy: [] }) },
});
mock.module('../src/account-files.js', {
  exports: {
    accountIdOf: () => '',
    emailOf: () => '',
    loadAccounts: async () => [current, candidate],
  },
});
mock.module('../src/client-auth.js', {
  exports: {
    clientPath: () => '/tmp/auth.json',
    readClientTokens: async () => ({ accessToken: current.accessToken, accountId: current.accountId }),
    syncToClients: async () => [],
  },
});
mock.module('../src/credentials.js', {
  exports: {
    ensureFresh: async (account: Account) => {
      if (account.id === current.id) return true;
      candidateFreshChecks += 1;
      return candidateFreshChecks === 1;
    },
  },
});
mock.module('../src/state.js', {
  exports: {
    STATE_PATH: '/tmp/switch-state.json',
    readState: async () => ({ accounts: {}, clients: {} }),
    writeState: async () => {},
    withSwitchLock: async (work: () => Promise<unknown>) => work(),
  },
});
mock.module('../src/usage.js', { exports: { queryHookUsage: async () => { throw new Error('unused'); } } });

const { exhaustionOf, switchAccount } = await import('../src/switcher.js');

test('candidate renewal failure remains a check failure instead of a quota miss', async () => {
  // Given: the candidate passes quota assessment but renewal fails immediately before client write.
  candidateFreshChecks = 0;
  const usageQuery = async (): Promise<UsageResult> => ({
    accountId: candidate.id, provider: 'codex', email: candidate.email,
    ok: true, status: 200, error: '', plan: '', subscriptionEndsAt: null,
    userId: '', quotaAvailable: true, windows: [], endpoint: 'test',
  });

  // When: switching evaluates and then prepares that candidate for persistence.
  const result = await switchAccount({ exhausted: true, minIntervalMs: 0, usageQuery });

  // Then: diagnostics retain the credential failure rather than reporting no eligible quota.
  assert.equal(result.switched, false);
  assert.equal(result.checked.at(-1)?.source, 'error');
  assert.equal(result.checked.at(-1)?.error, '令牌续期失败');
});

test('display percentage prefers an unnamed-duration primary window', async () => {
  // Given: the primary window lacks duration metadata and a secondary window has greater usage.
  candidateFreshChecks = 0;
  const usageQuery = async (): Promise<UsageResult> => ({
    accountId: current.id, provider: 'codex', email: current.email,
    ok: true, status: 200, error: '', plan: '', subscriptionEndsAt: null,
    userId: '', quotaAvailable: true, endpoint: 'test', windows: [
      { name: 'primary', resetAt: Date.now() + 3_600_000, usedPercent: 12, windowMinutes: null, source: 'test' },
      { name: 'secondary', resetAt: Date.now() + 7_200_000, usedPercent: 80, windowMinutes: null, source: 'test' },
    ],
  });

  // When: the isolated switcher assesses the current account.
  const result = await switchAccount({ exhausted: false, minIntervalMs: 0, usageQuery });

  // Then: status displays the primary window just as the original switcher does.
  assert.equal(result.checked[0]?.usedPercent, 12);
});

test('past reset and unknown usage windows are not exhausted', () => {
  // Given: one stale full window and one future window without a usage value.
  const now = Date.now();
  const windows: readonly Window[] = [
    { name: 'primary', resetAt: now - 1_000, usedPercent: 100, windowMinutes: 300, source: 'test' },
    { name: 'primary', resetAt: now + 1_000, usedPercent: null, windowMinutes: 300, source: 'test' },
  ];
  // When: exhaustion is evaluated at the current time.
  const result = exhaustionOf(windows, 95, now);
  // Then: neither non-actionable window blocks the account.
  assert.equal(result.exhausted, false);
});
