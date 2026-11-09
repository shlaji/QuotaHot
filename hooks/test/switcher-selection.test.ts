import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  availabilityByEmail,
  accountsDir,
  codexAuthPath,
  dataDir,
  home,
  nested,
  observations,
  opencodeAuthPath,
  reset,
  statePath,
  switchWithUsage,
  usageByEmail,
  usageWindow,
  writeAccount,
} from './switcher-fixture.js';

test('configured order checks candidates before filename order and skips unavailable entries', async () => {
  reset();
  writeAccount('c@x.com');
  writeAccount('d@x.com');
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ accountOrder: {
    codex: ['codex:missing@x.com', null, 'codex:c@x.com', 'codex:c@x.com', 'codex:b@x.com'],
  } }));
  usageByEmail.set('c@x.com', [usageWindow('primary', 100, 3_600_000)]);
  usageByEmail.set('b@x.com', [usageWindow('primary', 100, 3_600_000)]);
  const result = await switchWithUsage({ exhausted: true, dryRun: true, cacheMs: 0 });
  assert.equal(result.to, 'd@x.com');
  assert.deepEqual(observations.queried, ['c@x.com', 'b@x.com', 'd@x.com']);
});

test('no-check honors configured order while invalid config falls back to filename order', async () => {
  for (const [accountOrder, expected] of [
    [{ codex: ['codex:c@x.com'] }, 'c@x.com'],
    [{ codex: 'invalid' }, 'b@x.com'],
    [null, 'b@x.com'],
  ] as const) {
    reset();
    writeAccount('c@x.com');
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ accountOrder }));
    const result = await switchWithUsage({ exhausted: true, check: false, dryRun: true });
    assert.equal(result.to, expected);
  }
});

test('Claude selection uses only Claude order and skips disabled accounts', async () => {
  reset();
  for (const [email, disabled] of [['a@x.com', false], ['b@x.com', false], ['c@x.com', true], ['d@x.com', false]] as const) {
    writeFileSync(join(accountsDir, `claude-${email}.json`), JSON.stringify({
      type: 'claude', email, disabled, access_token: `claude-${email}`,
      expired: new Date(Date.now() + 86_400_000).toISOString(),
    }));
  }
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ accountOrder: {
    codex: ['claude:b@x.com'], claude: ['claude:c@x.com', 'claude:d@x.com'],
  } }));
  const result = await switchWithUsage({ provider: 'claude', clients: ['claude-cli'], dryRun: true, check: false });
  assert.equal(result.to, 'd@x.com');
});

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

test('recovery observes the current account when it is the only account', async () => {
  reset();
  const { rmSync } = await import('node:fs');
  rmSync(join(accountsDir, 'codex-b@x.com.json'));
  usageByEmail.set('a@x.com', [usageWindow('primary', 10, 3_600_000)]);
  availabilityByEmail.set('a@x.com', true);

  const result = await switchWithUsage({ recover: true, cacheMs: 0, minIntervalMs: 0, threshold: 100 });

  assert.equal(result.switched, false);
  assert.equal(result.checked[0]?.usable, true);
  assert.deepEqual(observations.queried, ['a@x.com']);
});

test('another hook reuses a quota check completed after its request began', async () => {
  reset();
  usageByEmail.set('a@x.com', [usageWindow('primary', 100, 3_600_000)]);
  usageByEmail.set('b@x.com', [usageWindow('primary', 20, 3_600_000)]);
  const quotaCheckAfter = Date.now();

  const winner = await switchWithUsage({ triggerClient: 'opencode', exhausted: true, minIntervalMs: 0,
    cacheMs: 0, quotaCheckAfter });
  const queriesAfterWinner = [...observations.queried];
  const reused = await switchWithUsage({ triggerClient: 'opencode', exhausted: true, minIntervalMs: 0,
    cacheMs: 0, quotaCheckAfter });

  assert.equal(winner.switched, true);
  assert.deepEqual(observations.queried, queriesAfterWinner);
  assert.equal(reused.quotaCheck?.switched, true);
  assert.equal(reused.quotaCheck?.outcome, 'switched');
});

