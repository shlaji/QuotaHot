import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore, type TaskOutcome } from '../src/server/task-store.js';
import { TaskScheduler } from '../src/server/task-scheduler.js';
import { TaskError } from '../src/server/task-error.js';
import type { CreateTaskInput } from '../src/shared/tasks.js';

const input: CreateTaskInput = {
  description: 'original', model: 'openai/test', directory: '/tmp', trigger: { type: 'time', at: 1 },
};
const success: TaskOutcome = { status: 'succeeded', output: 'first turn', error: '' };

test('persists initial discovery and runs queued work alongside continuation and cancellation', async (t) => {
  const store = new TaskStore(':memory:');
  const finished = Promise.withResolvers<TaskOutcome>();
  let turns = 0;
  const scheduler = new TaskScheduler(store, {
    now: () => 2, quota: async () => [],
    run: async (task, signal, options) => {
      turns++;
      assert.equal(task.description, input.description);
      assert.equal(task.model, input.model);
      assert.equal(task.directory, input.directory);
      options.onSession?.('root');
      if (!options.sessionId) return success;
      assert.equal(options.sessionId, 'root');
      assert.equal(options.prompt, 'second turn');
      options.onOutput?.('live second turn');
      signal.addEventListener('abort', () => finished.resolve({ ...success, output: 'cancelled turn output' }));
      return finished.promise;
    },
  });
  t.after(async () => { await scheduler.stop(); store.close(); });
  const task = scheduler.create(input);
  scheduler.tick();
  assert.equal(store.get(task.id)?.sessionId, 'root');
  await scheduler.settled();
  const queued = scheduler.create(input);

  const continued = scheduler.continueTask(task.id, 'second turn');

  assert.equal(continued.status, 'running');
  assert.equal(continued.output, '');
  assert.equal(continued.finishedAt, null);
  assert.equal(store.get(task.id)?.output, 'live second turn');
  assert.throws(() => scheduler.continueTask(task.id, 'duplicate'), (error: unknown) => error instanceof TaskError && error.status === 409);
  scheduler.tick();
  assert.equal(store.get(queued.id)?.status, 'running');
  const cancelled = await scheduler.cancel(task.id);
  await scheduler.settled();
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.output, 'cancelled turn output');
  assert.equal(store.get(queued.id)?.status, 'succeeded');
  assert.equal(turns, 3);
});

test('continues a successful session while an unrelated task is already running', async (t) => {
  const store = new TaskStore(':memory:');
  const finished = Promise.withResolvers<TaskOutcome>();
  const scheduler = new TaskScheduler(store, {
    now: () => 4, quota: async () => [], run: async (_task, signal, options) => {
      if (options.sessionId === 'root') {
        assert.equal(options.prompt, 'follow up');
        return { ...success, output: 'continued' };
      }
      signal.addEventListener('abort', () => finished.resolve(success));
      return finished.promise;
    },
  });
  t.after(async () => { finished.resolve(success); await scheduler.stop(); store.close(); });
  const task = scheduler.create(input);
  store.claim(task.id, 1);
  store.setSession(task.id, 'root');
  store.finish(task.id, success, 2);
  const other = scheduler.create(input);
  scheduler.tick();

  const continued = scheduler.continueTask(task.id, 'follow up');

  assert.equal(continued.status, 'running');
  assert.throws(() => scheduler.continueTask(task.id, 'duplicate'), (error: unknown) => error instanceof TaskError && error.status === 409);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.get(task.id)?.status, 'succeeded');
  assert.equal(store.get(task.id)?.output, 'continued');
  assert.equal(store.get(other.id)?.status, 'running');
  await scheduler.cancel(other.id);
});

test('stores continuation failures using normal execution semantics', async (t) => {
  const store = new TaskStore(':memory:');
  const scheduler = new TaskScheduler(store, {
    quota: async () => [], run: async (_task, _signal, options) => {
      options.onOutput?.('partial follow up');
      throw new Error('session unavailable');
    },
  });
  t.after(async () => { await scheduler.stop(); store.close(); });
  const task = scheduler.create(input);
  store.claim(task.id, 1);
  store.setSession(task.id, 'root');
  store.finish(task.id, success, 2);

  scheduler.continueTask(task.id, 'follow up');
  await scheduler.settled();

  assert.equal(store.get(task.id)?.status, 'failed');
  assert.equal(store.get(task.id)?.output, 'partial follow up');
  assert.equal(store.get(task.id)?.error, 'session unavailable');
  assert.equal(store.get(task.id)?.sessionId, 'root');
});
