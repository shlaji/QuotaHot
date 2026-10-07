import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as filesystem } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';
import { loadAccounts } from '../src/account-files.js';
import { syncToClients } from '../src/client-auth.js';

const exec = promisify(execFile);
const loader = import.meta.resolve('tsx');
const switcher = pathToFileURL(resolve('src/switcher.ts')).href;

test('Claude cli-proxy candidate writes the Claude credential file during no-check switch', async (context) => {
  // Given: Claude currently uses account A and candidate B was imported from a cli-proxy file.
  const root = await mkdtemp(join(tmpdir(), 'quotahot-hook-claude-target-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const accountsDir = join(dataDir, 'accounts');
  const claudePath = join(root, '.claude', '.credentials.json');
  const importPath = join(root, 'cli-proxy-account.json');
  await mkdir(accountsDir, { recursive: true });
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(claudePath, JSON.stringify({ claudeAiOauth: { accessToken: 'token-a' } }));
  await writeFile(importPath, JSON.stringify({ access_token: 'import-token' }));
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  await writeFile(join(accountsDir, 'a.json'), JSON.stringify({
    type: 'claude', email: 'a@example.test', access_token: 'token-a', expired: expires,
  }));
  await writeFile(join(accountsDir, 'b.json'), JSON.stringify({
    type: 'claude', email: 'b@example.test', access_token: 'token-b', refresh_token: 'refresh-b',
    expired: expires, source: 'cli-proxy-api', sync_path: importPath,
  }));
  const importedBefore = await readFile(importPath, 'utf8');

  // When: the isolated CLI selects B without a quota request.
  const script = `const { switchAccount } = await import(${JSON.stringify(switcher)}); await switchAccount({ provider: 'claude', check: false, exhausted: true, minIntervalMs: 0, clients: ['claude-cli'] });`;
  await exec(process.execPath, ['--import', loader, '--input-type=module', '--eval', script], {
    cwd: process.cwd(), env: { ...process.env, HOME: root, QUOTAHOT_DATA_DIR: dataDir },
  });

  // Then: B is written to Claude Code, never back into its cli-proxy import source.
  const claude: unknown = JSON.parse(await readFile(claudePath, 'utf8'));
  assert.ok(claude !== null && typeof claude === 'object');
  const oauth: unknown = Reflect.get(claude, 'claudeAiOauth');
  assert.ok(oauth !== null && typeof oauth === 'object');
  assert.equal(Reflect.get(oauth, 'accessToken'), 'token-b');
  assert.equal(await readFile(importPath, 'utf8'), importedBefore);
});

test('empty access token cannot write other client fields during no-check switch', async (context) => {
  // Given: Codex currently uses A and candidate B has only ancillary credential fields.
  const root = await mkdtemp(join(tmpdir(), 'quotahot-hook-empty-token-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const accountsDir = join(dataDir, 'accounts');
  const codexPath = join(root, '.codex', 'auth.json');
  await mkdir(accountsDir, { recursive: true });
  await mkdir(join(root, '.codex'), { recursive: true });
  const clientBefore = JSON.stringify({ tokens: {
    access_token: 'token-a', refresh_token: 'refresh-a', id_token: 'id-a', account_id: 'A',
  } });
  await writeFile(codexPath, clientBefore);
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  await writeFile(join(accountsDir, 'a.json'), JSON.stringify({
    type: 'codex', email: 'a@example.test', account_id: 'A', access_token: 'token-a', expired: expires,
  }));
  await writeFile(join(accountsDir, 'b.json'), JSON.stringify({
    type: 'codex', email: 'b@example.test', account_id: 'B', access_token: '',
    refresh_token: 'refresh-b', id_token: 'id-b', expired: expires, auto_refresh: false,
  }));

  // When: the isolated CLI evaluates B without a quota request.
  const script = `const { switchAccount } = await import(${JSON.stringify(switcher)}); await switchAccount({ check: false, exhausted: true, minIntervalMs: 0, clients: ['codex-cli'] });`;
  await exec(process.execPath, ['--import', loader, '--input-type=module', '--eval', script], {
    cwd: process.cwd(), env: { ...process.env, HOME: root, QUOTAHOT_DATA_DIR: dataDir },
  });

  // Then: no refresh, ID, or account field from B enters the client file.
  assert.equal(await readFile(codexPath, 'utf8'), clientBefore);
});

async function piFixture(context: { after(callback: () => Promise<unknown>): void }, provider: 'claude' | 'codex') {
  const directory = await mkdtemp(join(tmpdir(), 'quotahot-pi-write-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const agentDir = join(directory, 'agent');
  const accountsDir = join(directory, 'accounts');
  await mkdir(agentDir);
  await mkdir(accountsDir);
  const authPath = join(agentDir, 'auth.json');
  await writeFile(join(accountsDir, 'account.json'), JSON.stringify({
    type: provider, email: 'b@example.test', account_id: provider === 'codex' ? 'B' : '',
    access_token: 'new-access', refresh_token: 'new-refresh', id_token: 'private-id-token',
    expired: new Date(Date.now() + 86_400_000).toISOString(),
  }));
  const [account] = await loadAccounts(accountsDir);
  assert.ok(account);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  context.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  return { account, authPath };
}

test('Pi Claude sync merges only anthropic, preserving Codex and unknown fields', async (context) => {
  // Given: Pi holds two OAuth logins and fields that QuotaHot does not own.
  const { account, authPath } = await piFixture(context, 'claude');
  const original = { anthropic: { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: 1, extra: 'keep' },
    'openai-codex': { type: 'oauth', access: 'codex-access', refresh: 'codex-refresh', expires: 2 }, custom: { key: 'value' } };
  await writeFile(authPath, JSON.stringify(original));
  // When: only Pi Claude is selected for sync.
  const [result] = await syncToClients(account, ['pi-claude']);
  // Then: the other provider and unknown fields survive, and no ID token is written.
  assert.equal(result?.error, '');
  const updated = JSON.parse(await readFile(authPath, 'utf8'));
  assert.deepEqual(updated.anthropic, { type: 'oauth', access: 'new-access', refresh: 'new-refresh', expires: account.expiresAt, extra: 'keep' });
  assert.deepEqual(updated['openai-codex'], original['openai-codex']);
  assert.deepEqual(updated.custom, original.custom);
  assert.equal(updated.anthropic.idToken, undefined);
  assert.equal(await readFile(`${authPath}.quotahot-bak`, 'utf8'), JSON.stringify(original));
});

test('Pi Codex sync merges only openai-codex and maps accountId without idToken', async (context) => {
  // Given: Pi holds provider-specific custom fields and a Claude login.
  const { account, authPath } = await piFixture(context, 'codex');
  const original = { anthropic: { type: 'oauth', access: 'claude', refresh: 'claude-refresh', expires: 1 },
    'openai-codex': { type: 'oauth', access: 'old', refresh: 'old-refresh', expires: 2, accountId: 'A', custom: 'keep' }, other: 42 };
  await writeFile(authPath, JSON.stringify(original));
  // When: only Pi Codex is selected for sync.
  const [result] = await syncToClients(account, ['pi-codex']);
  // Then: only its OAuth fields change.
  assert.equal(result?.error, '');
  const updated = JSON.parse(await readFile(authPath, 'utf8'));
  assert.deepEqual(updated['openai-codex'], { type: 'oauth', access: 'new-access', refresh: 'new-refresh', expires: account.expiresAt, accountId: 'B', custom: 'keep' });
  assert.deepEqual(updated.anthropic, original.anthropic);
  assert.equal(updated.other, 42);
  assert.equal(Object.hasOwn(updated['openai-codex'], 'idToken'), false);
});

test('Pi auth remains readable until the prepared replacement is renamed', async (context) => {
  const { account, authPath } = await piFixture(context, 'claude');
  const before = JSON.stringify({ anthropic: { type: 'oauth', access: 'old', refresh: 'old', expires: 1 } });
  await writeFile(authPath, before);
  const rename = filesystem.rename.bind(filesystem);
  let observed = false;
  context.mock.method(filesystem, 'rename', async (temporary: string, destination: string) => {
    assert.equal(destination, authPath);
    assert.equal(await readFile(authPath, 'utf8'), before);
    assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), JSON.parse(before));
    const prepared = JSON.parse(await readFile(temporary, 'utf8'));
    assert.equal(prepared.anthropic.access, 'new-access');
    observed = true;
    await rename(temporary, destination);
  });

  const [result] = await syncToClients(account, ['pi-claude']);

  assert.equal(result?.error, '');
  assert.equal(observed, true);
  assert.equal(JSON.parse(await readFile(authPath, 'utf8')).anthropic.access, 'new-access');
  assert.deepEqual((await readdir(join(authPath, '..'))).sort(), ['auth.json', 'auth.json.quotahot-bak']);
});

test('Pi rename failure preserves original auth bytes and removes prepared file', async (context) => {
  const { account, authPath } = await piFixture(context, 'claude');
  const before = JSON.stringify({ anthropic: { type: 'oauth', access: 'old', refresh: 'old', expires: 1 } });
  await writeFile(authPath, before);
  let observed = false;
  context.mock.method(filesystem, 'rename', async (temporary: string, destination: string) => {
    assert.equal(destination, authPath);
    assert.equal(await readFile(authPath, 'utf8'), before);
    assert.equal(JSON.parse(await readFile(temporary, 'utf8')).anthropic.access, 'new-access');
    observed = true;
    throw new Error('simulated rename failure');
  });

  const [result] = await syncToClients(account, ['pi-claude']);

  assert.match(result?.error ?? '', /simulated rename failure/);
  assert.equal(observed, true);
  assert.equal(await readFile(authPath, 'utf8'), before);
  assert.deepEqual((await readdir(join(authPath, '..'))).sort(), ['auth.json', 'auth.json.quotahot-bak']);
});

test('Pi Codex sync refuses to replace an existing OAuth credential without accountId', async (context) => {
  // Given: Pi's existing Codex entry has tokens but is missing its required identity.
  const { account, authPath } = await piFixture(context, 'codex');
  const before = JSON.stringify({
    anthropic: { type: 'oauth', access: 'claude', refresh: 'claude-refresh', expires: 1 },
    'openai-codex': { type: 'oauth', access: 'old', refresh: 'old-refresh', expires: 2 },
  });
  await writeFile(authPath, before);
  // When: QuotaHot tries to sync a different Codex account.
  const [result] = await syncToClients(account, ['pi-codex']);
  // Then: it reports failure and does not replace the incomplete credential.
  assert.ok(result?.error);
  assert.equal(await readFile(authPath, 'utf8'), before);
});

test('Pi Codex sync refuses to replace an existing accountId conflicting with its access token', async (context) => {
  // Given: Pi's existing Codex entry claims A, but its access token identifies B.
  const { account, authPath } = await piFixture(context, 'codex');
  const token = `x.${Buffer.from(JSON.stringify({ chatgpt_account_id: 'B' })).toString('base64url')}.y`;
  const before = JSON.stringify({ 'openai-codex': {
    type: 'oauth', access: token, refresh: 'old-refresh', expires: 2, accountId: 'A',
  } });
  await writeFile(authPath, before);
  // When: QuotaHot attempts to replace that entry.
  const [result] = await syncToClients(account, ['pi-codex']);
  // Then: conflicting existing identity is rejected without a write.
  assert.ok(result?.error);
  assert.equal(await readFile(authPath, 'utf8'), before);
});

test('Pi rejects malformed JSON, unsupported type and incomplete or conflicting account credentials', async (context) => {
  // Given: a selected Pi auth file with one unsafe state at a time.
  const { account, authPath } = await piFixture(context, 'codex');
  for (const contents of [
    '{invalid',
    JSON.stringify({ 'openai-codex': { type: 'api_key', key: 'keep' } }),
  ]) {
    await writeFile(authPath, contents);
    // When: the adapter attempts a provider sync.
    const [result] = await syncToClients(account, ['pi-codex']);
    // Then: it reports failure and never overwrites the file.
    assert.ok(result?.error);
    assert.equal(await readFile(authPath, 'utf8'), contents);
  }
  await rm(authPath);
  const [missingFile] = await syncToClients(account, ['pi-codex']);
  assert.ok(missingFile?.error);
  await assert.rejects(readFile(authPath, 'utf8'));
  account.refreshToken = '';
  const before = JSON.stringify({ anthropic: { access: 'untouched' } });
  await writeFile(authPath, before);
  const [missing] = await syncToClients(account, ['pi-codex']);
  assert.ok(missing?.error);
  assert.equal(await readFile(authPath, 'utf8'), before);
  account.refreshToken = 'new-refresh';
  account.accountId = 'A';
  account.accessToken = `x.${Buffer.from(JSON.stringify({ chatgpt_account_id: 'B' })).toString('base64url')}.y`;
  const [conflict] = await syncToClients(account, ['pi-codex']);
  assert.ok(conflict?.error);
  assert.equal(await readFile(authPath, 'utf8'), before);
});

test('Pi writer waits for a Pi lock and merges a concurrent refresh without lost updates', async (context) => {
  // Given: a separate Pi process owns the auth-path lock.
  const { account, authPath } = await piFixture(context, 'claude');
  await writeFile(authPath, JSON.stringify({ anthropic: { type: 'oauth', access: 'old', refresh: 'old', expires: 1 }, 'openai-codex': { type: 'oauth', access: 'old-codex', refresh: 'old-codex', expires: 1 } }));
  const script = `import lockfile from 'proper-lockfile'; import {readFile, writeFile} from 'node:fs/promises';
    const path = process.argv[1]; const release = await lockfile.lock(path, {realpath:false, stale:30000});
    process.stdout.write('locked\\n'); for await (const line of process.stdin) { if (line) break; }
    const data = JSON.parse(await readFile(path, 'utf8')); data['openai-codex'].access = 'fresh-codex';
    await writeFile(path, JSON.stringify(data)); await release();`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, authPath], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    // When: QuotaHot attempts to sync while the other process owns the lock.
    const pending = syncToClients(account, ['pi-claude']);
    child.stdin.end('release\n');
    const [result] = await pending;
    const [exitCode] = await exit;
    // Then: the waiting writer retains both provider updates.
    assert.equal(exitCode, 0);
    assert.equal(result?.error, '');
    const updated = JSON.parse(await readFile(authPath, 'utf8'));
    assert.equal(updated.anthropic.access, 'new-access');
    assert.equal(updated['openai-codex'].access, 'fresh-codex');
  } finally {
    child.kill();
  }
});

test('Pi lock acquisition timeout never changes auth.json', async (context) => {
  // Given: a Pi process holds the auth-path lock beyond the bounded wait.
  const { account, authPath } = await piFixture(context, 'claude');
  const before = JSON.stringify({ anthropic: { type: 'oauth', access: 'old', refresh: 'old', expires: 1 } });
  await writeFile(authPath, before);
  const release = await lockfile.lock(authPath, { realpath: false, stale: 30_000 });
  try {
    // When: QuotaHot attempts to acquire it.
    const [result] = await syncToClients(account, ['pi-claude']);
    // Then: the failure is surfaced without touching auth.json.
    assert.ok(result?.error);
    assert.equal(await readFile(authPath, 'utf8'), before);
  } finally {
    await release();
  }
});