test('concurrent OmO quota failures reuse one switch and do not exhaust the new account', async () => {
  reset();
  const agentDir = join(home, '.omo', 'agent');
  mkdirSync(agentDir, { recursive: true });
  const authPath = join(agentDir, 'auth.json');
  writeFileSync(authPath, JSON.stringify({
    'chatgpt-subscription': {
      type: 'oauth', access: 'token-a@x.com', refresh: 'refresh-a@x.com',
      expires: Date.now() + 86_400_000, accountId: 'acct-a@x.com', email: 'a@x.com', loginId: 'old-login',
    },
  }));
  const { switchAccount } = await import('../src/switcher.js');
  let release: () => void = () => {};
  let started: () => void = () => {};
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const request = { accountId: 'acct-a@x.com', email: 'a@x.com', loginId: 'old-login' };
  const options = { triggerClient: 'omo-agent', exhausted: true, omoRequest: request } as const;
  const first = switchAccount({
    ...options,
    usageQuery: async (account) => {
      started();
      await gate;
      return {
        accountId: account.id, provider: account.provider, email: account.email, ok: true,
        status: 200, error: '', plan: '', subscriptionEndsAt: null, userId: '',
        quotaAvailable: true, windows: [], endpoint: 'test',
      };
    },
  });
  await entered;
  const laterOptions = { ...options, omoRequest: { ...request } };
  const second = switchAccount(laterOptions);
  release();
  const [winner, other] = await Promise.all([first, second]);

  assert.equal(winner.switched, true);
  assert.equal(other.switched, true);
  assert.equal(nested(authPath, 'chatgpt-subscription', 'accountId'), 'acct-b@x.com');
  assert.equal(nested(statePath, 'accounts', 'codex:b@x.com', 'blockedUntil'), 0);
  const late = await switchAccount(laterOptions);
  assert.equal(late.switched, true);
  assert.equal(nested(authPath, 'chatgpt-subscription', 'accountId'), 'acct-b@x.com');
});

test('OmO does not reuse an unrecorded credential change or mark the new account exhausted', async () => {
  reset();
  const agentDir = join(home, '.omo', 'agent');
  mkdirSync(agentDir, { recursive: true });
  const authPath = join(agentDir, 'auth.json');
  writeFileSync(authPath, JSON.stringify({
    'chatgpt-subscription': {
      type: 'oauth', access: 'token-b@x.com', refresh: 'refresh-b@x.com',
      expires: Date.now() + 86_400_000, accountId: 'acct-b@x.com', email: 'b@x.com', loginId: 'new-login',
    },
  }));
  const { switchAccount } = await import('../src/switcher.js');
  const result = await switchAccount({
    triggerClient: 'omo-agent', exhausted: true, check: false, minIntervalMs: 0,
    omoRequest: { accountId: 'acct-a@x.com', email: 'a@x.com', loginId: 'old-login' },
  });
  assert.equal(result.switched, false);
  assert.equal(nested(authPath, 'chatgpt-subscription', 'accountId'), 'acct-b@x.com');
  assert.equal(existsSync(statePath), false);
});

test('a quota error from the newly switched OmO account is not treated as the previous error', async () => {
  reset();
  writeAccount('c@x.com');
  const agentDir = join(home, '.omo', 'agent');
  mkdirSync(agentDir, { recursive: true });
  const authPath = join(agentDir, 'auth.json');
  writeFileSync(authPath, JSON.stringify({
    'chatgpt-subscription': {
      type: 'oauth', access: 'token-a@x.com', refresh: 'refresh-a@x.com',
      expires: Date.now() + 86_400_000, accountId: 'acct-a@x.com', email: 'a@x.com', loginId: 'old-login',
    },
  }));
  const { switchAccount } = await import('../src/switcher.js');
  const { readOmoIdentity } = await import('../src/omo-auth.js');
  const first = await switchAccount({
    triggerClient: 'omo-agent', exhausted: true, check: false, minIntervalMs: 0,
    omoRequest: { accountId: 'acct-a@x.com', email: 'a@x.com', loginId: 'old-login' },
  });
  assert.equal(first.switched, true);
  const identity = await readOmoIdentity(authPath);
  assert.ok(identity);
  const second = await switchAccount({
    triggerClient: 'omo-agent', exhausted: true, check: false, minIntervalMs: 0, omoRequest: identity,
  });
  assert.equal(second.switched, true);
  assert.equal(nested(authPath, 'chatgpt-subscription', 'accountId'), 'acct-c@x.com');
});

