import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { opencodePlugin } from '../src/install.js';
import { readRecoveryStatus } from '../src/recovery-status.js';

function isolatedPlugin(command: string, directory: string): string {
  return opencodePlugin(command).replaceAll('process.env.QUOTAHOT_DATA_DIR ?? join(homedir(), ".quotahot")', JSON.stringify(directory));
}

test('session.status retry with a confirmed OpenAI quota signal dispatches once', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'quotahot-plugin-events-'));
  const counter = join(directory, 'spawns');
  const command = join(directory, 'quotahot command');
  await writeFile(command, `#!/bin/sh
cat >/dev/null
printf x >> ${JSON.stringify(counter)}
printf '%s' '{"switched":true,"message":"safe"}'
`);
  await chmod(command, 0o700);
  const pluginPath = join(directory, 'plugin.mjs');
  await writeFile(pluginPath, isolatedPlugin(command, directory));
  const { QuotaHot } = await import(pluginPath);
  const plugin = await QuotaHot({
    client: {
      session: {
        messages: async () => ({ data: [
            {
              info: {
                id: 'message-1',
                sessionID: 'session-1',
                role: 'assistant',
                providerID: 'openai',
                modelID: 'gpt-5',
                time: { created: 10 },
              },
            },
           ] }),
      },
    },
  });
  t.after(async () => { await plugin.dispose(); await rm(directory, { recursive: true, force: true }); });

  await plugin.event({
    event: {
      type: 'session.status',
      properties: {
        sessionID: 'session-1',
        status: { type: 'retry', message: 'The usage limit has been reached' },
      },
    },
  });

  assert.equal(await readFile(counter, 'utf8'), 'x');
});

test('OpenCode only checks quota after a limit event', async (t) => {
  const state = await fixture(t, []);
  assert.equal('chat.params' in state.plugin, false);
  assert.equal(typeof state.plugin.event, 'function');
});

