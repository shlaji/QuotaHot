import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opencodePlugin } from '../src/install.js';

test('session.status retry with a confirmed OpenAI quota signal dispatches once', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'quotahot-plugin-events-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const counter = join(directory, 'spawns');
  const command = join(directory, 'quotahot command');
  await writeFile(command, `#!/bin/sh
cat >/dev/null
printf x >> ${JSON.stringify(counter)}
printf '%s' '{"switched":true,"message":"safe"}'
`);
  await chmod(command, 0o700);
  const pluginPath = join(directory, 'plugin.mjs');
  await writeFile(pluginPath, opencodePlugin(command));
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

async function fixture(t: TestContext, messages: readonly object[], delay = 0, mode = 'success', response = '{"switched":true,"message":"safe"}') {
  const directory = await mkdtemp(join(tmpdir(), 'quotahot-plugin-events-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const counter = join(directory, 'spawns');
  const command = join(directory, 'quotahot-hook');
  const commandPath = mode === 'spawn-error' ? join(directory, 'missing') : command;
  const commandBody = mode === 'epipe' ? `printf '%s' '{"switched":true,"message":"safe"}'; exec 0>&-; sleep .01` : mode === 'malformed' ? "printf '%s' nope" : mode === 'oversized' ? 'head -c 65537 /dev/zero' : mode === 'nonzero' ? 'exit 2' : mode === 'hung' ? 'sleep 1' : mode === 'stderr' ? `printf '%s' 'Bearer secret-token account@example.com' >&2\nhead -c 131072 /dev/zero >&2\nprintf x >> ${JSON.stringify(counter)}\nprintf '%s' '${response}'` : `printf x >> ${JSON.stringify(counter)}
printf '%s' '${response}'`;
  await writeFile(command, `#!/bin/sh
${mode === 'epipe' ? '' : 'cat >/dev/null'}
${commandBody}
`);
  await chmod(command, 0o700);
  const pluginPath = join(directory, 'plugin.mjs');
  const generated = mode === 'hung' ? opencodePlugin(command).replace('120000', '20').replace('1000', '5') : mode === 'stderr' ? opencodePlugin(command).replace('120000', '100').replace('1000', '5') : mode === 'late-lookup' ? opencodePlugin(command).replace('2000', '20') : opencodePlugin(commandPath);
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
  return { plugin, counter, notifications, logs, get lookups() { return lookups; } };
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