test('OmO verifies the current account before acting on an ambiguously attributed quota error', async () => {
  const { runHook } = await import('../src/runtime.js');
  for (const available of [true, null]) {
    reset();
    const agentDir = join(home, '.omo', 'agent');
    mkdirSync(agentDir, { recursive: true });
    const authPath = join(agentDir, 'auth.json');
    writeFileSync(authPath, JSON.stringify({
      'chatgpt-subscription': {
        type: 'oauth', access: 'token-b@x.com', refresh: 'refresh-b@x.com',
        expires: Date.now() + 86_400_000, accountId: 'acct-b@x.com', email: 'b@x.com', loginId: 'new-login',
      },
    }));
    const output = await runHook('omo', JSON.stringify({
      source: 'omo', provider: 'chatgpt-subscription', error: { message: 'quota exhausted' },
      omoRequest: { accountId: 'acct-b@x.com', email: 'b@x.com', loginId: 'new-login' },
    }), {
      usageQuery: async (account) => ({
        accountId: account.id, provider: account.provider, email: account.email,
        ok: available !== null, status: available === null ? 503 : 200,
        error: available === null ? 'usage_network_error' : '', plan: '', subscriptionEndsAt: null,
        userId: '', quotaAvailable: available, windows: [], endpoint: 'test',
      }),
    });
    assert.equal(JSON.parse(output.stdout).switched, false);
    assert.equal(JSON.parse(output.stdout).resume === true, available === true);
    assert.equal(nested(authPath, 'chatgpt-subscription', 'accountId'), 'acct-b@x.com');
    if (available === true) assert.equal(nested(statePath, 'accounts', 'codex:b@x.com', 'blockedUntil'), 0);
    else assert.equal(existsSync(statePath), false);
  }
});

test('OmO does not overwrite a login changed during the quota query', async () => {
  reset();
  const agentDir = join(home, '.omo', 'agent');
  mkdirSync(agentDir, { recursive: true });
  const authPath = join(agentDir, 'auth.json');
  const auth = (name: string) => JSON.stringify({ 'chatgpt-subscription': {
    type: 'oauth', access: `token-${name}@x.com`, refresh: `refresh-${name}@x.com`,
    expires: Date.now() + 86_400_000, accountId: `acct-${name}@x.com`, email: `${name}@x.com`, loginId: `login-${name}`,
  } });
  writeFileSync(authPath, auth('a'));
  const { switchAccount } = await import('../src/switcher.js');
  const result = await switchAccount({
    triggerClient: 'omo-agent', omoRequest: { accountId: 'acct-a@x.com', email: 'a@x.com', loginId: 'login-a' },
    usageQuery: async (account) => {
      if (account.email === 'a@x.com') writeFileSync(authPath, auth('c'));
      return {
        accountId: account.id, provider: account.provider, email: account.email,
        ok: true, status: 200, error: '', plan: '', subscriptionEndsAt: null, userId: '',
        quotaAvailable: account.email !== 'a@x.com', windows: [], endpoint: 'test',
      };
    },
  });
  assert.equal(result.switched, false);
  assert.equal(nested(authPath, 'chatgpt-subscription', 'accountId'), 'acct-c@x.com');
  assert.equal(nested(codexAuthPath, 'tokens', 'access_token'), 'token-a@x.com');
});

test('OmO identifies the right user when accounts share an account ID', async () => {
  reset();
  for (const name of ['a', 'b']) {
    writeFileSync(join(accountsDir, `codex-${name}@x.com.json`), JSON.stringify({
      type: 'codex', email: `${name}@x.com`, account_id: 'shared',
      access_token: `token-${name}`, refresh_token: `refresh-${name}`,
      expired: new Date(Date.now() + 86_400_000).toISOString(), auto_refresh: true,
    }));
  }
  const agentDir = join(home, '.omo', 'agent');
  mkdirSync(agentDir, { recursive: true });
  const authPath = join(agentDir, 'auth.json');
  writeFileSync(authPath, JSON.stringify({ 'chatgpt-subscription': {
    type: 'oauth', access: 'refreshed-b', refresh: 'refresh-b',
    expires: Date.now() + 86_400_000, accountId: 'shared', email: 'b@x.com', loginId: 'login-b',
  } }));
  const { switchAccount } = await import('../src/switcher.js');
  const queried: string[] = [];
  const result = await switchAccount({
    triggerClient: 'omo-agent', omoRequest: { accountId: 'shared', email: 'b@x.com', loginId: 'login-b' },
    usageQuery: async (account) => {
      queried.push(account.email);
      return {
        accountId: account.id, provider: account.provider, email: account.email,
        ok: true, status: 200, error: '', plan: '', subscriptionEndsAt: null, userId: '',
        quotaAvailable: true, windows: [], endpoint: 'test',
      };
    },
  });
  assert.equal(result.switched, false);
  assert.deepEqual(queried, ['b@x.com']);
  assert.equal(nested(authPath, 'chatgpt-subscription', 'accountId'), 'shared');
});