async function fixture(t: TestContext, messages: readonly object[], delay = 0, mode = 'success', response = '{"switched":true,"message":"safe"}') {
  const directory = await mkdtemp(join(tmpdir(), 'quotahot-plugin-events-'));
  const counter = join(directory, 'spawns');
  const payloadPath = join(directory, 'payload');
  const command = join(directory, 'quotahot-hook');
  const commandPath = mode === 'spawn-error' ? join(directory, 'missing') : command;
  const commandBody = mode === 'epipe' ? `printf '%s' '{"switched":true,"message":"safe"}'; exec 0>&-; sleep .01` : mode === 'malformed' ? "printf '%s' nope" : mode === 'oversized' ? 'head -c 65537 /dev/zero' : mode === 'nonzero' ? 'exit 2' : mode === 'hung' ? 'sleep 1' : mode === 'stderr' ? `printf '%s' 'Bearer secret-token account@example.com' >&2\nhead -c 131072 /dev/zero >&2\nprintf x >> ${JSON.stringify(counter)}\nprintf '%s' '${response}'` : `${mode === 'delayed' ? 'sleep .05\n' : ''}printf x >> ${JSON.stringify(counter)}
 printf '%s' '${response}'`;
  await writeFile(command, `#!/bin/sh
${mode === 'epipe' ? '' : `cat > ${JSON.stringify(payloadPath)}`}
${commandBody}
`);
  await chmod(command, 0o700);
  const pluginPath = join(directory, 'plugin.mjs');
  const generated = mode === 'hung' ? isolatedPlugin(command, directory).replace('120000', '20').replace('1000', '5') : mode === 'stderr' ? isolatedPlugin(command, directory).replace('120000', '100').replace('1000', '5') : mode === 'late-lookup' ? isolatedPlugin(command, directory).replace('2000', '20') : isolatedPlugin(commandPath, directory);
  await writeFile(pluginPath, generated);
  const { QuotaHot } = await import(pluginPath);
  let lookups = 0;
  const notifications: Array<{ message: string; variant: string }> = [];
  const logs: Array<{ message: string; level: string }> = [];
  const plugin = await QuotaHot({
    client: {
      tui: { showToast: async ({ body }: { body: { message: string; variant: string } }) => { notifications.push(body); } },
      app: { log: ({ body }: { body: { message: string; level: string } }) => {
        logs.push(body);
        if (mode === 'log-throw') throw new Error('synthetic logging failure');
        return Promise.resolve();
      } },
      session: {
        messages: () => {
          lookups += 1;
          if (mode === 'sync-throw') throw new Error('synthetic lookup failure');
          if (mode === 'late-lookup') return new Promise((resolve) => setTimeout(() => resolve(lookups === 1 ? messages : []), 50));
          return delay === 0 ? Promise.resolve(messages) : new Promise(() => {});
        },
      },
    },
  });
  t.after(async () => { await plugin.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { plugin, counter, payloadPath, notifications, logs, get lookups() { return lookups; } };
}

function retry(sessionID: string, message: string) {
  return { event: { type: 'session.status', properties: { sessionID, status: { type: 'retry', message } } } };
}

function assistant(sessionID: string, id: string, providerID: string, created: number) {
  return { event: { type: 'message.updated', properties: { info: { id, sessionID, role: 'assistant', providerID, modelID: 'model', time: { created } } } } };
}

test('retry dispatch is provider-safe and preserves newest metadata ordering', async (t) => {
  const { plugin, counter } = await fixture(t, []);
  await plugin.event(assistant('ordered', 'message', 'openai', 20));
  await plugin.event(assistant('ordered', 'message', 'anthropic', 10));
  await plugin.event(retry('ordered', 'usage_limit_reached'));
  assert.equal(await readFile(counter, 'utf8'), 'x');
});

test('retry skips missing, conflicting, and non-OpenAI providers', async (t) => {
  const { plugin, counter } = await fixture(t, []);
  await plugin.event(retry('missing', 'quota exhausted'));
  await plugin.event(assistant('other', 'message', 'anthropic', 10));
  await plugin.event(retry('other', 'rate_limit_exceeded'));
  await plugin.event(assistant('conflict', 'one', 'openai', 10));
  await plugin.event(assistant('conflict', 'two', 'anthropic', 10));
  await plugin.event(retry('conflict', 'The usage limit has been reached'));
  await assert.rejects(readFile(counter, 'utf8'), { code: 'ENOENT' });
});

test('retry accepts explicit quota phrases and rejects unrelated failures', async (t) => {
  const { plugin, counter } = await fixture(t, []);
  for (const message of ['The usage limit has been reached', 'usage_limit_reached', 'quota_exhausted', 'rate limit exceeded']) {
    await plugin.event(assistant(message, message, 'openai', 1));
    await plugin.event(retry(message, message));
  }
  for (const message of ['busy', 'idle', 'context length exceeded', 'overloaded', 'network error', 'limit reached']) {
    await plugin.event(retry(message, message));
  }
  assert.equal((await readFile(counter, 'utf8')).length, 4);
});

test('session.error requires a quota signal and confirmed OpenAI provider', async (t) => {
  const { plugin, counter } = await fixture(t, []);
  await plugin.event({ event: { type: 'session.error', properties: { sessionID: 'unknown', error: { status: 429 } } } });
  await plugin.event(assistant('openai-error', 'message', 'openai', 1));
  await plugin.event({ event: { type: 'session.error', properties: {
    sessionID: 'openai-error',
    error: {
      statusCode: 500,
      message: 'Internal Server Error',
      responseHeaders: { 'x-ratelimit-limit-requests': '1000' },
      body: 'usage_limit_reached',
    },
  } } });
  await plugin.event({ event: { type: 'session.error', properties: { sessionID: 'openai-error', error: { status: 429 } } } });
  await plugin.event(assistant('anthropic-error', 'message', 'anthropic', 1));
  await plugin.event({ event: { type: 'session.error', properties: { sessionID: 'anthropic-error', error: { status: 429 } } } });
  await plugin.event({ event: { type: 'transport.error', properties: { sessionID: 'openai-error', error: { status: 429 } } } });
  await plugin.event({ event: { type: 'session.deleted', properties: { info: { id: 'deleted' } } } });
  await plugin.event(assistant('deleted', 'message', 'openai', 1));
  await plugin.event(retry('deleted', 'quota_exhausted'));
  assert.equal(await readFile(counter, 'utf8'), 'x');
});

test('lookup timeout is bounded and does not dispatch', async (t) => {
  const started = Date.now();
  const { plugin, counter } = await fixture(t, [], 1);
  await plugin.event(retry('timeout', 'quota_exhausted'));
  assert.ok(Date.now() - started < 3000);
  await assert.rejects(readFile(counter, 'utf8'), { code: 'ENOENT' });
});

test('session cache evicts the least recently used session', async (t) => {
  const fixtureState = await fixture(t, []);
  for (let index = 0; index < 129; index += 1) {
    await fixtureState.plugin.event(assistant(`session-${index}`, `message-${index}`, 'openai', index));
  }
  await fixtureState.plugin.event(retry('session-0', 'quota_exhausted'));
  assert.equal(fixtureState.lookups, 1);
});

test('a deleted session cannot dispatch after an in-flight lookup settles', async (t) => {
  const fixtureState = await fixture(t, [], 1);
  const pending = fixtureState.plugin.event(retry('gone', 'quota_exhausted'));
  await fixtureState.plugin.event({ event: { type: 'session.deleted', properties: { info: { id: 'gone' } } } });
  await pending;
  await assert.rejects(readFile(fixtureState.counter, 'utf8'), { code: 'ENOENT' });
});

test('a deleted session rejects both retry and final-error events', async (t) => {
  const fixtureState = await fixture(t, []);
  await fixtureState.plugin.event({ event: { type: 'session.deleted', properties: { info: { id: 'deleted-final' } } } });
  await fixtureState.plugin.event(retry('deleted-final', 'quota_exhausted'));
  await fixtureState.plugin.event({ event: { type: 'session.error', properties: { sessionID: 'deleted-final' } } });
  await assert.rejects(readFile(fixtureState.counter, 'utf8'), { code: 'ENOENT' });
});

test('twenty retries and a final error share one child, then a later event retries', async (t) => {
  const fixtureState = await fixture(t, []);
  await fixtureState.plugin.event(assistant('burst', 'message', 'openai', 1));
  const events = Array.from({ length: 20 }, () => fixtureState.plugin.event(retry('burst', 'quota_exhausted')));
  events.push(fixtureState.plugin.event({
    event: { type: 'session.error', properties: { sessionID: 'burst', error: { status: 429 } } },
  }));
  await Promise.all(events);
  assert.equal((await readFile(fixtureState.counter, 'utf8')).length, 1);
  await fixtureState.plugin.event(retry('burst', 'quota_exhausted'));
  assert.equal((await readFile(fixtureState.counter, 'utf8')).length, 2);
});

test('spawn, stdio, protocol, exit, and timeout failures settle without success output', async (t) => {
  for (const mode of ['spawn-error', 'epipe', 'malformed', 'oversized', 'nonzero', 'hung']) {
    const fixtureState = await fixture(t, [], 0, mode);
    await fixtureState.plugin.event(assistant(mode, `message-${mode}`, 'openai', 1));
    await fixtureState.plugin.event(retry(mode, 'quota_exhausted'));
    await assert.rejects(readFile(fixtureState.counter, 'utf8'), { code: 'ENOENT' });
  }
});

test('large child stderr is drained without corrupting stdout or echoing diagnostics', async (t) => {
  const state = await fixture(t, [], 0, 'stderr');
  await state.plugin.event(assistant('stderr', 'message-stderr', 'openai', 1));
  await state.plugin.event(retry('stderr', 'quota_exhausted'));
  assert.equal(await readFile(state.counter, 'utf8'), 'x');
  assert.match(JSON.stringify(state.logs), /switched \(hook emitted at least 8192 bytes on stderr\)/);
  assert.doesNotMatch(JSON.stringify({ logs: state.logs, notifications: state.notifications }), /secret-token|account@example\.com/);
});

test('a provider lookup resolving after timeout cannot populate cache or dispatch', async (t) => {
  const message = { info: { id: 'late-message', sessionID: 'late', role: 'assistant', providerID: 'openai', time: { created: 1 } } };
  const fixtureState = await fixture(t, [message], 0, 'late-lookup');
  await fixtureState.plugin.event(retry('late', 'quota_exhausted'));
  await new Promise((resolve) => setTimeout(resolve, 75));
  await fixtureState.plugin.event(retry('late', 'quota_exhausted'));
  await assert.rejects(readFile(fixtureState.counter, 'utf8'), { code: 'ENOENT' });
});

test('recent deleted-session tombstones remain safe after bounded eviction pressure', async (t) => {
  const fixtureState = await fixture(t, []);
  for (let index = 0; index < 1100; index += 1) {
    await fixtureState.plugin.event({ event: { type: 'session.deleted', properties: { info: { id: `deleted-${index}` } } } });
  }
  await fixtureState.plugin.event({
    event: { type: 'session.error', properties: { sessionID: 'deleted-1099', error: { status: 429 } } },
  });
  await fixtureState.plugin.event(retry('deleted-1099', 'quota_exhausted'));
  await assert.rejects(readFile(fixtureState.counter, 'utf8'), { code: 'ENOENT' });
});

test('a synchronous SDK lookup throw fails open without spawning', async (t) => {
  const fixtureState = await fixture(t, [], 0, 'sync-throw');
  await fixtureState.plugin.event(retry('sync-throw', 'quota_exhausted'));
  await assert.rejects(readFile(fixtureState.counter, 'utf8'), { code: 'ENOENT' });
});

test('failed checks notify once across repeated retries without echoing child output', async (t) => {
  const state = await fixture(t, [], 0, 'success', '{"switched":false,"outcome":"check_failed","message":"private-token"}');
  await state.plugin.event(assistant('failure', 'message', 'openai', 1));
  await state.plugin.event(retry('failure', 'The usage limit has been reached'));
  await state.plugin.event(retry('failure', 'The usage limit has been reached'));
  assert.equal(state.notifications.length, 1, JSON.stringify(state.notifications));
  assert.equal(state.notifications[0]?.variant, 'warning');
  assert.doesNotMatch(JSON.stringify(state.notifications), /private-token/);
});

test('a synchronous SDK logging failure cannot reject the hook event', async (t) => {
  const state = await fixture(t, [], 0, 'log-throw');
  await state.plugin.event(assistant('log', 'message', 'openai', 1));
  await assert.doesNotReject(state.plugin.event(retry('log', 'The usage limit has been reached')));
  assert.equal(state.notifications.length, 1);
});

type Plugin = { event(input: { event: object }): Promise<void>; dispose(): Promise<void> };
type Prompt = { path: { id: string }; body: { parts: readonly { type: string; text: string }[] } };
const pollInterval = 30 * 60 * 1000;
const terminal = (sessionID: string) => ({ event: { type: 'session.error', properties: { sessionID, error: { statusCode: 429 } } } });
const idle = (sessionID: string) => ({ event: { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } } });

async function recoveryFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'quotahot-recovery-state-'));
  t.after(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { await rm(directory, { recursive: true, force: true }); return; }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY') {
          await new Promise<void>((resolve) => setImmediate(resolve));
          continue;
        }
        throw error;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  let now = 100;
  const timers = new Map<object, { at: number; callback: () => void }>();
  const payloads: Array<{ source: string; recover?: boolean; provider?: string; event?: { properties: { sessionID: string } } }> = [];
  const children: Array<{ finish(outcome: string, waitUntil?: number): void }> = [];
  const watcherEvents: Array<(event: string, filename: string) => void> = [];
  let stateAccounts: Record<string, { resetAt: number; blockedUntil: number; checkedAt?: number }> = {};
  let readState = async () => JSON.stringify({ accounts: stateAccounts });
  const prompts: Prompt[] = [];
  const histories = new Map<string, object[]>();
  const statuses: Record<string, { type: string }> = {};
  const notifications: string[] = [];
  const sdk = {
    messages: async ({ path }: { path: { id: string } }): Promise<unknown> => ({ data: histories.get(path.id) || [] }),
    status: async (): Promise<unknown> => ({ data: statuses }),
    promptAsync: async (request: Prompt): Promise<unknown> => { prompts.push(request); return { data: undefined }; },
  };
  const source = opencodePlugin('fake-hook').replace(/^import .* from "node:(?:child_process|crypto|fs|fs\/promises|path|os)";\n/gm, '')
    .replace('export const QuotaHot', 'const QuotaHot').replace('export default { id: "QuotaHot", server: QuotaHot };', '({ QuotaHot, settledStatus: () => statusWrites });');
  const { QuotaHot: factory, settledStatus }: { QuotaHot: (input: object) => Promise<Plugin>; settledStatus: () => Promise<void> } = runInNewContext(source, {
    Buffer, console, Date: { now: () => now }, process: { pid: process.pid, env: { QUOTAHOT_DATA_DIR: directory } }, randomUUID,
    homedir: () => '/test', join: (...parts: string[]) => parts.join('/'), dirname: (path: string) => path.slice(0, path.lastIndexOf('/')),
    readFile: (path: string) => path.endsWith('switch-state.json') ? readState() : readFile(path, 'utf8'),
    mkdir, writeFile, rename, unlink,
    watch: (_directory: string, callback: (event: string, filename: string) => void) => {
      watcherEvents.push(callback);
      return { close: () => { const index = watcherEvents.indexOf(callback); if (index >= 0) watcherEvents.splice(index, 1); }, unref() {} };
    },
    setTimeout: (callback: () => void, delay: number) => {
      const timer = { unref() {} }; timers.set(timer, { at: now + delay, callback }); return timer;
    },
    clearTimeout: (timer: object) => timers.delete(timer),
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: Object.assign(new EventEmitter(), { end: (input: string) => payloads.push(JSON.parse(input)) }),
        kill: () => true,
      });
      children.push({ finish: (outcome, waitUntil) => { child.stdout.emit('data', Buffer.from(JSON.stringify({ outcome, waitUntil }))); child.emit('close', 0); } });
      return child;
    },
  });
  const input = { client: { session: sdk, tui: { showToast: async ({ body }: { body: { message: string } }) => { notifications.push(body.message); } } } };
  const plugin = await factory(input);
  t.after(() => plugin.dispose?.());
  const flush = async () => { for (let index = 0; index < 30; index += 1) await Promise.resolve(); };
  const advance = async (duration = pollInterval) => {
    now += duration;
    for (const [timer, task] of [...timers]) if (task.at <= now) { timers.delete(timer); task.callback(); }
    await flush();
  };
  const seed = async (sessionID: string) => {
    const message = assistant(sessionID, `failed-${sessionID}`, 'openai', 10);
    histories.set(sessionID, [
      { info: { id: `user-${sessionID}`, role: 'user', time: { created: 1 } } },
      { info: { ...message.event.properties.info, parentID: `user-${sessionID}`, error: { statusCode: 429 }, time: { created: 10, completed: 20 } } },
    ]);
    await plugin.event(message);
  };
  const fail = async (sessionID: string, outcome = 'no_candidate') => {
    await seed(sessionID);
    const pending = plugin.event(terminal(sessionID)); await flush();
    children.at(-1)?.finish(outcome); await pending;
    await plugin.event(idle(sessionID));
  };
  return { plugin, directory, sdk, histories, statuses, notifications, prompts, payloads, children, timers, advance, flush, seed, fail, settledStatus,
    setAccounts: (accounts: Record<string, { resetAt: number; blockedUntil: number; checkedAt?: number }>) => { stateAccounts = accounts; },
    setReadState: (reader: () => Promise<string>) => { readState = reader; },
    emitState: () => { for (const callback of [...watcherEvents]) callback('rename', 'switch-state.json'); },
    get watchers() { return watcherEvents.length; },
    second: () => factory(input) };
}

