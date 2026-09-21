import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTokenFiles, parseTokenFile } from '../src/server/import.js';
import { loadAccounts, saveAccount } from '../src/server/creds.js';

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

const token = { type: 'codex', email: 'alice@example.com', access_token: 'private-access', refresh_token: 'private-refresh' };
const file = (data: unknown) => ({ name: 'accounts.json', text: JSON.stringify(data) });

test('parses one object into a detached account when client settings are supplied', () => {
  const input = { ...token, id_token: 'private-id', account_id: 'acct-1', expired: '2030-01-01T00:00:00Z', sync_path: '/client/auth', source: 'codex-cli', auto_refresh: false };
  const result = parseTokenFile('accounts.json', JSON.stringify(input));
  assert.deepEqual(result, { accounts: [{ provider: 'codex', email: token.email, accountId: 'acct-1', accessToken: token.access_token, refreshToken: token.refresh_token, idToken: 'private-id', expiresAt: Date.parse(input.expired), source: 'token-file', autoRefresh: true, userId: '', plan: '' }], skipped: [] });
});

for (const provider of ['claude', 'codex', 'qoder']) {
  test(`parses ${provider} when refresh token is missing`, () => {
    const result = parseTokenFile('account.json', JSON.stringify({ type: provider, access_token: 'opaque' }));
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0]?.provider, provider);
    assert.equal(result.accounts[0]?.autoRefresh, false);
    assert.equal(result.accounts[0]?.email, 'account');
    assert.equal(result.accounts[0]?.expiresAt, 0);
    assert.equal(result.accounts[0]?.syncPath, undefined);
  });
}

for (const text of ['', 'private-raw-token', '{"access_token":"private-truncated', 'null', '42', 'true', '"private-token"']) {
  test(`rejects invalid JSON/root ${JSON.stringify(text)} without echoing contents`, () => {
    const result = parseTokenFile('bad.json', text);
    assert.equal(result.accounts.length, 0);
    assert.deepEqual(result.skipped, [{ id: 'bad.json', reason: ['null', '42', 'true', '"private-token"'].includes(text) ? 'JSON 必须是对象或对象数组' : 'JSON 格式无效' }]);
  });
}

test('continues parsing valid array entries when other entries are invalid', () => {
  const data = [{ ...token, type: 'unsupported-private' }, { ...token, access_token: ' ' }, null, [], 5, token];
  const result = parseTokenFile('mixed.json', JSON.stringify(data));
  assert.equal(result.accounts.length, 1);
  assert.deepEqual(result.skipped.map(({ reason }) => reason), ['不支持的账户类型', '缺少 access_token', '账户必须是 JSON 对象', '账户必须是 JSON 对象', '账户必须是 JSON 对象']);
  assert.deepEqual(result.skipped.map(({ id }) => id), ['mixed.json[1]', 'mixed.json[2]', 'mixed.json[3]', 'mixed.json[4]', 'mixed.json[5]']);
});

for (const access_token of [undefined, null, 123, {}, '']) {
  test(`rejects missing or non-string access token ${JSON.stringify(access_token)}`, () => {
    assert.equal(parseTokenFile('bad.json', JSON.stringify({ ...token, access_token })).skipped[0]?.reason, '缺少 access_token');
  });
}

test('uses id-token claims before access-token claims when explicit identity is absent', () => {
  const access = jwt({ email: 'access@example.com', account_id: 'access-id', exp: 2_000_000_000 });
  const id = jwt({ email: 'id@example.com', account_id: 'id-claim' });
  const result = parseTokenFile('claims.json', JSON.stringify({ type: 'codex', access_token: access, id_token: id }));
  assert.equal(result.accounts[0]?.email, 'id@example.com');
  assert.equal(result.accounts[0]?.accountId, 'id-claim');
  assert.equal(result.accounts[0]?.expiresAt, 2_000_000_000_000);
});

test('falls back to access claims when id-token has no identity and expiry is invalid', () => {
  const access = jwt({ email_address: 'access@example.com', account_id: 'access-id', exp: 2_000_000_000 });
  const result = parseTokenFile('claims.json', JSON.stringify({ type: 'codex', access_token: access, id_token: jwt({ sub: 'anonymous' }), expired: 'invalid' }));
  assert.equal(result.accounts[0]?.email, 'access@example.com');
  assert.equal(result.accounts[0]?.accountId, 'access-id');
  assert.equal(result.accounts[0]?.expiresAt, 2_000_000_000_000);
});

test('falls back to id-token expiry when access token has no expiry', () => {
  const result = parseTokenFile('claims.json', JSON.stringify({
    type: 'codex',
    access_token: 'opaque-access',
    id_token: jwt({ exp: 2_100_000_000 }),
    expired: 'invalid',
  }));
  assert.equal(result.accounts[0]?.expiresAt, 2_100_000_000_000);
});

test('normalizes imported email for provider-email idempotency', () => {
  const result = parseTokenFile('mixed-case.json', JSON.stringify({
    type: 'codex',
    email: 'Alice@Example.COM',
    access_token: 'opaque-access',
  }));
  assert.equal(result.accounts[0]?.email, 'alice@example.com');
});

test('keeps anonymous array entries distinct when falling back to filename', () => {
  const result = parseTokenFile('bundle.json', JSON.stringify([{ type: 'claude', access_token: 'one' }, { type: 'claude', access_token: 'two' }]));
  assert.deepEqual(result.accounts.map(({ email }) => email), ['bundle[1]', 'bundle[2]']);
});

