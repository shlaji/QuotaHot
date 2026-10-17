import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore, type TaskOutcome } from '../src/server/task-store.js';
import { TaskScheduler } from '../src/server/task-scheduler.js';
import { TaskError } from '../src/server/task-error.js';
import type { CreateTaskInput } from '../src/shared/tasks.js';
import type { UsageResult } from '../src/shared/types.js';

const input: CreateTaskInput = {
  description: 'work', model: 'openai/test', directory: '/tmp', trigger: { type: 'time', at: 1 },
};
const success: TaskOutcome = { status: 'succeeded', output: 'done', error: '' };
const conflict = (error: unknown) => error instanceof TaskError && error.status === 409;

test('repeated cancellation drains only its task and blocks deletion until cleanup finishes', async (t) => {
  const store = new TaskStore(':memory:');
  const finished = Promise.withResolvers<TaskOutcome>();
  const peerFinished = Promise.withResolvers<TaskOutcome>();
  const aborted: string[] = [];
  let now = 2;
  const scheduler = new TaskScheduler(store, {
    now: () => now, quota: async () => [],
    run: async (task, signal, { onOutput }) => {
      onOutput?.(`${task.description} live`);
      signal.addEventListener('abort', () => {
        aborted.push(task.description);
        onOutput?.(`${task.description} stopping`);
      });
      if (task.description === 'cancel') return finished.promise;
      if (task.description === 'peer') return peerFinished.promise;
      return success;
    },
  });
  t.after(async () => {
    finished.resolve(success); peerFinished.resolve(success);
    await scheduler.stop(); store.close();
  });
  const task = scheduler.create({ ...input, description: 'cancel' });
  const peer = scheduler.create({ ...input, description: 'peer' });
  scheduler.tick();
  let cancellations = 0;

  const first = scheduler.cancel(task.id).then((result) => { cancellations++; return result; });
  now = 3;
  const repeated = scheduler.cancel(task.id).then((result) => { cancellations++; return result; });

  await Promise.resolve();
  assert.equal(cancellations, 0);
  assert.deepEqual(aborted, ['cancel']);
  assert.throws(() => scheduler.remove(task.id), conflict);
  assert.equal(store.get(peer.id)?.status, 'running');
  assert.equal(store.get(peer.id)?.output, 'peer live');
  finished.resolve({ ...success, output: 'cancel final' });
  const results = await Promise.all([first, repeated]);
  for (const result of results) {
    assert.equal(result.status, 'cancelled');
    assert.equal(result.finishedAt, 2);
    assert.equal(result.output, 'cancel final');
  }
  scheduler.remove(task.id);
  const later = scheduler.create(input);
  scheduler.tick();
  assert.equal(store.get(later.id)?.status, 'running');
  const peerCancellation = scheduler.cancel(peer.id);
  assert.deepEqual(aborted, ['cancel', 'peer']);
  peerFinished.resolve(success);
  await peerCancellation;
  await scheduler.settled();
  assert.equal(store.get(later.id)?.status, 'succeeded');
});

test('settled waits for every active task when the last launched task finishes first', async (t) => {
  const store = new TaskStore(':memory:');
  const first = Promise.withResolvers<TaskOutcome>();
  const last = Promise.withResolvers<TaskOutcome>();
  const scheduler = new TaskScheduler(store, {
    now: () => 2, quota: async () => [],
    run: (task) => task.description === 'first' ? first.promise : last.promise,
  });
  t.after(async () => {
    first.resolve(success); last.resolve(success);
    await scheduler.stop(); store.close();
  });
  const one = scheduler.create({ ...input, description: 'first' });
  const two = scheduler.create({ ...input, description: 'last' });
  scheduler.tick();
  let settled = false;

  const settling = scheduler.settled().then(() => { settled = true; });
  last.resolve(success);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.get(two.id)?.status, 'succeeded');
  assert.equal(store.get(one.id)?.status, 'running');
  assert.equal(settled, false);
  first.resolve(success);
  await settling;
  assert.equal(store.get(one.id)?.status, 'succeeded');
});

test('stop closes admission, aborts every task, and drains all executions and quota work', async (t) => {
  const store = new TaskStore(':memory:');
  const first = Promise.withResolvers<TaskOutcome>();
  const last = Promise.withResolvers<TaskOutcome>();
  const quota = Promise.withResolvers<UsageResult[]>();
  const aborted: string[] = [];
  const scheduler = new TaskScheduler(store, {
    now: () => 2, quota: () => quota.promise,
    run: (task, signal) => {
      signal.addEventListener('abort', () => aborted.push(task.description));
      return task.description === 'first' ? first.promise : last.promise;
    },
  });
  t.after(async () => {
    first.resolve(success); last.resolve(success); quota.resolve([]);
    await scheduler.stop(); store.close();
  });
  const waiting = scheduler.create({ ...input, trigger: { type: 'quota' } });
  const resumable = scheduler.create(input);
  store.claim(resumable.id, 1);
  store.setSession(resumable.id, 'root');
  store.finish(resumable.id, success, 1);
  const one = scheduler.create({ ...input, description: 'first' });
  const two = scheduler.create({ ...input, description: 'last' });
  scheduler.tick();
  let stopped = false;

  const stopping = scheduler.stop().then(() => { stopped = true; });
  const repeated = scheduler.stop();

  assert.deepEqual(aborted, ['first', 'last']);
  assert.throws(() => scheduler.create(input), (error: unknown) => error instanceof TaskError && error.status === 503);
  assert.throws(() => scheduler.continueTask(resumable.id, 'follow up'), conflict);
  last.resolve({ ...success, output: 'last final' });
  quota.resolve([]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.get(two.id)?.output, 'last final');
  assert.equal(stopped, false);
  first.resolve({ status: 'failed', output: 'first final', error: 'aborted' });
  await Promise.all([stopping, repeated]);
  scheduler.tick();
  assert.equal(store.get(one.id)?.output, 'first final');
  assert.equal(store.get(waiting.id)?.status, 'pending');
});