async function snapshot(directory: string, matches: (value: Record<string, unknown>) => boolean = () => true): Promise<{ path: string; value: Record<string, unknown> }> {
  const location = join(directory, 'recovery-status');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const files = await readdir(location).catch(() => []);
    const name = files.find((file) => file.endsWith('.json'));
    if (name) {
      const path = join(location, name);
      const value: Record<string, unknown> = JSON.parse(await readFile(path, 'utf8'));
      if (matches(value)) return { path, value };
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('recovery snapshot was not published');
}

test('shared recovery publishes aggregate waiting sessions and real scheduled deadline', async (t) => {
  const state = await recoveryFixture(t);
  await state.fail('one'); await state.fail('two');
  const second = await state.second(); t.after(() => second.dispose());
  const { path, value } = await snapshot(state.directory, (item) => item.queuedCount === 2);
  assert.equal(value.waitingCount, 2);
  assert.equal(value.queuedCount, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(value.sessions)), [
    { sessionID: 'one', phase: 'waiting' }, { sessionID: 'two', phase: 'waiting' },
  ]);
  assert.equal(value.nextCheckAt, 100 + pollInterval);
  assert.equal((await stat(state.directory)).isDirectory(), true);
  assert.equal((await stat(join(state.directory, 'recovery-status'))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(path, 'utf8'), /secret-token|Continue the interrupted task|Bearer/);
});

test('recovery snapshot records check transition, heartbeat, result and removes last waiter', async (t) => {
  const state = await recoveryFixture(t); await state.fail('pending');
  const original = (await snapshot(state.directory)).value.updatedAt;
  await state.advance(60_000);
  assert.equal((await snapshot(state.directory, (item) => item.updatedAt === 60_100)).value.updatedAt, 60_100);
  assert.notEqual(original, 60_100);
  await state.advance(pollInterval - 60_000);
  assert.equal((await snapshot(state.directory, (item) => item.checking === true)).value.checking, true);
  state.children.at(-1)?.finish('no_candidate'); await state.flush();
  await state.settledStatus();
  const after = (await snapshot(state.directory, (item) => item.checking === false && item.lastOutcome === 'no_candidate')).value;
  assert.equal(after.checking, false);
  assert.equal(after.lastOutcome, 'no_candidate');
  assert.equal(after.lastCheckedAt, 100 + pollInterval);
  assert.equal(after.nextCheckAt, 100 + pollInterval * 3);
  await state.plugin.dispose();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await readdir(join(state.directory, 'recovery-status'))).length === 0) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(await readdir(join(state.directory, 'recovery-status')), []);
});

