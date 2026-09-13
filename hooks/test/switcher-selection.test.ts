import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  availabilityByEmail,
  codexAuthPath,
  nested,
  observations,
  opencodeAuthPath,
  reset,
  statePath,
  switchWithUsage,
  usageByEmail,
  usageWindow,
} from './switcher-fixture.js';

test('exhausted current account switches both clients to an available account', async () => {
  // Given: the current account is exhausted and the candidate is available.
  reset();
  usageByEmail.set('a@x.com', [usageWindow('primary', 99, 3_600_000)]);
  usageByEmail.set('b@x.com', [usageWindow('primary', 12, 3_600_000)]);
  // When: switching evaluates both accounts.
  const result = await switchWithUsage({ minIntervalMs: 0, reason: 'test' });
  // Then: both clients change while unrelated fields and cooldown state are preserved.
  assert.equal(result.switched, true);
  assert.equal(result.from, 'a@x.com');
  assert.equal(result.to, 'b@x.com');
  assert.equal(nested(codexAuthPath, 'tokens', 'access_token'), 'token-b@x.com');
  assert.equal(nested(opencodeAuthPath, 'openai', 'access'), 'token-b@x.com');
  assert.equal(nested(codexAuthPath, 'other'), 'keep');
  assert.equal(nested(opencodeAuthPath, 'opencode-go', 'key'), 'k');
  assert.ok(Number(nested(statePath, 'accounts', 'codex:a@x.com', 'blockedUntil')) > Date.now());
});

test('available current account remains selected without querying candidates', async () => {
  // Given: the current account still has quota.
  reset();
  usageByEmail.set('a@x.com', [usageWindow('primary', 40, 3_600_000)]);
  usageByEmail.set('b@x.com', [usageWindow('primary', 1, 3_600_000)]);
  // When: switching checks the current account.
  const result = await switchWithUsage({ minIntervalMs: 0 });
  // Then: no client changes and the candidate is not queried.
  assert.equal(result.switched, false);
  assert.match(result.message, /仍有额度/);
  assert.equal(nested(codexAuthPath, 'tokens', 'access_token'), 'token-a@x.com');
  assert.deepEqual(observations.queried, ['a@x.com']);
});

test('exhausted weekly window forces selection away from current account', async () => {
  // Given: only the current account's weekly window is exhausted.
  reset();
  usageByEmail.set('a@x.com', [usageWindow('primary', 3, 3_600_000), usageWindow('secondary', 100, 86_400_000)]);
  usageByEmail.set('b@x.com', [usageWindow('primary', 50, 3_600_000)]);
  // When: switching evaluates all active windows.
  const result = await switchWithUsage({ minIntervalMs: 0 });
  // Then: the available candidate is selected.
  assert.equal(result.switched, true);
  assert.equal(result.to, 'b@x.com');
});

test('all exhausted accounts report earliest recovery without writing clients', async () => {
  // Given: every account is exhausted with a future reset.
  reset();
  usageByEmail.set('a@x.com', [usageWindow('primary', 100, 3_600_000)]);
  usageByEmail.set('b@x.com', [usageWindow('primary', 100, 7_200_000)]);
  // When: switching searches for a candidate.
  const result = await switchWithUsage({ minIntervalMs: 0 });
  // Then: it reports the earliest recovery and leaves credentials unchanged.
  assert.equal(result.switched, false);
  assert.ok(result.waitUntil > Date.now());
  assert.match(result.message, /都已用尽/);
  assert.equal(nested(codexAuthPath, 'tokens', 'access_token'), 'token-a@x.com');
});

test('exhausted signal skips querying the current account', async () => {
  // Given: the caller already established current-account exhaustion.
  reset();
  usageByEmail.set('b@x.com', [usageWindow('primary', 5, 3_600_000)]);
  // When: switching receives the exhausted signal.
  const result = await switchWithUsage({ minIntervalMs: 0, exhausted: true });
  // Then: it selects the candidate without rechecking current usage.
  assert.equal(result.switched, true);
  assert.equal(result.to, 'b@x.com');
  assert.equal(observations.queried.includes('a@x.com'), false);
});

test('explicit upstream availability overrides a displayed 100 percent usage', async () => {
  // Given: the upstream explicitly says the candidate remains available.
  reset();
  usageByEmail.set('b@x.com', [usageWindow('primary', 100, 3_600_000)]);
  availabilityByEmail.set('b@x.com', true);
  // When: the exhausted current account needs a candidate.
  const result = await switchWithUsage({ minIntervalMs: 0, exhausted: true, cacheMs: 0, threshold: 100 });
  // Then: explicit availability wins.
  assert.equal(result.switched, true);
  assert.equal(result.to, 'b@x.com');
});

test('explicit upstream exhaustion overrides low displayed usage', async () => {
  // Given: the upstream explicitly rejects the low-usage candidate.
  reset();
  usageByEmail.set('b@x.com', [usageWindow('primary', 5, 3_600_000)]);
  availabilityByEmail.set('b@x.com', false);
  // When: switching searches for a candidate.
  const result = await switchWithUsage({ minIntervalMs: 0, exhausted: true, cacheMs: 0, threshold: 100 });
  // Then: no client changes and a future retry is reported.
  assert.equal(result.switched, false);
  assert.ok(result.waitUntil > Date.now());
  assert.equal(nested(codexAuthPath, 'tokens', 'access_token'), 'token-a@x.com');
  assert.equal(nested(opencodeAuthPath, 'openai', 'access'), 'token-a@x.com');
});

test('zero cache bypasses a stale candidate cooldown after a quota event', async () => {
  // Given: persisted cooldown says exhausted but live upstream says available.
  reset();
  const staleReset = Date.now() + 3_600_000;
  await import('node:fs/promises').then(({ writeFile }) => writeFile(statePath, JSON.stringify({
    accounts: { 'codex:b@x.com': { usedPercent: 100, resetAt: staleReset, checkedAt: Date.now(), blockedUntil: staleReset } },
    clients: {},
  })));
  usageByEmail.set('b@x.com', [usageWindow('primary', 10, 3_600_000)]);
  availabilityByEmail.set('b@x.com', true);
  // When: a zero-cache exhausted switch runs.
  const result = await switchWithUsage({ minIntervalMs: 0, exhausted: true, cacheMs: 0, threshold: 100 });
  // Then: live status is queried and the candidate is selected.
  assert.equal(result.switched, true);
  assert.equal(result.to, 'b@x.com');
  assert.deepEqual(observations.queried, ['b@x.com']);
});
