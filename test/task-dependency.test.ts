import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { TaskStore, type TaskOutcome } from '../src/server/task-store.js';
import { TaskScheduler } from '../src/server/task-scheduler.js';
import { parseTaskInput } from '../src/server/task-input.js';
import { taskRoutes } from '../src/server/task-routes.js';
import { serve } from '@hono/node-server';
import { once } from 'node:events';

const input = { description: 'work', model: 'openai/test', directory: tmpdir(), trigger: { type: 'time', at: 2000 } } as const;
const success: TaskOutcome = { status: 'succeeded', output: 'ok', error: '' };

for (const outcome of ['succeeded', 'failed', 'cancelled', 'recovered'] as const) {
  for (const createdAfter of [false, true]) {
    test(`runs dependency once when predecessor is ${outcome}, createdAfter=${createdAfter}`, async (t) => {
      const store = new TaskStore(':memory:');
      let calls = 0;
      let checks = 0;
      const scheduler = new TaskScheduler(store, {
        now: () => 1000, quota: async () => { checks++; return []; },
        run: async () => { calls++; return success; },
      });
      t.after(async () => { await scheduler.stop(); store.close(); });
      const predecessor = scheduler.create(input);
      const dependentInput = { ...input, trigger: { type: 'task', taskId: predecessor.id } } as const;
      const waiting = createdAfter ? null : scheduler.create(dependentInput);
      scheduler.tick();
      assert.equal(calls, 0);
      if (waiting) assert.equal(store.claim(waiting.id, 1000), null);
      store.claim(predecessor.id, 1000);
      scheduler.tick();
      assert.equal(calls, 0);
      switch (outcome) {
        case 'succeeded': case 'failed': store.finish(predecessor.id, { ...success, status: outcome }, 1001); break;
        case 'cancelled': await scheduler.cancel(predecessor.id); break;
        case 'recovered': store.recoverInterrupted(1001); break;
      }
      const dependent = waiting ?? scheduler.create(dependentInput);

      scheduler.tick();
      scheduler.tick();
      await scheduler.settled();
      scheduler.tick();

      assert.equal(calls, 1);
      assert.equal(checks, 0);
      assert.equal(store.get(dependent.id)?.status, 'succeeded');
      assert.equal(store.claim(dependent.id, 1002), null);
    });
  }
}

test('retains dependency eligibility when a completed predecessor continues before claim', async (t) => {
  const store = new TaskStore(':memory:');
  const scheduler = new TaskScheduler(store, { now: () => 1000, quota: async () => [], run: async () => success });
  t.after(async () => { await scheduler.stop(); store.close(); });
  const predecessor = scheduler.create(input);
  const dependent = scheduler.create({ ...input, trigger: { type: 'task', taskId: predecessor.id } });
  store.claim(predecessor.id, 1000);
  store.setSession(predecessor.id, 'session');
  store.finish(predecessor.id, success, 1001);
  assert.ok(store.claimContinuation(predecessor.id, 1002));

  scheduler.tick();
  await scheduler.settled();

  assert.equal(store.get(dependent.id)?.status, 'succeeded');
  assert.equal(store.get(predecessor.id)?.status, 'running');
});

test('releases a dependency when its pending predecessor is cancelled', async (t) => {
  const store = new TaskStore(':memory:');
  const scheduler = new TaskScheduler(store, { now: () => 1000, quota: async () => [], run: async () => success });
  t.after(async () => { await scheduler.stop(); store.close(); });
  const predecessor = scheduler.create(input);
  const dependent = scheduler.create({ ...input, trigger: { type: 'task', taskId: predecessor.id } });

  await scheduler.cancel(predecessor.id);
  scheduler.tick();
  await scheduler.settled();

  assert.equal(store.get(dependent.id)?.status, 'succeeded');
});

test('parses task dependencies without accepting malformed or mixed trigger fields', async () => {
  const trigger = { type: 'task', taskId: 'predecessor' };
  assert.deepEqual((await parseTaskInput({ ...input, trigger }, 1000)).trigger, trigger);
  for (const malformed of [
    { type: 'task' }, { type: 'task', taskId: null }, { type: 'task', taskId: 1 },
    { type: 'task', taskId: '' }, { type: 'task', taskId: ' ' }, { type: 'task', taskId: 'a\0b' },
    { ...trigger, at: 2000 }, { ...trigger, extra: true }, { type: 'quota', taskId: 'other' },
    { type: 'time', at: 2000, taskId: 'other' },
  ]) {
    await assert.rejects(parseTaskInput({ ...input, trigger: malformed }, 1000), { status: 400 });
  }
});

test('creates dependencies and protects predecessors through live HTTP', async (t) => {
  const store = new TaskStore(':memory:');
  const scheduler = new TaskScheduler(store, { now: () => 1000, quota: async () => [], run: async () => success });
  t.after(async () => { await scheduler.stop(); store.close(); });
  const predecessor = scheduler.create(input);
  const app = taskRoutes(scheduler, () => 1000);
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/tasks`;
  const trigger = { type: 'task', taskId: predecessor.id };

  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, trigger }) });

  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).trigger, trigger);
  assert.equal((await fetch(`${url}/${predecessor.id}`, { method: 'DELETE' })).status, 409);
  const missing = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, trigger: { type: 'task', taskId: 'missing' } }) });
  assert.equal(missing.status, 400);
  const self = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, id: 'self', trigger: { type: 'task', taskId: 'self' } }) });
  assert.equal(self.status, 400);
});

test('releases dependents on startup recovery of an interrupted predecessor', async (t) => {
  const store = new TaskStore(':memory:');
  const predecessor = store.create(input, 1000);
  const dependent = store.create({ ...input, trigger: { type: 'task', taskId: predecessor.id } }, 1000);
  store.claim(predecessor.id, 1000);
  const scheduler = new TaskScheduler(store, { now: () => 1001, quota: async () => [], run: async () => success });
  t.after(async () => { await scheduler.stop(); store.close(); });

  scheduler.tick();
  await scheduler.settled();

  assert.equal(store.get(predecessor.id)?.status, 'failed');
  assert.equal(store.get(dependent.id)?.status, 'succeeded');
});
