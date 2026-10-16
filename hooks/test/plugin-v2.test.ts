import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { opencodePlugin } from '../src/opencode-plugin.js';

async function fixture(t: TestContext, providerID = 'openai', response = '{"switched":true}') {
  const directory = await mkdtemp(join(tmpdir(), 'quotahot-v2-'));
  const counter = join(directory, 'calls');
  const command = join(directory, 'hook');
  await writeFile(command, `#!/bin/sh\ncat >/dev/null\nprintf x >> ${JSON.stringify(counter)}\nprintf '%s' '${response}'\n`);
  await chmod(command, 0o700);
  const path = join(directory, 'plugin.mjs');
  await writeFile(path, opencodePlugin(command).replaceAll('process.env.QUOTAHOT_DATA_DIR ?? join(homedir(), ".quotahot")', JSON.stringify(directory)));
  const definition = (await import(path)).default;
  const events: object[] = [];
  let wake: (() => void) | undefined;
  let signal: AbortSignal;
  let stopped = false;
  let active = false;
  let lookupGate = Promise.resolve();
  const prompts: object[] = [];
  const requests: object[] = [];
  let messages = [{ id: 'failed', type: 'assistant', model: { providerID }, time: { created: 1 },
    error: { type: 'provider.rate-limit', status: 429, message: 'quota exceeded' } }];
  const cleanup = await definition.setup({
    event: { subscribe: async function* (options: { signal: AbortSignal }) {
      signal = options.signal;
      signal.addEventListener('abort', () => wake?.(), { once: true });
      try {
        while (!signal.aborted) {
          const event = events.shift();
          if (event) yield event;
          else await new Promise<void>((resolve) => { wake = resolve; });
        }
      } finally { stopped = true; }
    } },
    session: {
      context: async (input: object) => { requests.push(input); await lookupGate; return messages; },
      active: async () => active ? { 'v2-session': { type: 'running' } } : {},
      prompt: async (input: object) => { prompts.push(input); return { id: 'prompt' }; },
    },
  });
  t.after(async () => { await cleanup(); await rm(directory, { recursive: true, force: true }); });
  const emit = (type: string, data: object = {}) => {
    events.push({ type, data: { sessionID: 'v2-session', ...data } });
    wake?.();
  };
  return { definition, counter, prompts, requests, cleanup, emit,
    get aborted() { return signal.aborted; }, get stopped() { return stopped; },
    setActive(value: boolean) { active = value; },
    holdLookup() { let release!: () => void; lookupGate = new Promise<void>((resolve) => { release = resolve; }); return release; },
    setMessages(value: typeof messages) { messages = value; },
  };
}

async function until(condition: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('等待 V2 插件处理事件超时');
}

const quota = { error: { type: 'provider.rate-limit', status: 429, message: 'quota exceeded' } };

test('V2 default setup subscribes to data events and resumes a failed idle session once', async (t) => {
  const state = await fixture(t);
  assert.equal(state.definition.id, 'QuotaHot');
  state.emit('session.execution.failed', quota);
  await until(async () => (await readFile(state.counter, 'utf8').catch(() => '')) === 'x');
  state.emit('session.idle');
  await until(() => state.prompts.length === 1);
  assert.deepEqual(state.requests[0], { sessionID: 'v2-session' });
  assert.deepEqual(state.prompts[0], {
    sessionID: 'v2-session',
    text: 'Continue the interrupted task from the existing conversation. Check what is already done before repeating actions.',
  });
  state.emit('session.execution.failed', quota);
  state.emit('session.idle');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(state.prompts.length, 1);
  await state.cleanup();
  assert.equal(state.aborted, true);
  assert.equal(state.stopped, true);
});

test('V2 retry events switch without replaying while OpenCode is retrying', async (t) => {
  const state = await fixture(t);
  state.setActive(true);
  state.emit('session.retry.scheduled', { ...quota, assistantMessageID: 'failed' });
  await until(async () => (await readFile(state.counter, 'utf8').catch(() => '')) === 'x');
  state.emit('session.idle');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(state.prompts.length, 0);
});

for (const provider of ['anthropic', 'unknown']) {
  test(`V2 does not switch ${provider} quota failures`, async (t) => {
    const state = await fixture(t, provider);
    state.emit('session.execution.failed', quota);
    await until(() => state.requests.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await readFile(state.counter, 'utf8').catch(() => ''), '');
  });
}

for (const type of ['session.execution.interrupted', 'session.inbox.enqueued', 'session.execution.succeeded', 'session.model.selected', 'session.deleted']) {
  test(`V2 ${type} cancels automatic recovery`, async (t) => {
    const state = await fixture(t);
    state.emit('session.execution.failed', quota);
    await until(async () => (await readFile(state.counter, 'utf8').catch(() => '')) === 'x');
    state.emit(type);
    state.emit('session.idle');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(state.prompts.length, 0);
  });
}

test('V2 cancellation is consumed while a provider lookup is still pending', async (t) => {
  const state = await fixture(t);
  const release = state.holdLookup();
  state.emit('session.execution.failed', quota);
  await until(() => state.requests.length > 0);
  state.emit('session.inbox.enqueued');
  state.emit('session.idle');
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await readFile(state.counter, 'utf8').catch(() => ''), '');
  assert.equal(state.prompts.length, 0);
});

test('V2 live active status blocks replay after a terminal quota failure', async (t) => {
  const state = await fixture(t);
  state.setActive(true);
  state.emit('session.execution.failed', quota);
  await until(async () => (await readFile(state.counter, 'utf8').catch(() => '')) === 'x');
  state.emit('session.idle');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(state.prompts.length, 0);
});

test('V2 ordinary errors do not launch the hook', async (t) => {
  const state = await fixture(t);
  state.emit('session.execution.failed', { error: { type: 'network', message: 'ECONNRESET' } });
  state.emit('session.idle');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await readFile(state.counter, 'utf8').catch(() => ''), '');
  assert.equal(state.requests.length, 0);
});
