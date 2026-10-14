import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import lockfile from 'proper-lockfile';
import { piExtensionPath, uninstallPi } from '../src/install.js';

const marker = '// quotahot:pi-extension\n';

const entry = resolve('src/index.ts');

function invoke(args: readonly string[], env: NodeJS.ProcessEnv, input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = execFile(process.execPath, ['--import', import.meta.resolve('tsx'), entry, ...args], { env, timeout: 30_000 }, (error, stdout, stderr) => {
      done({ code: error?.code === undefined ? 0 : Number(error.code), stdout, stderr });
    });
    child.stdin?.end(input);
  });
}

test('Pi uninstall removes only the marked regular extension and leaves auth and other extensions intact', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-pi-install-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'pi-agent');
  context.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
  const path = piExtensionPath();
  assert.equal(path, join(root, 'pi-agent', 'extensions', 'quotahot-hook.ts'));
  await mkdir(join(root, 'pi-agent', 'extensions'), { recursive: true });
  const other = join(root, 'pi-agent', 'extensions', 'other.ts');
  await writeFile(other, 'keep');
  const auth = join(root, 'pi-agent', 'auth.json');
  await writeFile(auth, '{"anthropic":{"access":"keep-auth"}}');
  await writeFile(path, 'unowned');

  assert.deepEqual((await uninstallPi()).paths, []);
  assert.equal(await readFile(path, 'utf8'), 'unowned');
  await rm(path);
  await writeFile(path, `${marker}old integration`);
  assert.deepEqual((await uninstallPi()).paths, [path]);
  await assert.rejects(access(path));
  assert.equal(await readFile(other, 'utf8'), 'keep');
  assert.equal(await readFile(auth, 'utf8'), '{"anthropic":{"access":"keep-auth"}}');
});

test('Pi uninstall leaves an absent extensions directory absent', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-pi-no-dir-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  context.after(() => { if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent; });
  const path = piExtensionPath();

  assert.deepEqual((await uninstallPi()).paths, []);
  await assert.rejects(access(join(root, 'agent', 'extensions')));
  await assert.rejects(access(path));
});

test('Pi path defaults to the user agent extensions directory', () => {
  const old = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try { assert.equal(piExtensionPath(), join(process.env.HOME ?? '', '.pi', 'agent', 'extensions', 'quotahot-hook.ts')); }
  finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; }
});

test('Pi uninstall waits for path lock and preserves an unowned replacement', async (context) => {
  // Given: an owned Pi extension while another operation holds its path lock.
  const root = await mkdtemp(join(tmpdir(), 'quotahot-pi-uninstall-lock-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  context.after(() => { if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent; });
  const path = piExtensionPath();
  await mkdir(join(root, 'extensions'), { recursive: true });
  await writeFile(path, `${marker}old integration`);
  const release = await lockfile.lock(path, { realpath: false, stale: 30_000 });
  // When: uninstall begins while locked, then another writer replaces the file before unlock.
  const uninstalling = uninstallPi();
  try {
    const completed = uninstalling.then(() => true);
    assert.equal(await Promise.race([completed, new Promise<boolean>((resolveWaiting) => setTimeout(() => resolveWaiting(false), 150))]), false);
    await writeFile(path, 'unowned replacement');
  } finally {
    await release();
  }
  // Then: uninstall rechecks ownership after acquiring the lock.
  assert.deepEqual((await uninstalling).paths, []);
  assert.equal(await readFile(path, 'utf8'), 'unowned replacement');
});

test('Pi uninstall preserves a symlink even when its target has our marker', async (context) => {
  // Given: a third-party symlink pointing at an otherwise owned-looking extension.
  const root = await mkdtemp(join(tmpdir(), 'quotahot-pi-symlink-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  context.after(() => { if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent; });
  const path = piExtensionPath();
  const target = join(root, 'custom.ts');
  await mkdir(join(root, 'extensions'), { recursive: true });
  await writeFile(target, `${marker}old integration`);
  await symlink(target, path);
  // When: uninstall inspects the symlink.
  assert.deepEqual((await uninstallPi()).paths, []);
  // Then: it neither removes the link nor alters its target.
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), `${marker}old integration`);
});

test('default install removes the Pi trigger and manual Pi events cannot switch credentials', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-pi-real-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, 'pi-agent');
  const data = join(root, 'data');
  await mkdir(agent, { recursive: true });
  await mkdir(join(data, 'accounts'), { recursive: true });
  const auth = join(agent, 'auth.json');
  const unchanged = { type: 'oauth', access: 'claude-original', refresh: 'claude-refresh', expires: Date.now() + 86_400_000 };
  await writeFile(auth, JSON.stringify({ anthropic: unchanged, 'openai-codex': { type: 'oauth', access: 'token-a', refresh: 'refresh-a', expires: Date.now() + 86_400_000, accountId: 'acct-a' } }));
  for (const name of ['a', 'b']) await writeFile(join(data, 'accounts', `codex-${name}.json`), JSON.stringify({
    type: 'codex', email: `${name}@x.com`, account_id: `acct-${name}`, access_token: `token-${name}`,
    refresh_token: `refresh-${name}`, expired: new Date(Date.now() + 86_400_000).toISOString(), auto_refresh: true,
  }));
  const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent, QUOTAHOT_DATA_DIR: data, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'client-data') };
  const installed = await invoke(['install'], env);
  assert.equal(installed.code, 0, installed.stderr);
  const direct = await invoke(['run', 'pi', '--no-check'], env);
  assert.equal(direct.code, 2, direct.stderr);
  await assert.rejects(access(join(agent, 'extensions', 'quotahot-hook.ts')));
  const result = JSON.parse(await readFile(auth, 'utf8'));
  assert.equal(result['openai-codex'].access, 'token-a');
  assert.deepEqual(result.anthropic, unchanged);
  await assert.rejects(access(join(root, '.codex', 'auth.json')));
  await assert.rejects(access(join(root, 'client-data', 'opencode', 'auth.json')));
});
