import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  accountsDir,
  codexAuthPath,
  currentAccount,
  loadAccounts,
  nested,
  observations,
  opencodeAuthPath,
  reset,
  setClients,
  switchWithUsage,
  usageByEmail,
  usageWindow,
  writeAccount,
} from './switcher-fixture.js';

test('client filter writes only the selected client', async () => {
  // Given: both clients use the exhausted current account.
  reset();
  usageByEmail.set('a@x.com', [usageWindow('primary', 100, 3_600_000)]);
  usageByEmail.set('b@x.com', [usageWindow('primary', 2, 3_600_000)]);
  // When: only Codex CLI is selected for writing.
  const result = await switchWithUsage({ minIntervalMs: 0, clients: ['codex-cli'], triggerClient: 'opencode' });
  // Then: Codex changes and OpenCode remains untouched.
  assert.equal(result.switched, true);
  assert.equal(nested(codexAuthPath, 'tokens', 'access_token'), 'token-b@x.com');
  assert.equal(nested(opencodeAuthPath, 'openai', 'access'), 'token-a@x.com');
});

test('OpenCode trigger uses the OpenCode current account', async () => {
  // Given: Codex already uses B while OpenCode still uses exhausted A.
  reset();
  writeFileSync(codexAuthPath, JSON.stringify({
    tokens: { access_token: 'token-b@x.com', account_id: 'acct-b@x.com' },
    other: 'keep',
  }));
  usageByEmail.set('b@x.com', [usageWindow('primary', 2, 3_600_000)]);
  // When: OpenCode triggers the exhausted switch.
  const result = await switchWithUsage({ minIntervalMs: 0, exhausted: true, triggerClient: 'opencode' });
  // Then: A is the source and B is selected without being cooled as current.
  assert.equal(result.switched, true);
  assert.equal(result.from, 'a@x.com');
  assert.equal(result.to, 'b@x.com');
  assert.equal(nested(opencodeAuthPath, 'openai', 'access'), 'token-b@x.com');
});

test('trigger-client write failure preserves partial result and permits immediate retry', async () => {
  // Given: the OpenCode backup path blocks its write while Codex remains writable.
  reset();
  writeAccount('c@x.com');
  usageByEmail.set('b@x.com', [usageWindow('primary', 2, 3_600_000)]);
  usageByEmail.set('c@x.com', [usageWindow('primary', 1, 3_600_000)]);
  rmSync(`${opencodeAuthPath}.quotahot-bak`, { recursive: true, force: true });
  mkdirSync(`${opencodeAuthPath}.quotahot-bak`);
  // When: OpenCode triggers a switch whose OpenCode write fails.
  const failed = await switchWithUsage({ minIntervalMs: 60_000, exhausted: true, triggerClient: 'opencode' });
  // Then: partial writes are visible, no later candidate is queried, and no success is claimed.
  assert.equal(failed.switched, false);
  assert.equal(nested(codexAuthPath, 'tokens', 'access_token'), 'token-b@x.com');
  assert.equal(nested(opencodeAuthPath, 'openai', 'access'), 'token-a@x.com');
  assert.equal(failed.written.some((write) => write.source === 'codex-cli' && !write.error), true);
  assert.equal(failed.written.some((write) => write.source === 'opencode' && Boolean(write.error)), true);
  assert.equal(failed.checked.some((account) => account.source === 'error'), true);
  assert.equal(observations.queried.includes('c@x.com'), false);

  rmSync(`${opencodeAuthPath}.quotahot-bak`, { recursive: true, force: true });
  const retried = await switchWithUsage({ minIntervalMs: 60_000, exhausted: true, triggerClient: 'opencode' });
  assert.equal(retried.switched, true);
  assert.equal(nested(opencodeAuthPath, 'openai', 'access'), 'token-b@x.com');
});

test('current-account detection identifies both clients and rejects strangers', async () => {
  // Given: both account files and client credentials exist.
  reset();
  const accounts = await loadAccounts(accountsDir);
  setClients('b@x.com');
  // When/Then: token identity resolves each known client.
  assert.equal((await currentAccount('codex-cli', accounts))?.email, 'b@x.com');
  assert.equal((await currentAccount('opencode', accounts))?.email, 'b@x.com');
  // Given/When: Codex contains a token absent from the account directory.
  writeFileSync(codexAuthPath, JSON.stringify({ tokens: { access_token: 'stranger' } }));
  // Then: no arbitrary account is selected.
  assert.equal(await currentAccount('codex-cli', accounts), null);
});
