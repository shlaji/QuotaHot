import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import lockfile from 'proper-lockfile';
import { installPi, piExtensionPath, piExtensionSource, uninstallPi } from '../src/install.js';

const entry = resolve('src/index.ts');

function invoke(args: readonly string[], env: NodeJS.ProcessEnv, input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = execFile(process.execPath, ['--import', import.meta.resolve('tsx'), entry, ...args], { env, timeout: 30_000 }, (error, stdout, stderr) => {
      done({ code: error?.code === undefined ? 0 : Number(error.code), stdout, stderr });
    });
    child.stdin?.end(input);
  });
}

test('Pi install respects the agent directory, ownership marker, and other extensions', async (context) => {
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

  // Given: an unowned file at the target path.
  await writeFile(path, 'unowned');
  // When: install and uninstall are attempted.
  assert.deepEqual((await installPi(['/tmp/hook'])).paths, []);
  assert.deepEqual((await uninstallPi()).paths, []);
  // Then: neither operation alters that file.
  assert.equal(await readFile(path, 'utf8'), 'unowned');

  await rm(path);
  const installed = await installPi(['/tmp/hook']);
  assert.deepEqual(installed.paths, [path]);
  assert.equal(await readFile(path, 'utf8'), piExtensionSource(['/tmp/hook']));
  await installPi(['/tmp/hook']);
  assert.equal(await readFile(path, 'utf8'), piExtensionSource(['/tmp/hook']));
  await installPi(['/tmp/new hook']);
  assert.equal(await readFile(path, 'utf8'), piExtensionSource(['/tmp/new hook']));
  assert.deepEqual(await readdir(join(root, 'pi-agent', 'extensions')), ['other.ts', 'quotahot-hook.ts']);
  assert.deepEqual((await uninstallPi()).paths, [path]);
  await assert.rejects(access(path));
  assert.equal(await readFile(other, 'utf8'), 'keep');
});

test('Pi path defaults to the user agent extensions directory', () => {
  const old = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try { assert.equal(piExtensionPath(), join(process.env.HOME ?? '', '.pi', 'agent', 'extensions', 'quotahot-hook.ts')); }
  finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; }
});

