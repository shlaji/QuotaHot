import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { TaskStore, type TaskOutcome } from '../src/server/task-store.js';
import { TaskScheduler } from '../src/server/task-scheduler.js';
import type { CreateTaskInput } from '../src/shared/tasks.js';
import type { UsageResult } from '../src/shared/types.js';

const success: TaskOutcome = { status: 'succeeded', output: 'ok', error: '' };
const input: CreateTaskInput = {
  description: 'work', model: 'openai/test', directory: tmpdir(), trigger: { type: 'quota' },
};
function storeFor(t: TestContext): TaskStore {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  return store;
}
const available: UsageResult = {
  accountId: 'a', provider: 'codex', email: '', ok: true, status: 200, error: '', plan: '',
  subscriptionEndsAt: null, userId: '', resetCredits: null, resetCreditsExpiresAt: null,
  orgType: '', quotaAvailable: true, windows: [], endpoint: '', raw: '',
};

test('runs all due time tasks once in parallel without querying quota for time-only queues', async (t) => {
  const store = storeFor(t);
  let now = 1000;
  let calls = 0;
  const gate = Promise.withResolvers<TaskOutcome>();
  const scheduler = new TaskScheduler(store, {
    now: () => now, quota: async () => { throw new Error('must not query'); },
    run: async () => { calls++; return gate.promise; },
  });
  t.after(async () => { gate.resolve(success); await scheduler.stop(); });
  const one = scheduler.create({ ...input, trigger: { type: 'time', at: 2000 } });
  const two = scheduler.create({ ...input, trigger: { type: 'time', at: 2000 } });
  scheduler.tick();
  assert.equal(calls, 0);
  now = 2000;

  scheduler.tick(); scheduler.tick();

  assert.equal(calls, 2);
  assert.equal(store.get(one.id)?.status, 'running');
  assert.equal(store.get(two.id)?.status, 'running');
  gate.resolve(success);
  await scheduler.settled();
  assert.equal(calls, 2);
  assert.equal(store.get(one.id)?.status, 'succeeded');
  assert.equal(store.get(two.id)?.status, 'succeeded');
  scheduler.tick();
  assert.equal(calls, 2);
});

test('does not block due time tasks or overlap quota queries when a quota request is slow', async (t) => {
  const store = storeFor(t);
  let now = 1000;
  let checks = 0;
  const quota = Promise.withResolvers<UsageResult[]>();
  const scheduler = new TaskScheduler(store, {
    now: () => now, quota: () => { checks++; return quota.promise; }, run: async () => success,
  });
  t.after(() => scheduler.stop());
  scheduler.create(input);
  const timed = scheduler.create({ ...input, trigger: { type: 'time', at: 2000 } });
  scheduler.tick();
  now = 2000;

  scheduler.tick(); scheduler.tick();

  assert.equal(store.get(timed.id)?.status, 'running');
  assert.equal(checks, 1);
  quota.resolve([]);
  await scheduler.settled();
  assert.equal(store.get(timed.id)?.status, 'succeeded');
});

test('launches every fresh-quota task while a timed peer remains active', async (t) => {
  const store = new TaskStore(':memory:');
  const finished = Promise.withResolvers<TaskOutcome>();
  const quota = Promise.withResolvers<UsageResult[]>();
  const entered: string[] = [];
  let checks = 0;
  const scheduler = new TaskScheduler(store, {
    now: () => 1000, quota: () => { checks++; return quota.promise; },
    run: (task) => { entered.push(task.description); return finished.promise; },
  });
  t.after(async () => {
    quota.resolve([]); finished.resolve(success);
    await scheduler.stop(); store.close();
  });
  const timed = scheduler.create({ ...input, description: 'timed', trigger: { type: 'time', at: 1 } });
  const tasks = ['quota-one', 'quota-two', 'quota-three'].map((description) => scheduler.create({ ...input, description }));
  scheduler.tick();
  assert.deepEqual(entered, ['timed']);
  quota.resolve([available]);
  await new Promise<void>((resolve) => setImmediate(resolve));

  scheduler.tick(); scheduler.tick();

  assert.deepEqual(entered, ['timed', 'quota-one', 'quota-two', 'quota-three']);
  assert.equal(checks, 1);
  for (const task of [timed, ...tasks]) assert.equal(store.get(task.id)?.status, 'running');
  finished.resolve(success);
  await scheduler.settled();
});

