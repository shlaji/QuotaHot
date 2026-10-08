import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClientTokens, tokensOfClientData, followSourceOf } from '../src/server/clientfile.js';
import { readClientCredentialSnapshot } from '../src/server/clientfilesnapshot.js';
import { setClientPaths } from '../src/server/clientpaths.js';

const expires = 1_800_000_000_000;
const auth = {
  anthropic: { type: 'oauth', access: 'claude-access', refresh: 'claude-refresh', expires },
  'openai-codex': { type: 'oauth', access: 'codex-access', refresh: 'codex-refresh', expires, accountId: 'acct-1' },
};

test('Pi reader scopes credentials to the requested provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-pi-reader-'));
  const path = join(dir, 'auth.json');
  await writeFile(path, JSON.stringify(auth));
  assert.deepEqual(await readClientTokens('pi-claude', path), {
    accessToken: 'claude-access', refreshToken: 'claude-refresh', expiresAt: expires,
    idToken: '', accountId: '', email: '',
  });
  assert.deepEqual(await readClientTokens('pi-codex', path), {
    accessToken: 'codex-access', refreshToken: 'codex-refresh', expiresAt: expires,
    idToken: '', accountId: 'acct-1', email: '',
  });
  assert.equal(await readClientTokens('pi', path), null);
});

test('Pi reader rejects API keys, incomplete OAuth entries and conflicting Codex identity', async () => {
  const cases: { source: string; credential: unknown }[] = [
    { source: 'pi-claude', credential: { ...auth.anthropic, type: 'api_key' } },
    { source: 'pi-claude', credential: { ...auth.anthropic, access: '' } },
    { source: 'pi-claude', credential: { ...auth.anthropic, refresh: '' } },
    { source: 'pi-claude', credential: { ...auth.anthropic, expires: 'tomorrow' } },
    { source: 'pi-claude', credential: { ...auth.anthropic, expires: Number.POSITIVE_INFINITY } },
    { source: 'pi-claude', credential: { ...auth.anthropic, expires: undefined } },
    { source: 'pi-codex', credential: { ...auth['openai-codex'], accountId: '' } },
    { source: 'pi-codex', credential: { ...auth['openai-codex'], access: jwt('acct-2') } },
  ];
  for (const entry of cases) {
    const key = entry.source === 'pi-claude' ? 'anthropic' : 'openai-codex';
    assert.equal(await tokensOfClientData(entry.source, { [key]: entry.credential }), null);
  }
});

test('Pi Codex reader retains account ID when decoded access identity agrees', async () => {
  const access = jwt('acct-1');
  const tokens = await tokensOfClientData('pi-codex', {
    'openai-codex': { ...auth['openai-codex'], access },
  });
  assert.equal(tokens?.accountId, 'acct-1');
  assert.equal(tokens?.accessToken, access);
});

function jwt(accountId: string): string {
  return `header.${Buffer.from(JSON.stringify({ chatgpt_account_id: accountId })).toString('base64url')}.signature`;
}

test('Pi follow resolves provider source and recorded custom path', () => {
  const path = '/custom/pi/auth.json';
  setClientPaths({ pi: '/configured/pi/auth.json' });
  try {
    assert.deepEqual(followSourceOf('claude', 'pi-claude', path), { source: 'pi-claude', label: 'Pi (Claude)', path });
    assert.deepEqual(followSourceOf('codex', 'pi-codex', path), { source: 'pi-codex', label: 'Pi (Codex)', path });
    assert.equal(followSourceOf('claude', 'pi-claude', ''), null);
    assert.equal(followSourceOf('codex', 'pi-codex', ''), null);
  } finally {
    setClientPaths({});
  }
});

test('Pi Claude source refuses Codex account instead of falling back to Codex CLI', () => {
  assert.equal(followSourceOf('codex', 'pi-claude', '/custom/pi/auth.json'), null);
});

test('Pi Codex source refuses Claude account instead of falling back to Claude Code', () => {
  assert.equal(followSourceOf('claude', 'pi-codex', '/custom/pi/auth.json'), null);
});

test('verified snapshot reader decodes each Pi provider independently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-pi-snapshot-'));
  const path = join(dir, 'auth.json');
  await writeFile(path, JSON.stringify(auth));
  for (const [source, accessToken] of [['pi-claude', 'claude-access'], ['pi-codex', 'codex-access']]) {
    const snapshot = await readClientCredentialSnapshot(source, path);
    assert.equal(snapshot?.tokens.accessToken, accessToken);
    assert.equal(snapshot?.tokens.expiresAt, expires);
    await snapshot?.close();
  }
});
