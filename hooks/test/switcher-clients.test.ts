import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  accountsDir,
  codexAuthPath,
  currentAccount,
  loadAccounts,
  nested,
  observations,
  opencodeAuthPath,
  home,
  reset,
  setClients,
  switchWithUsage,
  usageByEmail,
  usageWindow,
  writeAccount,
} from './switcher-fixture.js';
import { clientPath, readClientTokens } from '../src/client-auth.js';
import { CLIENTS } from '../src/switcher.js';
import { join } from 'node:path';

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

test('Pi targets are recognized client labels without changing provider defaults', () => {
  // Given: both Pi credential adapters are available.
  // When: the shared client registry is consulted.
  // Then: both Pi targets have safe descriptions for explicit CLI selection.
  assert.equal(CLIENTS['pi-claude'], 'Pi Claude');
  assert.equal(CLIENTS['pi-codex'], 'Pi Codex');
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

for (const triggerClient of ['codex-cli', 'opencode', 'pi-codex']) {
  test(`${triggerClient} quota switch synchronizes installed same-provider clients`, async () => {
    // Given: each Codex-family client uses A and Pi also has an unrelated Anthropic login.
    reset();
    const piPath = join(home, '.pi', 'agent', 'auth.json');
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(piPath, JSON.stringify({
      'openai-codex': { type: 'oauth', access: 'token-a@x.com', refresh: 'refresh-a', expires: 123, accountId: 'acct-a@x.com' },
      anthropic: { type: 'oauth', access: 'unrelated', refresh: 'unrelated-refresh', expires: 123 },
    }));
    usageByEmail.set('b@x.com', [usageWindow('primary', 2, 3_600_000)]);
    // When: any installed client triggers an automatic switch.
    const result = await switchWithUsage({ minIntervalMs: 0, exhausted: true, triggerClient });
    // Then: all installed Codex stores share B without touching the Anthropic login.
    assert.equal(result.switched, true);
    assert.equal(nested(codexAuthPath, 'tokens', 'access_token'), 'token-b@x.com');
    assert.equal(nested(opencodeAuthPath, 'openai', 'access'), 'token-b@x.com');
    assert.equal(nested(piPath, 'openai-codex', 'access'), 'token-b@x.com');
    assert.equal(nested(piPath, 'anthropic', 'access'), 'unrelated');
  });
}

for (const triggerClient of ['claude-cli', 'pi-claude']) {
  test(`${triggerClient} synchronizes Claude Code and Pi Anthropic without changing Pi Codex`, async () => {
  // Given: both Claude stores use A while Pi Codex has a separate login.
  reset();
  for (const email of ['a@x.com', 'b@x.com']) {
    writeFileSync(join(accountsDir, `claude-${email}.json`), JSON.stringify({
      type: 'claude', email, access_token: `claude-token-${email}`,
      refresh_token: `claude-refresh-${email}`,
      expired: new Date(Date.now() + 86_400_000).toISOString(), auto_refresh: true,
    }));
  }
  const piPath = join(home, '.pi', 'agent', 'auth.json');
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(piPath, JSON.stringify({
    anthropic: { type: 'oauth', access: 'claude-token-a@x.com', refresh: 'claude-refresh-a', expires: 123 },
    'openai-codex': { type: 'oauth', access: 'codex-untouched', refresh: 'codex-refresh', expires: 123, accountId: 'codex-id' },
  }));
  const claudePath = clientPath('claude-cli');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(claudePath, JSON.stringify({ claudeAiOauth: { accessToken: 'claude-token-a@x.com' } }));
  usageByEmail.set('b@x.com', [usageWindow('5h', 2, 3_600_000)]);
  try {
    // When: either Claude client triggers the automatic switch.
    const result = await switchWithUsage({ provider: 'claude', minIntervalMs: 0, exhausted: true, triggerClient });
    // Then: both Claude stores use B; Codex stores and Pi Codex retain their logins.
    assert.equal(result.switched, true);
    assert.equal(nested(claudePath, 'claudeAiOauth', 'accessToken'), 'claude-token-b@x.com');
    assert.equal(nested(piPath, 'anthropic', 'access'), 'claude-token-b@x.com');
    assert.equal(nested(piPath, 'openai-codex', 'access'), 'codex-untouched');
    assert.equal(nested(codexAuthPath, 'tokens', 'access_token'), 'token-a@x.com');
  } finally {
    rmSync(claudePath, { force: true });
  }
  });
}

test('default Codex switch skips absent Pi auth without creating it', async () => {
  // Given: Pi has no installed auth store.
  reset();
  const piPath = join(home, '.pi', 'agent', 'auth.json');
  rmSync(piPath, { force: true });
  usageByEmail.set('b@x.com', [usageWindow('primary', 2, 3_600_000)]);
  // When: Codex CLI triggers a default switch.
  const result = await switchWithUsage({ minIntervalMs: 0, exhausted: true, triggerClient: 'codex-cli' });
  // Then: existing clients switch, but no Pi file is invented.
  assert.equal(result.switched, true);
  assert.equal(existsSync(piPath), false);
  assert.equal(result.written.some((write) => write.source === 'pi-codex'), false);
});

test('Pi trigger without auth reports a failed trigger write', async () => {
  // Given: Pi auth does not exist, though other Codex clients do.
  reset();
  const piPath = join(home, '.pi', 'agent', 'auth.json');
  rmSync(piPath, { force: true });
  usageByEmail.set('b@x.com', [usageWindow('primary', 2, 3_600_000)]);
  // When: Pi requests an automatic switch.
  const result = await switchWithUsage({ minIntervalMs: 0, exhausted: true, triggerClient: 'pi-codex' });
  // Then: the Pi write fails without creating its auth file or claiming success.
  assert.equal(result.switched, false);
  assert.equal(existsSync(piPath), false);
  assert.equal(result.written.some((write) => write.source === 'pi-codex' && Boolean(write.error)), true);
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

test('Pi resolves its configured auth directory and identifies both provider accounts', async () => {
  // Given: a private Pi auth file with both OAuth providers.
  reset();
  const piDir = join(home, 'pi-agent');
  mkdirSync(piDir, { recursive: true });
  const original = process.env.PI_CODING_AGENT_DIR;
  const previous = join(home, 'existing-pi-agent');
  process.env.PI_CODING_AGENT_DIR = previous;
  process.env.PI_CODING_AGENT_DIR = piDir;
  try {
    writeFileSync(join(piDir, 'auth.json'), JSON.stringify({
      anthropic: { type: 'oauth', access: 'token-b@x.com', refresh: 'refresh-b', expires: 123 },
      'openai-codex': { type: 'oauth', access: 'different-token', refresh: 'refresh-b', expires: 456, accountId: 'acct-b@x.com' },
    }));
    const accounts = await loadAccounts(accountsDir);
    // When: Pi's provider-specific sources are resolved and read.
    assert.equal(clientPath('pi-claude'), join(piDir, 'auth.json'));
    assert.equal(clientPath('pi-codex'), join(piDir, 'auth.json'));
    assert.equal((await readClientTokens('pi-claude', clientPath('pi-claude')))?.accessToken, 'token-b@x.com');
    assert.equal((await readClientTokens('pi-codex', clientPath('pi-codex')))?.accountId, 'acct-b@x.com');
    // Then: the shared identity lookup recognizes a token or an account ID.
    assert.equal((await currentAccount('pi-claude', accounts))?.email, 'b@x.com');
    assert.equal((await currentAccount('pi-codex', accounts))?.email, 'b@x.com');
  } finally {
    process.env.PI_CODING_AGENT_DIR = previous;
    try {
      assert.equal(process.env.PI_CODING_AGENT_DIR, previous);
    } finally {
      if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = original;
    }
  }
});

test('Pi defaults to the agent auth path and an unknown source has no path', () => {
  // Given: Pi has no directory override.
  const previous = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    // When: its path and an unknown source are resolved.
    const piPath = clientPath('pi-codex');
    const unknownPath = clientPath('unrecognized-client');
    // Then: Pi uses the normal agent location without routing an unknown source.
    assert.equal(piPath, join(home, '.pi', 'agent', 'auth.json'));
    assert.equal(unknownPath, '');
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test('Pi Codex switch writes only its selected client target', async () => {
  // Given: two accounts and a Pi auth file on account A.
  reset();
  const piDir = join(home, 'pi-switch');
  mkdirSync(piDir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = piDir;
  const piPath = join(piDir, 'auth.json');
  try {
    writeFileSync(piPath, JSON.stringify({
      'openai-codex': { type: 'oauth', access: 'token-a@x.com', refresh: 'refresh-a', expires: 123, accountId: 'acct-a@x.com' },
      anthropic: { type: 'oauth', access: 'claude', refresh: 'claude-refresh', expires: 123 },
    }));
    usageByEmail.set('b@x.com', [usageWindow('primary', 2, 3_600_000)]);
    // When: Pi Codex triggers a switch and is the sole selected target.
    const result = await switchWithUsage({ minIntervalMs: 0, exhausted: true, triggerClient: 'pi-codex', clients: ['pi-codex'] });
    // Then: the switch succeeds without touching Codex CLI or the Pi Claude provider.
    assert.equal(result.switched, true);
    assert.equal(nested(piPath, 'openai-codex', 'access'), 'token-b@x.com');
    assert.equal(nested(piPath, 'anthropic', 'access'), 'claude');
    assert.equal(nested(codexAuthPath, 'tokens', 'access_token'), 'token-a@x.com');
    assert.equal(nested(opencodeAuthPath, 'openai', 'access'), 'token-a@x.com');
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test('Pi Claude switch writes only its provider entry and leaves Claude Code untouched', async () => {
  // Given: two Claude accounts and Pi using the exhausted one.
  reset();
  for (const email of ['a@x.com', 'b@x.com']) {
    writeFileSync(join(accountsDir, `claude-${email}.json`), JSON.stringify({
      type: 'claude', email, access_token: `claude-token-${email}`,
      refresh_token: `claude-refresh-${email}`,
      expired: new Date(Date.now() + 86_400_000).toISOString(),
      auto_refresh: true,
    }));
  }
  const piDir = join(home, 'pi-claude-switch');
  mkdirSync(piDir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = piDir;
  const piPath = join(piDir, 'auth.json');
  const claudePath = clientPath('claude-cli');
  try {
    writeFileSync(piPath, JSON.stringify({
      anthropic: { type: 'oauth', access: 'claude-token-a@x.com', refresh: 'claude-refresh-a', expires: 123 },
      'openai-codex': { type: 'oauth', access: 'codex-unchanged', refresh: 'codex-refresh', expires: 123, accountId: 'codex-id' },
    }));
    usageByEmail.set('b@x.com', [usageWindow('5h', 2, 3_600_000)]);
    // When: the shared switcher receives an explicit Pi Claude target.
    const result = await switchWithUsage({ provider: 'claude', minIntervalMs: 0, exhausted: true, triggerClient: 'pi-claude', clients: ['pi-claude'] });
    // Then: only Pi Anthropic changes; no other client's auth file is created or changed.
    assert.equal(result.switched, true);
    assert.equal(nested(piPath, 'anthropic', 'access'), 'claude-token-b@x.com');
    assert.equal(nested(piPath, 'openai-codex', 'access'), 'codex-unchanged');
    assert.equal(nested(codexAuthPath, 'tokens', 'access_token'), 'token-a@x.com');
    assert.equal(nested(opencodeAuthPath, 'openai', 'access'), 'token-a@x.com');
    assert.equal(existsSync(claudePath), false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
