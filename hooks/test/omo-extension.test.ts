import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { omoPlugin } from '../src/install.js';
import { syncOmo } from '../src/omo-auth.js';

const entry = resolve('src/index.ts');

function invoke(args: readonly string[], env: NodeJS.ProcessEnv, input = ''): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((done) => {
    const child = execFile(process.execPath, ['--import', import.meta.resolve('tsx'), entry, ...args], { env, timeout: 30_000 }, (error, stdout, stderr) => {
      done({ code: error?.code === undefined ? 0 : Number(error.code), stdout, stderr });
    });
    child.stdin?.end(input);
  });
}

test('OmO extension installs and removes only its own file without touching credentials', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-omo-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, 'agent');
  const env = { ...process.env, HOME: home, OMO_CODING_AGENT_DIR: agentDir, QUOTAHOT_DATA_DIR: join(home, 'data') };
  const extension = join(agentDir, 'extensions', 'quotahot.js');
  const auth = join(agentDir, 'auth.json');
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  await writeFile(auth, '{"chatgpt-subscription":{"type":"oauth","access":"keep"}}');
  await writeFile(join(agentDir, 'extensions', 'other.js'), 'keep');

  const preview = await invoke(['install', 'omo', '--print'], env);
  assert.equal(preview.code, 0, preview.stderr);
  await assert.rejects(lstat(extension));
  const installed = await invoke(['install', 'omo'], env);
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal(await readFile(extension, 'utf8'), preview.stdout.slice(preview.stdout.indexOf('\n') + 1, -1));
  const removed = await invoke(['uninstall', 'omo'], env);
  assert.equal(removed.code, 0, removed.stderr);
  await assert.rejects(lstat(extension));
  assert.equal(await readFile(auth, 'utf8'), '{"chatgpt-subscription":{"type":"oauth","access":"keep"}}');
  assert.equal(await readFile(join(agentDir, 'extensions', 'other.js'), 'utf8'), 'keep');

  await writeFile(extension, 'foreign extension');
  assert.equal((await invoke(['install', 'omo'], env)).code, 0);
  assert.equal((await invoke(['uninstall', 'omo'], env)).code, 0);
  assert.equal(await readFile(extension, 'utf8'), 'foreign extension');
});

test('OmO quota event switches the selected single-slot credential and preserves other providers', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-omo-switch-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, 'agent');
  const data = join(home, 'data');
  await mkdir(join(data, 'accounts'), { recursive: true });
  await mkdir(agentDir);
  for (const name of ['a', 'b']) {
    await writeFile(join(data, 'accounts', `codex-${name}.json`), JSON.stringify({
      type: 'codex', email: `${name}@x.com`, account_id: `acct-${name}`,
      access_token: `token-${name}`, refresh_token: `refresh-${name}`,
      expired: new Date(Date.now() + 86_400_000).toISOString(), auto_refresh: true,
    }));
  }
  const auth = join(agentDir, 'auth.json');
  await writeFile(auth, JSON.stringify({
    'chatgpt-subscription': {
      type: 'oauth', access: 'token-a', refresh: 'refresh-a', expires: Date.now() + 86_400_000, accountId: 'acct-a',
      email: 'a@x.com', route: 'siwc', loginId: 'old-login',
      accounts: [{ name: 'default', access: 'token-a', refresh: 'refresh-a', expires: Date.now() + 86_400_000,
        accountId: 'acct-a', email: 'a@x.com', signedOut: true, route: 'siwc' }],
    },
    anthropic: { type: 'api_key', key: 'untouched' },
  }));
  const env = { ...process.env, HOME: home, OMO_CODING_AGENT_DIR: agentDir, QUOTAHOT_DATA_DIR: data, XDG_DATA_HOME: join(home, 'xdg') };
  const result = await invoke(['run', 'omo', '--no-check'], env, JSON.stringify({
    source: 'omo', provider: 'chatgpt-subscription', error: { message: 'usage limit has been reached' },
    omoRequest: { accountId: 'acct-a', email: 'a@x.com', loginId: 'old-login' },
  }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).switched, true);
  const changed = JSON.parse(await readFile(auth, 'utf8'));
  assert.equal(changed['chatgpt-subscription'].access, 'token-b');
  assert.match(changed['chatgpt-subscription'].loginId, /^[0-9a-f-]{36}$/);
  assert.notEqual(changed['chatgpt-subscription'].loginId, 'old-login');
  assert.equal(changed['chatgpt-subscription'].accounts[0].access, 'token-b');
  assert.equal(changed['chatgpt-subscription'].email, 'b@x.com');
  assert.equal(changed['chatgpt-subscription'].accounts[0].email, 'b@x.com');
  assert.equal(changed['chatgpt-subscription'].accounts[0].signedOut, undefined);
  assert.equal(changed['chatgpt-subscription'].route, undefined);
  assert.deepEqual(changed.anthropic, { type: 'api_key', key: 'untouched' });
  assert.equal(JSON.parse(await readFile(`${auth}.quotahot-bak`, 'utf8'))['chatgpt-subscription'].access, 'token-a');
});

