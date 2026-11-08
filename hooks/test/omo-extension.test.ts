import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { omoPlugin } from '../src/install.js';

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
      email: 'a@x.com', route: 'siwc',
      accounts: [{ name: 'default', access: 'token-a', refresh: 'refresh-a', expires: Date.now() + 86_400_000,
        accountId: 'acct-a', email: 'a@x.com', signedOut: true, route: 'siwc' }],
    },
    anthropic: { type: 'api_key', key: 'untouched' },
  }));
  const env = { ...process.env, HOME: home, OMO_CODING_AGENT_DIR: agentDir, QUOTAHOT_DATA_DIR: data, XDG_DATA_HOME: join(home, 'xdg') };
  const result = await invoke(['run', 'omo', '--no-check'], env, JSON.stringify({
    source: 'omo', provider: 'chatgpt-subscription', error: { message: 'usage limit has been reached' },
  }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).switched, true);
  const changed = JSON.parse(await readFile(auth, 'utf8'));
  assert.equal(changed['chatgpt-subscription'].access, 'token-b');
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
  }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).switched, false);
  assert.equal(await readFile(auth, 'utf8'), original);
  await assert.rejects(lstat(`${auth}.quotahot-bak`));
  await assert.rejects(lstat(join(home, '.codex', 'auth.json')));
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
  pluginModule.default({ on: (name: string, handler: (event: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown> | unknown) => handlers.set(name, handler) });
  const turnEnd = handlers.get('turn_end');
  const settle = handlers.get('agent_before_settle');
  const input = handlers.get('input');
  const response = handlers.get('after_provider_response');
  assert.ok(turnEnd && settle && input && response);
  let reloads = 0;
  const ctx = {
    model: { provider: 'chatgpt-subscription' }, agentDir: join(home, 'agent'),
    modelRegistry: { authStorage: { reload: () => { reloads += 1; return 'loaded'; } } }, hasUI: false,
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
  await turnEnd({ message: { role: 'assistant', provider: 'chatgpt-subscription', stopReason: 'error', errorMessage: 'quota exhausted' } });
  assert.partialDeepStrictEqual(await settle(boundary, ctx), {
    continue: true,
    entries: [{ type: 'custom', customType: 'other-extension' }, { type: 'custom_message', customType: 'quotahot-recovery' }],
  });
  assert.equal(reloads, 1);
  assert.equal(JSON.parse(await readFile(calls, 'utf8')).provider, 'chatgpt-subscription');
  assert.equal(await settle(boundary, ctx), undefined);
  assert.equal(reloads, 1);
  await input({ attribution: 'user' });
  await response({ status: 429 }, ctx);
  await turnEnd({ message: { role: 'assistant', provider: 'chatgpt-subscription', stopReason: 'error', errorMessage: 'HTTP failed' } });
  assert.partialDeepStrictEqual(await settle(boundary, ctx), { continue: true });
  assert.equal(JSON.parse(await readFile(calls, 'utf8')).error.statusCode, 429);
  await input({ attribution: 'user' });
  await turnEnd({ message: { role: 'assistant', provider: 'chatgpt-subscription', stopReason: 'error',
    errorCause: { type: 'usage_limit', scope: 'account' }, errorMessage: 'limit' } });
  assert.partialDeepStrictEqual(await settle(boundary, ctx), { continue: true });
  assert.equal(JSON.parse(await readFile(calls, 'utf8')).error.message, 'quota exhausted');
});