test('disposing one owner retains the other waiting session in its module snapshot', async (t) => {
  const state = await recoveryFixture(t); await state.fail('first');
  const second = await state.second(); t.after(() => second.dispose());
  await state.seed('second');
  const pending = second.event(terminal('second')); await state.flush();
  state.children.at(-1)?.finish('no_candidate'); await pending;
  await snapshot(state.directory, (value) => value.queuedCount === 2);
  await state.plugin.dispose();
  const remaining = (await snapshot(state.directory, (value) => value.waitingCount === 1)).value;
  assert.deepEqual(JSON.parse(JSON.stringify(remaining.sessions)), [{ sessionID: 'second', phase: 'waiting' }]);
});

test('separately loaded generated plugins publish isolated status files without secrets', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'quotahot-status-modules-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previousDir = process.env.QUOTAHOT_DATA_DIR;
  const previousHome = process.env.HOME;
  process.env.QUOTAHOT_DATA_DIR = directory;
  process.env.HOME = directory;
  t.after(() => {
    if (previousDir === undefined) delete process.env.QUOTAHOT_DATA_DIR; else process.env.QUOTAHOT_DATA_DIR = previousDir;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  });
  const command = join(directory, 'hook');
  await writeFile(command, '#!/bin/sh\ncat >/dev/null\nprintf \'%s\' \'{"outcome":"no_candidate","message":"secret-token"}\'\n', { mode: 0o700 });
  const source = opencodePlugin(command);
  const firstPath = join(directory, 'first.mjs'); const secondPath = join(directory, 'second.mjs');
  await writeFile(firstPath, source); await writeFile(secondPath, source);
  const firstModule = await import(firstPath); const secondModule = await import(secondPath);
  const client = { session: { messages: async () => ({ data: [{ info: {
    id: 'failed', role: 'assistant', providerID: 'openai', error: { statusCode: 429 }, time: { created: 10, completed: 20 },
  } }] }) } };
  const first: Plugin = await firstModule.QuotaHot({ client });
  const second: Plugin = await secondModule.QuotaHot({ client });
  t.after(() => first.dispose()); t.after(() => second.dispose());
  await first.event(assistant('left', 'failed', 'openai', 10));
  await second.event(assistant('right', 'failed', 'openai', 10));
  await first.event(terminal('left')); await second.event(terminal('right'));
  const location = join(directory, 'recovery-status');
  for (let index = 0; index < 100; index += 1) {
    if ((await readdir(location).catch(() => [])).filter((file) => file.endsWith('.json')).length === 2) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const files = (await readdir(location)).filter((file) => file.endsWith('.json'));
  assert.equal(files.length, 2);
  const contents = await Promise.all(files.map((file) => readFile(join(location, file), 'utf8')));
  assert.deepEqual(contents.map((text) => (JSON.parse(text) as { sessions: { sessionID: string }[] }).sessions[0]?.sessionID).sort(), ['left', 'right']);
  assert.equal(readRecoveryStatus(directory).totalWaiting, 2);
  assert.doesNotMatch(contents.join(' '), /secret-token|Continue the interrupted task/);
  assert.equal((await stat(location)).mode & 0o777, 0o700);
  for (const file of files) assert.equal((await stat(join(location, file))).mode & 0o777, 0o600);
  await first.dispose();
  for (let index = 0; index < 100; index += 1) {
    if ((await readdir(location)).length === 1) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal((await readdir(location)).length, 1);
});

test('recovery checks at earliest future reset plus one minute even when initial result omits waitUntil', async (t) => {
  const state = await recoveryFixture(t);
  state.setAccounts({ later: { resetAt: 180_100, blockedUntil: 180_100 }, sooner: { resetAt: 120_100, blockedUntil: 120_100 } });
  await state.fail('deadline');
  await state.advance(180_000 - 1);
  assert.equal(state.payloads.length, 1);
  await state.advance(1);
  assert.equal(state.payloads.length, 2);
  state.children.at(-1)?.finish('available'); await state.flush();
  assert.deepEqual(state.prompts.map((prompt) => prompt.path.id), ['deadline']);
});

test('unknown reset at low clock waits for low-frequency backoff instead of a one-minute timer', async (t) => {
  const state = await recoveryFixture(t);
  let releaseRead: (contents: string) => void = () => {};
  state.setReadState(() => new Promise<string>((resolve) => { releaseRead = resolve; }));
  await state.seed('first');
  const first = state.plugin.event(terminal('first')); await state.flush();
  state.children.at(-1)?.finish('no_candidate'); await state.flush();
  await state.seed('second');
  const second = state.plugin.event(terminal('second')); await state.flush();
  state.children.at(-1)?.finish('no_candidate'); await second;
  await state.advance(60_000);
  assert.equal(state.payloads.length, 2);
  releaseRead('{"accounts":{}}'); await first;
});

test('external quota update during a recovery child runs one follow-up check without reacting to its own write', async (t) => {
  const state = await recoveryFixture(t); await state.fail('in-flight');
  await state.advance();
  assert.equal(state.payloads.length, 2);
  state.setAccounts({ external: { resetAt: 240_100, blockedUntil: 240_100 } });
  state.emitState(); await state.flush();
  state.children.at(-1)?.finish('no_candidate'); await state.flush();
  await state.advance(0);
  assert.equal(state.payloads.length, 3);
  state.setAccounts({ external: { resetAt: 240_100, blockedUntil: 240_100, checkedAt: 100 + pollInterval } });
  state.emitState(); await state.flush();
  state.children.at(-1)?.finish('no_candidate'); await state.flush();
  await state.advance(0);
  assert.equal(state.payloads.length, 3);
});

test('external quota update during an earlier state read is not discarded', async (t) => {
  const state = await recoveryFixture(t); await state.fail('read-race');
  let releaseRead: (contents: string) => void = () => {};
  const firstRead = new Promise<string>((resolve) => { releaseRead = resolve; });
  let reads = 0;
  state.setReadState(() => ++reads === 1 ? firstRead : Promise.resolve(JSON.stringify({ accounts: {
    updated: { resetAt: 240_100, blockedUntil: 240_100 },
  } })));
  state.emitState(); await state.flush();
  state.emitState();
  releaseRead('{"accounts":{}}'); await state.flush();
  await state.advance(0);
  assert.equal(state.payloads.length, 2);
  assert.equal(reads, 2);
  state.children.at(-1)?.finish('available'); await state.flush();
});

test('initial no_candidate waitUntil schedules recovery at reset plus one minute', async (t) => {
  const state = await recoveryFixture(t); await state.seed('wait-until');
  const pending = state.plugin.event(terminal('wait-until')); await state.flush();
  state.children.at(-1)?.finish('no_candidate', 120_100); await pending;
  await state.plugin.event(idle('wait-until'));
  await state.advance(180_000 - 1); assert.equal(state.payloads.length, 1);
  await state.advance(1); assert.equal(state.payloads.length, 2);
  state.children.at(-1)?.finish('available'); await state.flush();
  assert.equal(state.prompts.length, 1);
});

test('reset deadline remains scheduled when reset has passed but its buffer has not', async (t) => {
  const state = await recoveryFixture(t);
  state.setAccounts({ candidate: { resetAt: 120_100, blockedUntil: 120_100 } });
  await state.fail('buffer');
  await state.advance(120_001);
  state.setAccounts({ candidate: { resetAt: 120_100, blockedUntil: 120_100 }, changed: { resetAt: 0, blockedUntil: 0 } });
  state.emitState(); await state.flush(); await state.advance(0);
  state.children.at(-1)?.finish('no_candidate'); await state.flush();
  await state.advance(59_998); assert.equal(state.payloads.length, 2);
  await state.advance(1); assert.equal(state.payloads.length, 3);
  state.children.at(-1)?.finish('available'); await state.flush();
});

test('external quota state change wakes shared recovery once and unchanged writes do not loop', async (t) => {
  const state = await recoveryFixture(t); await state.fail('external');
  const second = await state.second(); t.after(() => second.dispose());
  assert.equal(state.watchers, 1);
  state.emitState(); await state.flush();
  assert.equal(state.payloads.length, 1);
  state.setAccounts({ external: { resetAt: 240_100, blockedUntil: 240_100 } });
  state.emitState(); state.emitState(); await state.flush();
  await state.advance(0);
  assert.equal(state.payloads.length, 2);
  state.children.at(-1)?.finish('no_candidate'); await state.flush();
  state.emitState(); await state.flush();
  assert.equal(state.payloads.length, 2);
  await second.dispose(); await state.plugin.dispose();
  assert.equal(state.watchers, 0);
});

test('recovery shares one provider poll and continues each failed idle session only once', async (t) => {
  const state = await recoveryFixture(t);
  await state.fail('one'); await state.fail('two');

  await state.advance(pollInterval - 1);
  assert.equal(state.payloads.length, 2);
  await state.advance(1);
  assert.deepEqual(state.payloads[2], { source: 'opencode', recover: true, provider: 'openai' });
  state.children.at(-1)?.finish('available'); await state.flush();

  assert.deepEqual(state.prompts.map((prompt) => prompt.path.id).sort(), ['one', 'two']);
  assert.equal(state.prompts[0]?.body.parts[0]?.type, 'text');
  await state.plugin.event(terminal('one')); await state.plugin.event(idle('one'));
  await state.advance();
  assert.equal(state.prompts.length, 2);
  assert.equal(state.payloads.length, 3);
});

test('recovery retains candidates across no_candidate and backs off check_failed', async (t) => {
  const state = await recoveryFixture(t); await state.fail('pending');
  await state.advance(); state.children.at(-1)?.finish('no_candidate'); await state.flush();
  await state.advance(); assert.equal(state.payloads.length, 2);
  await state.advance(); state.children.at(-1)?.finish('check_failed'); await state.flush();
  const before = state.payloads.length;
  for (let index = 0; index < 3; index += 1) await state.advance();
  assert.equal(state.payloads.length, before);
  await state.advance(); state.children.at(-1)?.finish('switched'); await state.flush();
  assert.equal(state.prompts.length, 1);
});

test('retry is still running and terminal failure waits for a subsequent idle confirmation', async (t) => {
  const state = await recoveryFixture(t); await state.seed('active');
  const pending = state.plugin.event(retry('active', 'usage_limit_reached')); await state.flush();
  state.children.at(-1)?.finish('no_candidate'); await pending;
  await state.advance(); state.children.at(-1)?.finish('available'); await state.flush();
  assert.equal(state.prompts.length, 0);
  await state.plugin.event(terminal('active'));
  assert.equal(state.prompts.length, 0);
  await state.plugin.event(idle('active'));
  assert.equal(state.prompts.length, 1);
});

test('a recovery poll is independent of another session event child', async (t) => {
  const state = await recoveryFixture(t); await state.fail('waiting'); await state.seed('other');
  const pending = state.plugin.event(retry('other', 'quota_exhausted')); await state.flush();
  await state.advance();
  assert.equal(state.payloads.length, 3);
  assert.equal(state.payloads[2]?.recover, true);
  state.children[2]?.finish('available'); await state.flush();
  assert.deepEqual(state.prompts.map((prompt) => prompt.path.id), ['waiting']);
  state.children[1]?.finish('no_candidate'); await pending;
});

test('different session event children keep distinct outcomes', async (t) => {
  const state = await recoveryFixture(t); await state.seed('left'); await state.seed('right');
  const left = state.plugin.event(terminal('left')); const right = state.plugin.event(terminal('right')); await state.flush();
  assert.equal(state.children.length, 2);
  state.children[0]?.finish('switched'); state.children[1]?.finish('no_candidate'); await Promise.all([left, right]);
  await state.plugin.event(idle('left')); await state.plugin.event(idle('right'));
  assert.deepEqual(state.prompts.map((prompt) => prompt.path.id), ['left']);
});

test('cancellation removes queued recovery on deletion, newer user, abort and disposal', async (t) => {
  for (const kind of ['deleted', 'user', 'abort', 'dispose']) {
    const state = await recoveryFixture(t); await state.fail(kind);
    if (kind === 'dispose') await state.plugin.dispose();
    else await state.plugin.event({ event: kind === 'user'
      ? { type: 'message.updated', properties: { info: { id: 'new-user', sessionID: kind, role: 'user', time: { created: 101 } } } }
      : kind === 'abort' ? { type: 'session.error', properties: { sessionID: kind, error: { name: 'MessageAbortedError' } } }
        : { type: 'session.deleted', properties: { info: { id: kind } } } });
    await state.advance();
    assert.equal(state.payloads.length, 1, kind); assert.equal(state.prompts.length, 0, kind);
  }
});

test('latest messages block continuation after unseen user input, success, abort or a different failure', async (t) => {
  for (const change of ['user', 'success', 'abort', 'failure']) {
    const state = await recoveryFixture(t); await state.fail(change);
    const latest = change === 'user'
      ? { id: 'new-user', role: 'user', time: { created: 200 } }
      : { id: change === 'failure' ? 'different-failure' : `failed-${change}`, role: 'assistant', providerID: 'openai',
        error: change === 'abort' ? { name: 'MessageAbortedError' } : change === 'failure' ? { statusCode: 429 } : undefined,
        time: { created: 10, completed: 200 } };
    state.histories.set(change, [{ info: latest }]);
    await state.advance(); state.children.at(-1)?.finish('available'); await state.flush();
    assert.equal(state.prompts.length, 0, change);
  }
});

test('SDK errors and live busy status never authorize continuation', async (t) => {
  for (const condition of ['messages-error', 'status-error', 'busy', 'retry']) {
    const state = await recoveryFixture(t); await state.fail(condition);
    if (condition === 'messages-error') state.sdk.messages = async () => ({ error: { message: 'secret' }, data: state.histories.get(condition) });
    else if (condition === 'status-error') state.sdk.status = async () => ({ error: { message: 'secret' }, data: {} });
    else state.statuses[condition] = { type: condition };
    await state.advance(); state.children.at(-1)?.finish('available'); await state.flush();
    assert.equal(state.prompts.length, 0, condition);
  }
});

test('cancellation during latest-message lookup prevents an already recovered continuation', async (t) => {
  const state = await recoveryFixture(t); await state.fail('race');
  let resolveLookup: (value: unknown) => void = () => {};
  state.sdk.messages = () => new Promise((resolve) => { resolveLookup = resolve; });
  await state.advance(); state.children.at(-1)?.finish('available'); await state.flush();
  await state.plugin.event({ event: { type: 'session.error', properties: { sessionID: 'race', error: { name: 'MessageAbortedError' } } } });
  resolveLookup({ data: state.histories.get('race') }); await state.flush();
  assert.equal(state.prompts.length, 0);
});

test('a rejected prompt result is not retried and does not expose SDK secrets', async (t) => {
  const state = await recoveryFixture(t); await state.fail('rejected');
  state.sdk.promptAsync = async (request) => { state.prompts.push(request); return { error: { message: 'secret-token' } }; };
  await state.advance(); state.children.at(-1)?.finish('available'); await state.flush();
  await state.plugin.event(terminal('rejected')); await state.plugin.event(idle('rejected')); await state.advance();
  assert.equal(state.prompts.length, 1);
  assert.ok(state.notifications.length > 1);
  assert.doesNotMatch(state.notifications.join(' '), /secret-token/);
});

test('a newer user event cancels the immediate attempt before provider lookup finishes', async (t) => {
  const state = await recoveryFixture(t); await state.seed('initial-race');
  const pending = state.plugin.event(terminal('initial-race'));
  await state.plugin.event({ event: { type: 'message.updated', properties: { info: {
    id: 'new-user', sessionID: 'initial-race', role: 'user', time: { created: 101 },
  } } } });
  await state.flush();
  state.children.at(-1)?.finish('no_candidate'); await pending;
  await state.advance();
  assert.equal(state.payloads.length, 0);
});

test('assistant progress during the final status lookup invalidates continuation', async (t) => {
  const state = await recoveryFixture(t); await state.fail('progress');
  let resolveStatus: (value: unknown) => void = () => {};
  state.sdk.status = () => new Promise((resolve) => { resolveStatus = resolve; });
  await state.advance(); state.children.at(-1)?.finish('available'); await state.flush();
  await state.plugin.event(assistant('progress', 'new-answer', 'openai', 101));
  resolveStatus({ data: {} }); await state.flush();
  assert.equal(state.prompts.length, 0);
});

test('recovery waiting queue is bounded and evicted sessions cannot resume', async (t) => {
  const state = await recoveryFixture(t);
  for (let index = 0; index < 129; index += 1) await state.fail(`bounded-${index}`);
  await state.advance(); state.children.at(-1)?.finish('available'); await state.flush();
  assert.equal(state.prompts.length, 128);
  assert.equal(state.prompts.some((prompt) => prompt.path.id === 'bounded-0'), false);
});

test('plugin instances share polling while disposal cancels only the owning sessions', async (t) => {
  const state = await recoveryFixture(t); await state.fail('first');
  const second = await state.second(); t.after(() => second.dispose());
  await state.seed('second');
  const pending = second.event(terminal('second')); await state.flush();
  state.children.at(-1)?.finish('no_candidate'); await pending; await second.event(idle('second'));
  await state.plugin.dispose();
  await state.advance(); state.children.at(-1)?.finish('available'); await state.flush();
  assert.equal(state.payloads.length, 3);
  assert.deepEqual(state.prompts.map((prompt) => prompt.path.id), ['second']);
});

test('a successful assistant completion or unrelated terminal error cancels recovery', async (t) => {
  for (const reason of ['success', 'network']) {
    const state = await recoveryFixture(t); await state.fail(reason);
    await state.plugin.event({ event: reason === 'success' ? { type: 'message.updated', properties: { info: {
      id: `failed-${reason}`, sessionID: reason, role: 'assistant', providerID: 'openai', time: { created: 10, completed: 200 },
    } } } : { type: 'session.error', properties: { sessionID: reason, error: { message: 'network failed' } } } });
    await state.advance();
    assert.equal(state.payloads.length, 1, reason);
  }
});

test('completed failure IDs retain recent dedupe while evicting the oldest bounded entries', async (t) => {
  const state = await recoveryFixture(t);
  for (let index = 0; index < 1025; index += 1) await state.fail(`done-${index}`, 'available');
  await state.plugin.event(terminal('done-1024')); await state.plugin.event(idle('done-1024'));
  assert.equal(state.prompts.length, 1025);
  await state.fail('done-0', 'available');
  assert.equal(state.prompts.length, 1026);
});

test('disposal and a new user during a recovery child prevent continuation when it exits', async (t) => {
  for (const action of ['dispose', 'user']) {
    const state = await recoveryFixture(t); await state.fail(action); await state.advance();
    if (action === 'dispose') await state.plugin.dispose();
    else await state.plugin.event({ event: { type: 'message.updated', properties: { info: {
      id: 'new-user', sessionID: action, role: 'user', time: { created: pollInterval },
    } } } });
    state.children.at(-1)?.finish('available'); await state.flush(); await state.advance();
    assert.equal(state.prompts.length, 0); assert.equal(state.payloads.length, 2);
  }
});

test('an old user update does not cancel the failed request recovery', async (t) => {
  const state = await recoveryFixture(t); await state.fail('old-user');
  await state.plugin.event({ event: { type: 'message.updated', properties: { info: {
    id: 'user-old-user', sessionID: 'old-user', role: 'user', time: { created: 1 },
  } } } });
  await state.advance(); state.children.at(-1)?.finish('available'); await state.flush();
  assert.equal(state.prompts.length, 1);
});

test('generated ESM plugin recovers through a real child and sends one SDK continuation', { timeout: 5000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'quotahot-recovery-esm-'));
  t.after(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { await rm(directory, { recursive: true, force: true }); return; }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY') {
          await new Promise<void>((resolve) => setImmediate(resolve));
          continue;
        }
        throw error;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const previous = process.env.QUOTAHOT_DATA_DIR;
  process.env.QUOTAHOT_DATA_DIR = directory;
  t.after(() => { if (previous === undefined) delete process.env.QUOTAHOT_DATA_DIR; else process.env.QUOTAHOT_DATA_DIR = previous; });
  const child = join(directory, 'hook with spaces');
  await writeFile(child, `#!/bin/sh
body=$(cat)
case "$body" in
  *'"recover":true'*) printf '%s' '{"outcome":"available"}' ;;
  *) printf '%s' '{"outcome":"no_candidate"}' ;;
esac
`, { mode: 0o700 });
  const pluginPath = join(directory, 'plugin.mjs'); await writeFile(pluginPath, opencodePlugin(child));
  const { QuotaHot } = await import(pluginPath);
  const prompts: Prompt[] = [];
  let resolvePrompt: () => void = () => {};
  const continued = new Promise<void>((resolve) => { resolvePrompt = resolve; });
  const plugin = await QuotaHot({ client: { session: {
    messages: async () => ({ data: [{ info: { id: 'failed', sessionID: 'real', role: 'assistant', providerID: 'openai',
      error: { statusCode: 429 }, time: { created: 10, completed: 20 } } }] }),
    status: async () => ({ data: {} }),
    promptAsync: async (request: Prompt) => { prompts.push(request); resolvePrompt(); return { data: undefined }; },
  } } });
  t.after(() => plugin.dispose());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await plugin.event(assistant('real', 'failed', 'openai', 10));
  await plugin.event(terminal('real')); await plugin.event(idle('real'));

  t.mock.timers.tick(pollInterval); await continued;

  assert.deepEqual(prompts.map((prompt) => prompt.path.id), ['real']);
  await plugin.event(idle('real')); assert.equal(prompts.length, 1);
});

