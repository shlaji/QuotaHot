import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  accountsDir,
  codexAuthPath,
  dataDir,
  hasState,
  nested,
  observations,
  readJson,
  reset,
  setClients,
  statePath,
  switchWithUsage,
  usageByEmail,
  usageWindow,
  writeAccount,
} from './switcher-fixture.js';

test('dry run creates neither state nor exhausted cooldown lock', async () => {
  // Given: two accounts and no hook state directory.
  rmSync(dataDir, { recursive: true, force: true });
  writeAccount('a@example.com');
  writeAccount('b@example.com');
  setClients('a@example.com');
  // When: an exhausted dry run skips quota checks.
  await switchWithUsage({ dryRun: true, check: false, exhausted: true });
  // Then: neither state nor lock is persisted.
  assert.equal(hasState(), false);
  assert.equal(existsSync(join(dataDir, 'switch.lock')), false);
});

test('dry run neither refreshes expired candidate nor writes cache', async () => {
  // Given: the candidate token is expired.
  rmSync(dataDir, { recursive: true, force: true });
  writeAccount('a@example.com');
  writeAccount('b@example.com');
  setClients('a@example.com');
  const path = join(accountsDir, 'codex-b@example.com.json');
  const body = readJson(path);
  body.expired = '2020-01-01T00:00:00Z';
  writeFileSync(path, JSON.stringify(body));
  const before = readFileSync(path, 'utf8');
  observations.queried.length = 0;
  // When: a checked dry run evaluates the exhausted current account.
  const result = await switchWithUsage({ dryRun: true, check: true, exhausted: true });
  // Then: the expired candidate is not refreshed, queried, or cached.
  assert.equal(result.to, '');
  assert.deepEqual(observations.queried, []);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(hasState(), false);
});

test('minimum interval prevents an immediate second switch', async () => {
  // Given: one successful switch just occurred.
  reset();
  usageByEmail.set('a@x.com', [usageWindow('primary', 99, 3_600_000)]);
  usageByEmail.set('b@x.com', [usageWindow('primary', 5, 3_600_000)]);
  await switchWithUsage({ minIntervalMs: 0 });
  // When: another exhausted event arrives inside the interval.
  const result = await switchWithUsage({ minIntervalMs: 600_000, exhausted: true });
  // Then: it is skipped and the selected account remains unchanged.
  assert.equal(result.switched, false);
  assert.match(result.message, /刚切换过/);
  assert.equal(nested(codexAuthPath, 'tokens', 'access_token'), 'token-b@x.com');
});

test('dry run reports target without touching credentials', async () => {
  // Given: an exhausted current account and available candidate.
  reset();
  usageByEmail.set('a@x.com', [usageWindow('primary', 100, 3_600_000)]);
  usageByEmail.set('b@x.com', [usageWindow('primary', 2, 3_600_000)]);
  // When: switching runs in dry-run mode.
  const result = await switchWithUsage({ minIntervalMs: 0, dryRun: true });
  // Then: the target is reported but credentials remain unchanged.
  assert.equal(result.switched, false);
  assert.equal(result.to, 'b@x.com');
  assert.equal(nested(codexAuthPath, 'tokens', 'access_token'), 'token-a@x.com');
});

test('disabled quota checks rotate by cooldown without queries', async () => {
  // Given: the current account is declared exhausted.
  reset();
  // When: checks are disabled.
  const result = await switchWithUsage({ minIntervalMs: 0, check: false, exhausted: true });
  // Then: rotation occurs without a quota request.
  assert.equal(result.switched, true);
  assert.equal(result.to, 'b@x.com');
  assert.deepEqual(observations.queried, []);
});

test('single-account pool explains that there is no switch target', async () => {
  // Given: only the current account remains in the account directory.
  reset();
  rmSync(join(accountsDir, 'codex-b@x.com.json'), { force: true });
  // When: an exhausted event requests switching.
  const result = await switchWithUsage({ minIntervalMs: 0, exhausted: true });
  // Then: the result explains the absent candidate without creating state.
  assert.equal(result.switched, false);
  assert.match(result.message, /没有可切换的对象/);
  assert.equal(existsSync(statePath), false);
});

test('quota response after a switch does not cooldown the newly selected account', async () => {
  // Given: account B was just selected after A exhausted.
  reset();
  usageByEmail.set('a@x.com', [usageWindow('primary', 100, 3_600_000)]);
  usageByEmail.set('b@x.com', [usageWindow('primary', 2, 3_600_000)]);
  await switchWithUsage({ minIntervalMs: 0 });
  // When: the previous response's exhausted signal arrives inside the interval.
  await switchWithUsage({ minIntervalMs: 600_000, exhausted: true });
  // Then: account B receives no exhausted cooldown.
  assert.equal(nested(statePath, 'accounts', 'codex:b@x.com', 'blockedUntil') ?? 0, 0);
});
