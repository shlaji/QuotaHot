import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import * as undici from 'undici';

let refreshPayload: Readonly<Record<string, unknown>> = {};
let refreshHeaders: HeadersInit | undefined;

mock.module('undici', {
  exports: {
    ...undici,
    fetch: async (_url: string, options: { readonly headers?: HeadersInit }) => {
      refreshHeaders = options.headers;
      return new Response(JSON.stringify(refreshPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  },
});

  const { loadAccounts } = await import('../src/account-files.js');
  const { ensureFresh } = await import('../src/credentials.js');
const network = { proxy: '', noProxy: [] } as const;

function jwt(claims: Readonly<Record<string, unknown>>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

async function accountFixture(fields: Readonly<Record<string, unknown>>) {
  const directory = await mkdtemp(join(tmpdir(), 'quotahot-hook-credentials-'));
  const accounts = join(directory, 'accounts');
  const path = join(accounts, 'account.json');
  await mkdir(accounts);
  await writeFile(path, JSON.stringify({
    type: 'codex',
    email: 'a@example.test',
    account_id: 'A',
    access_token: 'stale-access',
    refresh_token: 'stale-refresh',
    id_token: jwt({ chatgpt_account_id: 'A', email: 'a@example.test' }),
    expired: '2020-01-01T00:00:00Z',
    auto_refresh: true,
    ...fields,
  }));
  const [account] = await loadAccounts(accounts);
  assert.ok(account);
  return { account, directory, path };
}

test('OAuth renewal rejects conflicting access and ID token identities before writing', async (context) => {
  // Given: a saved account and a refresh response whose access token is A but ID token is B.
  const fixture = await accountFixture({});
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const before = await readFile(fixture.path, 'utf8');
  refreshPayload = {
    access_token: jwt({ chatgpt_account_id: 'A' }),
    id_token: jwt({ chatgpt_account_id: 'B' }),
    refresh_token: 'rotated-refresh',
    expires_in: 3600,
  };

  // When: the isolated hook renews the expired account.
  const renewed = await ensureFresh(fixture.account, network);

  // Then: the conflict is rejected before the account file changes.
  assert.equal(renewed, false);
  assert.equal(await readFile(fixture.path, 'utf8'), before);
});

test('client following rejects conflicting access and ID token identities before writing', async (context) => {
  // Given: a client file claims account A explicitly but carries an access token for B.
  const directory = await mkdtemp(join(tmpdir(), 'quotahot-hook-client-'));
  const clientPath = join(directory, 'auth.json');
  await writeFile(clientPath, JSON.stringify({ tokens: {
    account_id: 'A',
    access_token: jwt({ chatgpt_account_id: 'B', exp: Math.floor(Date.now() / 1000) + 3600 }),
    id_token: jwt({ chatgpt_account_id: 'A' }),
  } }));
  const fixture = await accountFixture({
    auto_refresh: false,
    sync_source: 'codex-cli',
    sync_path: clientPath,
  });
  context.after(() => Promise.all([
    rm(directory, { recursive: true, force: true }),
    rm(fixture.directory, { recursive: true, force: true }),
  ]));
  const before = await readFile(fixture.path, 'utf8');

  // When: the isolated hook follows the client credential file.
  const renewed = await ensureFresh(fixture.account, network);

  // Then: the conflicting token pair cannot enter the account file.
  assert.equal(renewed, false);
  assert.equal(await readFile(fixture.path, 'utf8'), before);
});

test('Claude client following rejects a different profile email before writing', async (context) => {
  // Given: account A follows a Claude credential file while Claude's profile identifies account B.
  const home = await mkdtemp(join(tmpdir(), 'quotahot-hook-claude-home-'));
  const clientPath = join(home, '.credentials.json');
  await writeFile(clientPath, JSON.stringify({ claudeAiOauth: {
    accessToken: 'fresh-client-token',
    refreshToken: 'fresh-client-refresh',
    expiresAt: Date.now() + 3_600_000,
  } }));
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'b@example.test' },
  }));
  const fixture = await accountFixture({
    type: 'claude',
    account_id: '',
    auto_refresh: false,
    sync_source: 'claude-cli',
    sync_path: clientPath,
  });
  context.after(() => Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(fixture.directory, { recursive: true, force: true }),
  ]));
  const before = await readFile(fixture.path, 'utf8');
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  // When: the isolated hook follows Claude's current login.
  const renewed = await ensureFresh(fixture.account, network);
  process.env.HOME = previousHome;

  // Then: the different client identity cannot enter account A's file.
  assert.equal(renewed, false);
  assert.equal(await readFile(fixture.path, 'utf8'), before);
});

test('Claude OAuth renewal omits Authorization and preserves matching renewal behavior', async (context) => {
  // Given: an expired Claude account and a valid token response.
  const fixture = await accountFixture({ type: 'claude', account_id: '' });
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  refreshPayload = { access_token: 'fresh-claude-token', refresh_token: 'fresh-refresh', expires_in: 3600 };
  refreshHeaders = undefined;

  // When: the isolated hook performs OAuth renewal.
  const renewed = await ensureFresh(fixture.account, network);

  // Then: renewal succeeds without presenting an empty bearer credential.
  assert.equal(renewed, true);
  assert.equal(new Headers(refreshHeaders).has('authorization'), false);
  assert.equal(JSON.parse(await readFile(fixture.path, 'utf8')).access_token, 'fresh-claude-token');
});