test('OmO multi-account pool keeps its native credentials on quota errors', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-omo-pool-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, 'agent');
  const accounts = join(home, 'data', 'accounts');
  await mkdir(accounts, { recursive: true });
  await mkdir(agentDir);
  for (const name of ['a', 'b']) {
    await writeFile(join(accounts, `codex-${name}.json`), JSON.stringify({
      type: 'codex', email: `${name}@x.com`, account_id: `acct-${name}`,
      access_token: `token-${name}`, refresh_token: `refresh-${name}`,
      expired: new Date(Date.now() + 86_400_000).toISOString(), auto_refresh: true,
    }));
  }
  const auth = join(agentDir, 'auth.json');
  const original = JSON.stringify({
    'chatgpt-subscription': { type: 'oauth', access: 'token-a', refresh: 'refresh-a', expires: 123, accountId: 'acct-a',
      accounts: [
        { name: 'one', access: 'token-a', refresh: 'refresh-a', expires: 123, accountId: 'acct-a' },
        { name: 'two', access: 'token-b', refresh: 'refresh-b', expires: 123, accountId: 'acct-b' },
      ] },
  });
  await writeFile(auth, original);
  const env = { ...process.env, HOME: home, OMO_CODING_AGENT_DIR: agentDir, QUOTAHOT_DATA_DIR: join(home, 'data') };
  const result = await invoke(['run', 'omo', '--no-check'], env, JSON.stringify({
    source: 'omo', provider: 'chatgpt-subscription', error: { message: 'quota exhausted' },
    omoRequest: { accountId: 'acct-a', email: '', loginId: '' },
  }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).switched, false);
  assert.equal(await readFile(auth, 'utf8'), original);
  await assert.rejects(lstat(`${auth}.quotahot-bak`));
  await assert.rejects(lstat(join(home, '.codex', 'auth.json')));
});

test('OmO distinguishes different users in the same account from a token refresh', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-omo-identity-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const auth = join(home, 'auth.json');
  await writeFile(auth, JSON.stringify({
    'chatgpt-subscription': {
      type: 'oauth', access: 'token-a', refresh: 'refresh-a', expires: 100,
      accountId: 'shared', email: 'a@x.com', loginId: 'old-login', route: 'siwc',
    },
  }));
  const account = {
    id: 'b', provider: 'codex' as const, email: 'b@x.com', path: '', accountId: 'shared',
    accessToken: 'token-b', refreshToken: 'refresh-b', expiresAt: 200, disabled: false,
    plan: '', subscriptionEndsAt: 0, userId: '', source: '', autoRefresh: false,
    syncPath: '', syncSource: '', idToken: '',
  };
  assert.equal((await syncOmo(account, auth, 'test')).error, '');
  const switched = JSON.parse(await readFile(auth, 'utf8'))['chatgpt-subscription'];
  assert.equal(switched.email, 'b@x.com');
  assert.equal(switched.route, undefined);
  assert.notEqual(switched.loginId, 'old-login');
  assert.equal((await syncOmo({ ...account, accessToken: 'refreshed-token' }, auth, 'test')).error, '');
  const refreshed = JSON.parse(await readFile(auth, 'utf8'))['chatgpt-subscription'];
  assert.equal(refreshed.loginId, switched.loginId);
  const stale = await syncOmo(account, auth, 'test', { accountId: 'shared', email: 'a@x.com', loginId: 'old-login' });
  assert.notEqual(stale.error, '');
  assert.equal(JSON.parse(await readFile(auth, 'utf8'))['chatgpt-subscription'].access, 'refreshed-token');
});

