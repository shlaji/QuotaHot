import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

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
