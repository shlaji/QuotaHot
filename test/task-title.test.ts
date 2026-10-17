import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskStore } from '../src/server/task-store.js';
import { TaskScheduler } from '../src/server/task-scheduler.js';
import { TaskCard } from '../src/web/components/TaskCard.js';
import { taskRoutes } from '../src/server/task-routes.js';
import type { TaskRunnerOptions } from '../src/server/task-runner.js';

const input = { description: 'Original prompt', model: 'openai/test', directory: '/tmp', trigger: { type: 'time', at: 1 } } as const;
const success = { status: 'succeeded', output: '', error: '' } as const;

test('persists a trimmed root title across reopening without changing the prompt', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'task-title-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tasks.db');
  const store = new TaskStore(path);
  const task = store.create(input, 1);
  assert.equal(task.sessionTitle, null);
  const run = store.claim(task.id, 2);
  assert.ok(run);
  store.setSession(task.id, 'root');
  store.setSessionTitle(run, 'root', '  Release preparation  ');
  store.finishRun(task.id, run.currentRunId, { ...success, finishedAt: 3 });
  store.close();

  const reopened = new TaskStore(path);
  t.after(() => reopened.close());
  assert.equal(reopened.get(task.id)?.sessionTitle, 'Release preparation');
  assert.equal(reopened.listSummaries()[0]?.sessionTitle, 'Release preparation');
  assert.equal(reopened.get(task.id)?.description, input.description);
});

test('migrates a database with current_run_id but no title column idempotently', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'task-title-migrate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tasks.db');
  const original = new TaskStore(path);
  const task = original.create(input, 1);
  original.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('ALTER TABLE tasks DROP COLUMN session_title');
  legacy.close();

  const migrated = new TaskStore(path);
  assert.deepEqual(migrated.get(task.id), task);
  migrated.close();
  const reopened = new TaskStore(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.get(task.id), task);
});

test('guards title callbacks by current run and root session through the scheduler', async (t) => {
  const store = new TaskStore(':memory:');
  const continuation = Promise.withResolvers<typeof success>();
  const callbacks: TaskRunnerOptions[] = [];
  const scheduler = new TaskScheduler(store, {
    now: () => 2, quota: async () => [],
    run: async (task, _signal, options) => {
      assert.equal(task.description, input.description);
      callbacks.push(options);
      options.onSession?.('root');
      options.onSessionTitle?.('root', options.sessionId ? 'New title' : 'Initial title');
      return options.sessionId ? continuation.promise : success;
    },
  });
  t.after(async () => { continuation.resolve(success); await scheduler.stop(); store.close(); });
  const task = scheduler.create(input);
  scheduler.tick();
  await scheduler.settled();
  scheduler.continueTask(task.id, 'Follow-up prompt');

  callbacks[0]?.onSessionTitle?.('root', 'Stale title');
  callbacks[1]?.onSessionTitle?.('child', 'Wrong session title');
  callbacks[1]?.onSessionTitle?.('root', '  ');
  assert.equal(store.get(task.id)?.sessionTitle, 'New title');
  continuation.resolve(success);
  await scheduler.settled();
  callbacks[1]?.onSessionTitle?.('root', 'Closed run title');
  assert.equal(store.get(task.id)?.sessionTitle, 'New title');
  const response = await taskRoutes(scheduler).request('/tasks/summary');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), scheduler.listSummaries());
});

for (const sessionTitle of [null, '', '  ', '  Generated title  ']) {
  test(`task card uses title priority with original prompt accessible: ${JSON.stringify(sessionTitle)}`, (t) => {
    const store = new TaskStore(':memory:');
    t.after(() => store.close());
    const task = { ...store.create(input, 1), sessionTitle, hasOutput: false };
    const html = renderToStaticMarkup(createElement(TaskCard, {
      task, tasks: [task], active: false, busyAction: null, actionError: '',
      onSendMessage: async () => true, onCancel: () => {}, onDelete: () => {},
    }));
    assert.ok(html.includes(`<h3>${sessionTitle?.trim() || input.description}</h3>`));
    if (sessionTitle?.trim()) assert.ok(html.includes(`<dd>${input.description}</dd>`));
  });
}