test('generated ESM plugin observes an atomic external quota state rename', { timeout: 5000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'quotahot-recovery-watch-'));
  t.after(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { await rm(directory, { recursive: true, force: true }); return; }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY') {
          await new Promise<void>((resolve) => setImmediate(resolve));
          continue;
        }
        throw error;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const previous = process.env.QUOTAHOT_DATA_DIR;
  process.env.QUOTAHOT_DATA_DIR = directory;
  t.after(() => { if (previous === undefined) delete process.env.QUOTAHOT_DATA_DIR; else process.env.QUOTAHOT_DATA_DIR = previous; });
  const command = join(directory, 'hook');
  await writeFile(command, `#!/bin/sh
case "$(cat)" in
  *'"recover":true'*) printf '%s' '{"outcome":"available"}' ;;
  *) printf '%s' '{"outcome":"no_candidate"}' ;;
esac
`, { mode: 0o700 });
  const pluginPath = join(directory, 'plugin.mjs'); await writeFile(pluginPath, opencodePlugin(command));
  const { QuotaHot } = await import(pluginPath);
  let resolvePrompt: () => void = () => {};
  const continued = new Promise<void>((resolve) => { resolvePrompt = resolve; });
  const plugin = await QuotaHot({ client: { session: {
    messages: async () => ({ data: [{ info: { id: 'failed', sessionID: 'atomic', role: 'assistant', providerID: 'openai',
      error: { statusCode: 429 }, time: { created: 10, completed: 20 } } }] }),
    status: async () => ({ data: {} }),
    promptAsync: async () => { resolvePrompt(); return { data: undefined }; },
  } } });
  t.after(() => plugin.dispose());
  await plugin.event(assistant('atomic', 'failed', 'openai', 10));
  await plugin.event(terminal('atomic')); await plugin.event(idle('atomic'));
  await writeFile(join(directory, 'switch-state.json.tmp'), JSON.stringify({ accounts: { external: {
    usedPercent: 100, resetAt: Date.now() + 120_000, blockedUntil: Date.now() + 120_000,
  } } }));
  await rename(join(directory, 'switch-state.json.tmp'), join(directory, 'switch-state.json'));
  await continued;
});
