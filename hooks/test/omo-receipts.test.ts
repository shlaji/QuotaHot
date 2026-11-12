import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  home, observations, reset, statePath, switchWithUsage, usageByEmail, usageWindow,
} from './switcher-fixture.js';

function omo() {
  reset();
  const directory = join(home, '.omo', 'agent');
  mkdirSync(directory, { recursive: true });
  const authPath = join(directory, 'auth.json');
  const identity = { accountId: 'acct-a@x.com', email: 'a@x.com', loginId: 'login' };
  writeFileSync(authPath, JSON.stringify({ 'chatgpt-subscription': {
    type: 'oauth', access: 'token-a@x.com', refresh: 'refresh-a@x.com',
    expires: Date.now() + 86_400_000, ...identity,
  } }));
  return { authPath, options: {
    triggerClient: 'omo-agent', recover: true, minIntervalMs: 0, cacheMs: 0,
    threshold: 100, quotaCheckAfter: Date.now(), omoRequest: identity,
  } };
}

for (const available of [false, true]) {
  test(`OmO shares a verified quota receipt with available=${available} without querying again`, async () => {
    const { options } = omo();
    usageByEmail.set('a@x.com', [usageWindow('primary', available ? 10 : 100, 3_600_000)]);
    usageByEmail.set('b@x.com', [usageWindow('primary', 100, 3_600_000)]);
    const first = await switchWithUsage(options);
    const queried = [...observations.queried];
    const receipt = readFileSync(statePath, 'utf8');

    const second = await switchWithUsage(options);

    assert.equal(first.switched, false);
    assert.equal(second.quotaCheck?.outcome, available ? 'available' : 'no_candidate');
    assert.equal(second.quotaCheck?.latestData, true);
    assert.deepEqual(observations.queried, queried);
    assert.equal(readFileSync(statePath, 'utf8'), receipt, 'reusing a receipt must not publish a new receipt');
  });
}

test('OmO does not reuse another login identity even when its quota receipt is fresh', async () => {
  const { options } = omo();
  usageByEmail.set('a@x.com', [usageWindow('primary', 10, 3_600_000)]);
  await switchWithUsage(options);
  const shared = JSON.parse(readFileSync(statePath, 'utf8'));
  shared.lastOmoQuotaCheck.omoRequest.loginId = 'another-login';
  writeFileSync(statePath, JSON.stringify(shared));
  observations.queried.length = 0;

  await switchWithUsage(options);

  assert.deepEqual(observations.queried, ['a@x.com']);
});

test('OmO checks disk identity before reusing an available quota receipt', async () => {
  const { options, authPath } = omo();
  usageByEmail.set('a@x.com', [usageWindow('primary', 10, 3_600_000)]);
  await switchWithUsage(options);
  const original = JSON.parse(readFileSync(authPath, 'utf8'));
  original['chatgpt-subscription'].loginId = 'manual-login';
  const manual = JSON.stringify(original);
  writeFileSync(authPath, manual);
  observations.queried.length = 0;

  const result = await switchWithUsage(options);

  assert.equal(result.switched, false);
  assert.equal(result.quotaCheck, undefined);
  assert.deepEqual(observations.queried, []);
  assert.equal(readFileSync(authPath, 'utf8'), manual);
});