test('Pi install waits for path lock and preserves an unowned replacement', async (context) => {
  // Given: an owned Pi extension while another operation holds its path lock.
  const root = await mkdtemp(join(tmpdir(), 'quotahot-pi-install-lock-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  context.after(() => { if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent; });
  const path = piExtensionPath();
  await mkdir(join(root, 'extensions'), { recursive: true });
  await writeFile(path, piExtensionSource(['/old-hook']));
  const release = await lockfile.lock(path, { realpath: false, stale: 30_000 });
  // When: install begins while locked, then another writer replaces the file before unlock.
  const installing = installPi(['/new-hook']);
  try {
    const completed = installing.then(() => true);
    assert.equal(await Promise.race([completed, new Promise<boolean>((resolveWaiting) => setTimeout(() => resolveWaiting(false), 150))]), false);
    await writeFile(path, 'unowned replacement');
  } finally {
    await release();
  }
  // Then: install rechecks ownership after acquiring the lock.
  assert.deepEqual((await installing).paths, []);
  assert.equal(await readFile(path, 'utf8'), 'unowned replacement');
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
  await writeFile(path, piExtensionSource(['/old-hook']));
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

test('Pi install and uninstall preserve a symlink even when its target has our marker', async (context) => {
  // Given: a third-party symlink pointing at an otherwise owned-looking extension.
  const root = await mkdtemp(join(tmpdir(), 'quotahot-pi-symlink-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  context.after(() => { if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent; });
  const path = piExtensionPath();
  const target = join(root, 'custom.ts');
  await mkdir(join(root, 'extensions'), { recursive: true });
  await writeFile(target, piExtensionSource(['/old-hook']));
  await symlink(target, path);
  // When: both operations inspect the symlink.
  assert.deepEqual((await installPi(['/new-hook'])).paths, []);
  assert.deepEqual((await uninstallPi()).paths, []);
  // Then: neither operation replaces the link or alters its target.
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), piExtensionSource(['/old-hook']));
});

test('Pi generated extension awaits pre-request checks only for supported model providers', async (context) => {
  // Given: the installed extension invokes a child which records its input before exiting.
  const root = await mkdtemp(join(tmpdir(), 'quotahot-pi-precheck-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const hook = join(root, 'fake-hook.mjs');
  const calls = join(root, 'calls.jsonl');
  const completed = join(root, 'completed.jsonl');
  await writeFile(hook, `import { appendFileSync } from 'node:fs';
let body = ''; for await (const chunk of process.stdin) body += chunk;
appendFileSync(process.env.CALLS, body + '\\n');
if (process.env.FAIL_HOOK === '1') process.exit(1);
setTimeout(() => {
  appendFileSync(process.env.COMPLETED, body + '\\n');
  process.stdout.write(JSON.stringify({ switched: true }));
}, 20);`);
  const path = join(root, 'extension.ts');
  await writeFile(path, piExtensionSource([process.execPath, hook, 'run', 'pi']));
  const generated = await import(path);
  const listeners = new Map<string, (event: unknown, ctx: { model?: { provider: string }; secret?: string }) => Promise<void>>();
  generated.default({ on: (name: string, handler: (event: unknown, ctx: { model?: { provider: string }; secret?: string }) => Promise<void>) => listeners.set(name, handler) });
  const handle = listeners.get('before_agent_start');
  assert.ok(handle);
  const previous = { CALLS: process.env.CALLS, COMPLETED: process.env.COMPLETED, FAIL_HOOK: process.env.FAIL_HOOK };
  process.env.CALLS = calls;
  process.env.COMPLETED = completed;
  context.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

  // When: Pi starts requests for supported models, followed by unsupported and missing models.
  for (const provider of ['anthropic', 'openai-codex']) {
    await handle({}, { model: { provider }, secret: 'must-not-leak' });
  }
  await handle({}, { model: { provider: 'other' }, secret: 'must-not-leak' });
  await handle({}, {});

  // Then: each supported request awaited child exit and sent only the check envelope.
  const expected = ['anthropic', 'openai-codex'].map((provider) => ({ source: 'pi', check: true, provider }));
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)), expected);
  assert.deepEqual((await readFile(completed, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)), expected);

  // When: the child fails, Pi must still be allowed to start the request.
  process.env.FAIL_HOOK = '1';
  await assert.doesNotReject(handle({}, { model: { provider: 'anthropic' } }));
});

test('Pi generated extension filters finalized quota errors and fails open on hook failure', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-pi-extension-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const hook = join(root, 'fake hook.mjs');
  const calls = join(root, 'calls.jsonl');
  await writeFile(hook, `import { appendFileSync } from 'node:fs';
let body = ''; for await (const chunk of process.stdin) body += chunk;
appendFileSync(process.env.CALLS, JSON.stringify({ args: process.argv.slice(2), body }) + '\\n');
if (process.env.FAIL_HOOK === '1') process.exit(1);
process.stdout.write(JSON.stringify({ switched: true, message: body, outcome: 'switched' }));`);
  const path = join(root, 'extension.ts');
  await writeFile(path, piExtensionSource([process.execPath, hook, 'run', 'pi']));
  const generated = await import(path);
  const notifications: string[] = [];
  const listeners = new Map<string, (event: { message: unknown }, ctx: { ui: { notify: (message: string) => void } }) => Promise<void>>();
  generated.default({ on: (name: string, handler: (event: { message: unknown }, ctx: { ui: { notify: (message: string) => void } }) => Promise<void>) => listeners.set(name, handler) });
  const handle = listeners.get('message_end');
  assert.ok(handle);
  const ctx = { ui: { notify: (message: string) => notifications.push(message) } };
  const oldCalls = process.env.CALLS;
  const oldFail = process.env.FAIL_HOOK;
  process.env.CALLS = calls;
  context.after(() => { if (oldCalls === undefined) delete process.env.CALLS; else process.env.CALLS = oldCalls; if (oldFail === undefined) delete process.env.FAIL_HOOK; else process.env.FAIL_HOOK = oldFail; });
  const message = { role: 'assistant', provider: 'anthropic', stopReason: 'error', errorMessage: 'quota_exceeded secret-value' };
  for (const ignored of [
    { ...message, role: 'user' }, { ...message, stopReason: 'stop' },
    { ...message, provider: 'other' }, { ...message, errorMessage: 'context limit exceeded' },
    { ...message, errorMessage: 'overloaded' },
  ]) await handle({ message: ignored }, ctx);
  await assert.rejects(access(calls));
  await handle({ message }, ctx);
  assert.equal(notifications.length, 1);
  assert.doesNotMatch(notifications[0] ?? '', /secret-value/);
  const recorded = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(recorded[0].args, ['run', 'pi']);
  assert.deepEqual(JSON.parse(recorded[0].body), message);
  process.env.FAIL_HOOK = '1';
  await assert.doesNotReject(handle({ message: { ...message, provider: 'openai-codex' } }, ctx));
  assert.equal(notifications.length, 1);
});

test('Pi quota event runs actual CLI and synchronizes same-provider clients', async (context) => {
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
  const installed = await invoke(['install', 'pi'], env);
  assert.equal(installed.code, 0, installed.stderr);
  const direct = await invoke(['run', 'pi', '--no-check'], env);
  assert.equal(direct.code, 0, direct.stderr);
  assert.equal(direct.stdout.trim(), '{}');
  const extension = await readFile(join(agent, 'extensions', 'quotahot-hook.ts'), 'utf8');
  assert.doesNotMatch(extension, /\.\.\/src\//);
  const e2eExtension = join(root, 'e2e-extension.ts');
  await writeFile(e2eExtension, piExtensionSource([process.execPath, '--import', import.meta.resolve('tsx'), entry, 'run', 'pi', '--no-check', '--min-interval-seconds', '0']));
  const generated = await import(e2eExtension);
  const listeners = new Map<string, (event: { message: unknown }, ctx: { ui: { notify: (message: string) => void } }) => Promise<void>>();
  generated.default({ on: (name: string, handler: (event: { message: unknown }, ctx: { ui: { notify: (message: string) => void } }) => Promise<void>) => listeners.set(name, handler) });
  const handle = listeners.get('message_end');
  assert.ok(handle);
  const notifications: string[] = [];
  const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, QUOTAHOT_DATA_DIR: process.env.QUOTAHOT_DATA_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  Object.assign(process.env, env);
  try {
    await handle({ message: { role: 'assistant', provider: 'openai-codex', stopReason: 'error', errorMessage: 'quota_exceeded' } }, { ui: { notify: (message: string) => notifications.push(message) } });
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  const result = JSON.parse(await readFile(auth, 'utf8'));
  assert.equal(result['openai-codex'].access, 'token-b');
  assert.deepEqual(result.anthropic, unchanged);
  assert.equal(notifications.length, 1);
  assert.doesNotMatch(notifications[0] ?? '', /a@x\.com|b@x\.com|token/);
  const codex = JSON.parse(await readFile(join(root, '.codex', 'auth.json'), 'utf8'));
  assert.equal(codex.tokens.access_token, 'token-b');
  await assert.rejects(access(join(root, 'client-data', 'opencode', 'auth.json')));
});