test('retries quota every 60 seconds after failure and accepts any confirmed account', async (t) => {
  const store = storeFor(t);
  let now = 1000;
  let checks = 0;
  const scheduler = new TaskScheduler(store, {
    now: () => now,
    quota: async () => { if (++checks === 1) throw new Error('offline'); return [{ ...available, ok: false }, available]; },
    run: async () => success,
  });
  t.after(() => scheduler.stop());
  const task = scheduler.create(input);
  scheduler.tick();
  await scheduler.settled();
  now += 59999;
  scheduler.tick();
  assert.equal(checks, 1);
  assert.equal(store.get(task.id)?.status, 'pending');
  now++;

  scheduler.tick();
  await scheduler.settled();
  scheduler.tick();
  await scheduler.settled();

  assert.equal(checks, 2);
  assert.equal(store.get(task.id)?.status, 'succeeded');
  now += 60000;
  scheduler.tick();
  assert.equal(checks, 2);
});

test('never uses a quota result older than 60 seconds even when the query finishes late', async (t) => {
  const store = storeFor(t);
  let now = 1000;
  const quota = Promise.withResolvers<UsageResult[]>();
  const scheduler = new TaskScheduler(store, { now: () => now, quota: () => quota.promise, run: async () => success });
  t.after(() => scheduler.stop());
  const task = scheduler.create(input);
  scheduler.tick();
  now += 60001;
  quota.resolve([available]);
  await scheduler.settled();
  assert.equal(store.get(task.id)?.status, 'pending');
});

test('cancellation cannot be overwritten and shutdown awaits execution and quota before closing', async (t) => {
  const store = storeFor(t);
  const finished = Promise.withResolvers<TaskOutcome>();
  const quota = Promise.withResolvers<UsageResult[]>();
  let aborted = false;
  const scheduler = new TaskScheduler(store, {
    now: () => 2000, quota: () => quota.promise,
    run: async (_task, signal) => { signal.addEventListener('abort', () => { aborted = true; }); return finished.promise; },
  });
  const waiting = scheduler.create(input);
  const task = scheduler.create({ ...input, trigger: { type: 'time', at: 1000 } });
  scheduler.tick();
  const cancellation = scheduler.cancel(task.id);
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(aborted, true);

  finished.resolve(success);
  await cancellation;
  assert.equal(stopped, false);
  quota.resolve([available]);
  await stopping;

  assert.equal(store.get(task.id)?.status, 'cancelled');
  assert.equal(store.get(task.id)?.output, 'ok');
  assert.equal(store.get(waiting.id)?.status, 'pending');
  assert.throws(() => scheduler.create(input));
});

test('retains live and late output when success arrives after cancellation', async (t) => {
  const store = storeFor(t);
  const finished = Promise.withResolvers<TaskOutcome>();
  let now = 2000;
  const scheduler = new TaskScheduler(store, {
    now: () => now, quota: async () => [],
    run: async (_task, signal, { onOutput }) => {
      onOutput?.('live');
      signal.addEventListener('abort', () => onOutput?.('live\nstopping'));
      return finished.promise;
    },
  });
  const task = scheduler.create({ ...input, trigger: { type: 'time', at: 1000 } });
  scheduler.tick();
  assert.equal(scheduler.list().tasks[0]?.output, 'live');
  const cancellation = scheduler.cancel(task.id);
  assert.equal(scheduler.list().tasks[0]?.output, 'live\nstopping');
  now = 3000;

  finished.resolve({ ...success, output: 'live\nstopping\nfinal' });
  const cancelled = await cancellation;
  await scheduler.stop();

  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.finishedAt, 2000);
  assert.equal(cancelled.output, 'live\nstopping\nfinal');
  assert.equal(scheduler.list().tasks[0]?.output, cancelled.output);
});