test('parses cockpit-tools Codex export with nested tokens', () => {
  const result = parseTokenFile('codex-export.json', JSON.stringify({
    id: 'codex-account',
    email: 'codex@example.com',
    account_id: 'chatgpt-account',
    tokens: {
      access_token: 'codex-access',
      refresh_token: 'codex-refresh',
      id_token: jwt({ email: 'codex@example.com', account_id: 'chatgpt-account', exp: 2_100_000_000 }),
    },
  }));
  assert.deepEqual(result.skipped, []);
  assert.equal(result.accounts[0]?.provider, 'codex');
  assert.equal(result.accounts[0]?.accessToken, 'codex-access');
  assert.equal(result.accounts[0]?.refreshToken, 'codex-refresh');
  assert.equal(result.accounts[0]?.accountId, 'chatgpt-account');
  assert.equal(result.accounts[0]?.expiresAt, 2_100_000_000_000);
});

test('parses cockpit-tools Claude export with nested OAuth credentials', () => {
  const result = parseTokenFile('claude-export.json', JSON.stringify({
    id: 'claude-account',
    email: 'claude@example.com',
    claude_credentials_raw: {
      claudeAiOauth: {
        accessToken: 'claude-access',
        refreshToken: 'claude-refresh',
        expiresAt: 2_100_000_000_000,
      },
    },
  }));
  assert.deepEqual(result.skipped, []);
  assert.equal(result.accounts[0]?.provider, 'claude');
  assert.equal(result.accounts[0]?.accessToken, 'claude-access');
  assert.equal(result.accounts[0]?.refreshToken, 'claude-refresh');
  assert.equal(result.accounts[0]?.expiresAt, 2_100_000_000_000);
});

test('does not import cockpit-tools Qoder metadata without a token', () => {
  const result = parseTokenFile('qoder-export.json', JSON.stringify({
    id: 'qoder-account',
    email: 'qoder@example.com',
    user_id: 'qoder-user',
    auth_user_info_raw: { email: 'qoder@example.com' },
  }));
  assert.equal(result.accounts.length, 0);
  assert.deepEqual(result.skipped, [{ id: 'qoder-export.json', reason: '缺少 access_token' }]);
});

test('imports only first identity per request and returns no credentials', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-import-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const result = await importTokenFiles(dir, [file([token, { ...token, access_token: 'second-secret' }]), file({ ...token, type: 'claude', refresh_token: '' }), { name: 'bad.json', text: 'private-invalid-json' }]);
  assert.deepEqual(result, { imported: ['codex:alice@example.com', 'claude:alice@example.com'], skipped: [{ id: 'codex:alice@example.com', reason: '本次请求已导入该账户' }, { id: 'bad.json', reason: 'JSON 格式无效' }] });
  const accounts = await loadAccounts(dir);
  assert.equal(accounts.find(({ provider }) => provider === 'codex')?.accessToken, token.access_token);
  assert.equal(accounts.find(({ provider }) => provider === 'claude')?.autoRefresh, false);
  for (const account of accounts) {
    assert.equal(account.source, 'token-file');
    assert.equal(account.syncPath, '');
    assert.equal((await stat(account.path)).mode & 0o777, 0o600);
  }
});

test('overwrites existing identity when imported in another request', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-import-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  await importTokenFiles(dir, [file(token)]);
  const result = await importTokenFiles(dir, [file({ ...token, access_token: 'replacement', refresh_token: '' })]);
  assert.deepEqual(result, { imported: ['codex:alice@example.com'], skipped: [] });
  assert.equal((await readdir(dir)).length, 1);
  const [account] = await loadAccounts(dir);
  assert.equal(account?.accessToken, 'replacement');
  assert.equal(account?.autoRefresh, false);
});

test('rejects distinct emails that collide after filename sanitization', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-import-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  await importTokenFiles(dir, [file({ ...token, email: 'a+b@example.com' })]);
  const result = await importTokenFiles(dir, [file({ ...token, email: 'a_b@example.com', access_token: 'replacement' })]);
  assert.deepEqual(result, { imported: [], skipped: [{ id: 'codex:a_b@example.com', reason: '保存账户失败' }] });
  const accounts = await loadAccounts(dir);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.email, 'a+b@example.com');
});

test('reconciles qoder user identity and skips aliases within one request', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-import-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  await saveAccount(dir, { provider: 'qoder', email: 'original@example.com', userId: 'user-1', accessToken: 'old', refreshToken: '', expiresAt: 0, source: 'oauth', autoRefresh: false });
  const result = await importTokenFiles(dir, [file([{ ...token, type: 'qoder', email: 'Alias@Example.com', user_id: 'user-1', plan: 'pro' }, { ...token, type: 'qoder', email: 'another@example.com', user_id: 'user-1', access_token: 'duplicate' }])]);
  assert.deepEqual(result, { imported: ['qoder:original@example.com'], skipped: [{ id: 'qoder:original@example.com', reason: '本次请求已导入该账户' }] });
  const accounts = await loadAccounts(dir);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.accessToken, token.access_token);
  assert.equal(accounts[0]?.plan, 'pro');
});

test('continues after persistence failure without exposing exception details', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-import-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'codex-alice@example.com.json'));
  const result = await importTokenFiles(dir, [file([token, { ...token, email: 'other@example.com' }])]);
  assert.deepEqual(result, { imported: ['codex:other@example.com'], skipped: [{ id: 'codex:alice@example.com', reason: '保存账户失败' }] });
});