test('OmO extension continues once after final Codex quota failure and reloads live credentials', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-omo-event-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const command = join(home, 'hook');
  const calls = join(home, 'calls');
  await writeFile(command, `#!/bin/sh
cat > ${JSON.stringify(calls)}
printf '%s' '{"switched":true}'
`);
  await chmod(command, 0o700);
  const pluginPath = join(home, 'quotahot.mjs');
  await writeFile(pluginPath, omoPlugin([command]));
  const pluginModule = await import(pathToFileURL(pluginPath).href);
  const handlers = new Map<string, (event: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown> | unknown>();
  let providerBlocked = true;
  let modelResetSucceeds = true;
  pluginModule.default({
    on: (name: string, handler: (event: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown> | unknown) => handlers.set(name, handler),
    setSessionModel: async () => {
      if (modelResetSucceeds) providerBlocked = false;
      return modelResetSucceeds;
    },
  });
  const turnEnd = handlers.get('turn_end');
  const settle = handlers.get('agent_before_settle');
  const input = handlers.get('input');
  const response = handlers.get('after_provider_response');
  const beforeRequest = handlers.get('before_provider_request');
  assert.ok(turnEnd && settle && input && response && beforeRequest);
  let reloads = 0;
  const ctx = {
    model: { provider: 'chatgpt-subscription' }, agentDir: join(home, 'agent'),
    modelRegistry: { authStorage: {
      get: () => ({ type: 'oauth', accountId: 'old-account', email: 'a@x.com', loginId: 'old-login' }),
      reload: () => { reloads += 1; return 'loaded'; },
    } }, hasUI: false,
  };
  const boundary = { outcome: 'error', entries: [{ type: 'custom', customType: 'other-extension' }], context: { canContinue: false } };
  await turnEnd({ message: { role: 'assistant', provider: 'anthropic', stopReason: 'error', errorMessage: 'quota exhausted' } });
  assert.equal(await settle(boundary, ctx), undefined);
  await turnEnd({ message: { role: 'assistant', provider: 'chatgpt-subscription', stopReason: 'error', errorMessage: 'network error' } });
  assert.equal(await settle(boundary, ctx), undefined);
  await turnEnd({ message: { role: 'assistant', provider: 'chatgpt-subscription', stopReason: 'error',
    errorMessage: 'quota exhausted', errorCause: { type: 'usage_limit', scope: 'model' } } });
  assert.equal(await settle(boundary, ctx), undefined);
  await assert.rejects(lstat(calls));
  await beforeRequest({}, ctx);
  await turnEnd({ message: { role: 'assistant', provider: 'chatgpt-subscription', stopReason: 'error', errorMessage: 'quota exhausted' } });
  assert.partialDeepStrictEqual(await settle(boundary, ctx), {
    continue: true,
    entries: [{ type: 'custom', customType: 'other-extension' }, { type: 'custom_message', customType: 'quotahot-recovery' }],
  });
  assert.equal(reloads, 1);
  assert.equal(JSON.parse(await readFile(calls, 'utf8')).provider, 'chatgpt-subscription');
  assert.partialDeepStrictEqual(JSON.parse(await readFile(calls, 'utf8')).omoRequest, {
    accountId: 'old-account', email: 'a@x.com', loginId: 'old-login',
  });
  assert.equal(await settle(boundary, ctx), undefined);
  assert.equal(reloads, 1);
  await input({ attribution: 'user' });
  assert.equal(providerBlocked, false, 'the next user message must not inherit the old account limit');
  await beforeRequest({}, ctx);
  await response({ status: 429 }, ctx);
  await turnEnd({ message: { role: 'assistant', provider: 'chatgpt-subscription', stopReason: 'error', errorMessage: 'HTTP failed' } });
  assert.partialDeepStrictEqual(await settle(boundary, ctx), { continue: true });
  assert.equal(JSON.parse(await readFile(calls, 'utf8')).error.statusCode, 429);
  await input({ attribution: 'user' });
  await beforeRequest({}, ctx);
  await turnEnd({ message: { role: 'assistant', provider: 'chatgpt-subscription', stopReason: 'error',
    errorCause: { type: 'usage_limit', scope: 'account' }, errorMessage: 'limit' } });
  assert.partialDeepStrictEqual(await settle(boundary, ctx), { continue: true });
  assert.equal(JSON.parse(await readFile(calls, 'utf8')).error.message, 'quota exhausted');
  await input({ attribution: 'user' });
  await beforeRequest({}, ctx);
  await turnEnd({ message: { role: 'assistant', provider: 'chatgpt-subscription', stopReason: 'error',
    errorCause: { type: 'usage_limit', scope: 'account' } } });
  modelResetSucceeds = false;
  assert.equal(await settle(boundary, ctx), undefined);
});

test('concurrent OmO sessions both resume after one real hook switches accounts', { timeout: 20_000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-omo-concurrent-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, 'agent');
  const data = join(home, 'data');
  await mkdir(join(data, 'accounts'), { recursive: true });
  await mkdir(agentDir);
  for (const name of ['a', 'b']) {
    await writeFile(join(data, 'accounts', `codex-${name}.json`), JSON.stringify({
      type: 'codex', email: `${name}@x.com`, account_id: `acct-${name}`,
      access_token: `token-${name}`, refresh_token: `refresh-${name}`,
      expired: new Date(Date.now() + 86_400_000).toISOString(), auto_refresh: true,
    }));
  }
  const authPath = join(agentDir, 'auth.json');
  const initial = {
    type: 'oauth', access: 'token-a', refresh: 'refresh-a', expires: Date.now() + 86_400_000,
    accountId: 'acct-a', email: 'a@x.com', loginId: 'initial-login',
  };
  await writeFile(authPath, JSON.stringify({ 'chatgpt-subscription': initial }));
  const original = { ...process.env };
  Object.assign(process.env, {
    HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'xdg'),
    QUOTAHOT_DATA_DIR: data, OMO_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: join(home, 'pi'),
  });
  t.after(() => {
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'QUOTAHOT_DATA_DIR', 'OMO_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR']) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  const command = join(home, 'hook');
  await writeFile(command, `#!/bin/sh
printf ready > ${JSON.stringify(join(home, 'ready-'))}$$
exec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(import.meta.resolve('tsx'))} ${JSON.stringify(entry)} run omo --no-check
`);
  await chmod(command, 0o700);
  const pluginPath = join(home, 'quotahot.mjs');
  await writeFile(pluginPath, omoPlugin([command]));
  const pluginModule = await import(pathToFileURL(pluginPath).href);
  const sessions = Array.from({ length: 2 }, () => {
    const handlers = new Map<string, (event: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown> | unknown>();
    pluginModule.default({
      on: (name: string, handler: (event: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown> | unknown) => handlers.set(name, handler),
      setSessionModel: async () => true,
    });
    let reloads = 0;
    const ctx = {
      model: { provider: 'chatgpt-subscription' }, agentDir,
      modelRegistry: { authStorage: { get: () => initial, reload: () => { reloads += 1; return 'loaded'; } } },
      hasUI: false,
    };
    return { handlers, ctx, reloadCount: () => reloads };
  });
  const lock = join(data, 'switch.lock');
  await writeFile(lock, 'test');
  const ready = new Set<string>();
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const bothStarted = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const watcher = watch(home, (_event, name) => {
    if (name?.toString().startsWith('ready-')) ready.add(name.toString());
    if (ready.size === 2) resolveReady();
  });
  watcher.on('error', rejectReady);
  const timeout = setTimeout(() => rejectReady(new Error('hook processes did not start')), 10_000);
  t.after(() => { clearTimeout(timeout); watcher.close(); });
  for (const session of sessions) {
    await session.handlers.get('before_provider_request')?.({}, session.ctx);
    await session.handlers.get('turn_end')?.({ message: {
      role: 'assistant', provider: 'chatgpt-subscription', stopReason: 'error', errorMessage: 'quota exhausted',
    } });
  }
  const results = sessions.map((session) => session.handlers.get('agent_before_settle')?.({ outcome: 'error', entries: [] }, session.ctx));
  await bothStarted;
  await rm(lock);
  for (const result of await Promise.all(results)) assert.partialDeepStrictEqual(result, { continue: true });
  assert.deepEqual(sessions.map((session) => session.reloadCount()), [1, 1]);
  assert.equal(JSON.parse(await readFile(authPath, 'utf8'))['chatgpt-subscription'].accountId, 'acct-b');
});

test('cancelling OmO while the hook runs stops recovery and credential reload', { timeout: 10_000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-omo-cancel-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const command = join(home, 'hook.mjs');
  const marker = join(home, 'ready');
  await writeFile(command, `
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
process.stdin.resume();
process.stdin.on('end', () => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => writeFileSync(${JSON.stringify(marker)}, 'ready'));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
});
`);
  const pluginPath = join(home, 'quotahot.mjs');
  await writeFile(pluginPath, omoPlugin([process.execPath, command]));
  const pluginModule = await import(pathToFileURL(pluginPath).href);
  const handlers = new Map<string, (event: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown> | unknown>();
  pluginModule.default({ on: (name: string, handler: (event: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown> | unknown) => handlers.set(name, handler) });
  const controller = new AbortController();
  let reloads = 0;
  const ctx = {
    model: { provider: 'chatgpt-subscription' }, agentDir: join(home, 'agent'), signal: controller.signal,
    modelRegistry: { authStorage: {
      get: () => ({ type: 'oauth', accountId: 'acct-a', email: 'a@x.com', loginId: 'old' }),
      reload: () => { reloads += 1; return 'loaded'; },
    } }, hasUI: false,
  };
  let ready: () => void = () => {};
  let fail: (error: Error) => void = () => {};
  const started = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
  const watcher = watch(home, (_event, name) => { if (name?.toString() === 'ready') ready(); });
  watcher.on('error', fail);
  t.after(() => watcher.close());
  await handlers.get('before_provider_request')?.({}, ctx);
  await handlers.get('turn_end')?.({ message: {
    role: 'assistant', provider: 'chatgpt-subscription', stopReason: 'error', errorMessage: 'quota exhausted',
  } });
  const result = handlers.get('agent_before_settle')?.({ outcome: 'error', entries: [] }, ctx);
  await started;
  controller.abort();
  assert.equal(await result, undefined);
  assert.equal(reloads, 0);
});
