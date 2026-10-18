import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/server/task-store.js';

const now = Date.parse('2026-10-16T12:00:00.000Z');
const input = { description: 'work', model: 'openai/test', directory: tmpdir(), trigger: { type: 'quota' } } as const;

test('creates a fresh schema with validated task dependencies and foreign keys', (t) => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const predecessor = store.create(input, now);

  const dependent = store.create({ ...input, trigger: { type: 'task', taskId: predecessor.id } }, now + 1);

  assert.deepEqual(store.get(dependent.id)?.trigger, { type: 'task', taskId: predecessor.id });
  assert.equal(store.claim(dependent.id, now + 2), null);
  assert.throws(() => store['db'].prepare("UPDATE tasks SET trigger_type = 'invalid' WHERE id = ?").run(predecessor.id), /CHECK constraint failed/);
  assert.throws(() => store['db'].prepare('UPDATE tasks SET trigger_task_id = NULL WHERE id = ?').run(dependent.id), /CHECK constraint failed/);
  assert.throws(() => store['db'].prepare('UPDATE tasks SET trigger_task_id = ? WHERE id = ?').run(dependent.id, dependent.id), /CHECK constraint failed/);
  assert.throws(() => store['db'].prepare('UPDATE tasks SET trigger_task_id = ? WHERE id = ?').run('missing', dependent.id), /FOREIGN KEY constraint failed/);
  assert.throws(() => store['db'].prepare('DELETE FROM tasks WHERE id = ?').run(predecessor.id), /FOREIGN KEY constraint failed/);
  assert.equal(store['db'].prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  assert.deepEqual(store['db'].prepare('PRAGMA foreign_key_check').all(), []);
});

test('retains current-schema tasks, sessions, dependencies, runs and raw archives across reopen', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'task-schema-reopen-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tasks.db');
  const original = new TaskStore(path);
  const task = original.create(input, now);
  const initial = original.claim(task.id, now + 1);
  assert.ok(initial);
  original.setSession(task.id, 'root-session');
  original.setSessionTitle(initial, 'root-session', 'Root title');
  original.appendOutput(task.id, initial.currentRunId, Buffer.alloc(70000, 255), 'stdout');
  original.appendOutput(task.id, initial.currentRunId, Buffer.from([0, 129]), 'stderr');
  original.finishRun(task.id, initial.currentRunId, { status: 'succeeded', output: 'preview', error: '', finishedAt: now + 2 });
  const continuation = original.claimContinuation(task.id, now + 3);
  assert.ok(continuation);
  original.appendOutput(task.id, continuation.currentRunId, Buffer.from('continued'), 'stderr');
  original.finishRun(task.id, continuation.currentRunId, { status: 'failed', output: 'latest preview', error: 'retained error', finishedAt: now + 4 });
  const active = original.create({ ...input, trigger: { type: 'time', at: now + 5 } }, now);
  const activeRun = original.claim(active.id, now + 5);
  assert.ok(activeRun);
  original.appendOutput(active.id, activeRun.currentRunId, Buffer.from('capturing'), 'stdout');
  const dependent = original.create({ ...input, trigger: { type: 'task', taskId: task.id } }, now + 6);
  const originalTasks = original.list();
  const originalRuns = original.listRuns(task.id);
  const activeRuns = original.listRuns(active.id);
  const rows = original['db'].prepare('SELECT rowid, * FROM tasks ORDER BY rowid').all();
  const chunks = original['db'].prepare('SELECT * FROM task_log_chunks ORDER BY run_id, sequence').all();
  original.close();

  const reopened = new TaskStore(path);
  t.after(() => reopened.close());

  assert.deepEqual(reopened.list(), originalTasks);
  assert.deepEqual(reopened.listRuns(task.id), originalRuns);
  assert.deepEqual(reopened.listRuns(active.id), activeRuns);
  assert.deepEqual(reopened.listRuns(dependent.id), []);
  assert.deepEqual(reopened['db'].prepare('SELECT rowid, * FROM tasks ORDER BY rowid').all(), rows);
  assert.deepEqual(reopened['db'].prepare('SELECT * FROM task_log_chunks ORDER BY run_id, sequence').all(), chunks);
  const initialPage = reopened.readLogPage(task.id, initial.currentRunId, { maxBytes: 200000 });
  assert.ok(initialPage);
  assert.deepEqual(initialPage.chunks.map((chunk) => chunk.stream), ['stdout', 'stdout', 'stderr']);
  assert.deepEqual(Buffer.concat(initialPage.chunks.map((chunk) => chunk.data)), Buffer.concat([Buffer.alloc(70000, 255), Buffer.from([0, 129])]));
  assert.ok(reopened.claim(dependent.id, now + 8));
  reopened.appendOutput(active.id, activeRun.currentRunId, Buffer.from(' after reopen'), 'stdout');
  assert.equal(Buffer.concat(reopened.readLogPage(active.id, activeRun.currentRunId)?.chunks.map((chunk) => chunk.data) ?? []).toString(), 'capturing after reopen');
  assert.deepEqual(reopened['db'].prepare('PRAGMA foreign_key_check').all(), []);
});

test('closes interrupted archives as incomplete without deleting committed bytes', (t) => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const task = store.create(input, now);
  const run = store.claim(task.id, now + 1);
  assert.ok(run);
  store.appendOutput(task.id, run.currentRunId, Buffer.from([255, 0, 129]), 'stderr');

  store.recoverInterrupted(now + 2);

  assert.equal(store.get(task.id)?.status, 'failed');
  assert.equal(store.listRuns(task.id)[0]?.archiveState, 'incomplete');
  assert.equal(store.listRuns(task.id)[0]?.closedAt, now + 2);
  assert.deepEqual(Buffer.concat(store.readLogPage(task.id, run.currentRunId)?.chunks.map((chunk) => chunk.data) ?? []), Buffer.from([255, 0, 129]));
  assert.throws(() => store.appendOutput(task.id, run.currentRunId, Buffer.from('late'), 'stdout'), { name: 'TaskRunWriteError' });
});

test('marks preview-only compatibility completion incomplete instead of inventing raw output', (t) => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const task = store.create(input, now);
  store.claim(task.id, now + 1);
  store.updateOutput(task.id, 'preview only');

  store.finish(task.id, { status: 'succeeded', output: 'preview only', error: '' }, now + 2);

  const [run] = store.listRuns(task.id);
  assert.equal(run?.status, 'succeeded');
  assert.equal(run?.archiveState, 'incomplete');
  assert.equal(run?.totalBytes, 0);
  assert.equal(store.get(task.id)?.output, 'preview only');
});
