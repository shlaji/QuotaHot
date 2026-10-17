import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/server/task-store.js';

const input = { description: 'work', model: 'openai/test', directory: tmpdir(), trigger: { type: 'quota' } } as const;

test('rolls back a multi-chunk append and exposes the archive write failure', (t) => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const task = store.create(input, 1000);
  const run = store.claim(task.id, 1001);
  assert.ok(run);
  store.appendOutput(task.id, run.currentRunId, Buffer.from('before'), 'stdout');
  store['db'].exec(`CREATE TRIGGER reject_chunk BEFORE INSERT ON task_log_chunks WHEN NEW.sequence = 2
    BEGIN SELECT RAISE(ABORT, 'archive write failed'); END`);

  assert.throws(() => store.appendOutput(task.id, run.currentRunId, Buffer.alloc(140000, 42), 'stderr'), /archive write failed/);

  assert.equal(store.listRuns(task.id)[0]?.totalBytes, 6);
  assert.equal(store.listRuns(task.id)[0]?.totalChunks, 1);
  assert.equal(Buffer.concat(store.readLogPage(task.id, run.currentRunId)?.chunks.map((chunk) => chunk.data) ?? []).toString(), 'before');
  assert.equal(store.get(task.id)?.status, 'running');
});

test('rolls back task finalization when the round update fails', (t) => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const task = store.create(input, 1000);
  const run = store.claim(task.id, 1001);
  assert.ok(run);
  store['db'].exec(`CREATE TRIGGER reject_finish BEFORE UPDATE ON task_runs
    BEGIN SELECT RAISE(ABORT, 'round update failed'); END`);

  assert.throws(() => store.finishRun(task.id, run.currentRunId,
    { status: 'succeeded', output: 'done', error: '', finishedAt: 1002 }), /round update failed/);

  assert.equal(store.get(task.id)?.status, 'running');
  assert.equal(store.get(task.id)?.output, '');
  assert.equal(store.listRuns(task.id)[0]?.closedAt, null);
});

test('preserves the archive error when SQLite has already rolled back its transaction', (t) => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const task = store.create(input, 1000);
  const run = store.claim(task.id, 1001);
  assert.ok(run);
  store['db'].exec(`CREATE TRIGGER rollback_append BEFORE INSERT ON task_log_chunks
    BEGIN SELECT RAISE(ROLLBACK, 'archive transaction rolled back'); END`);

  assert.throws(() => store.appendOutput(task.id, run.currentRunId, Buffer.from('bytes'), 'stdout'), /archive transaction rolled back/);

  assert.equal(store.listRuns(task.id)[0]?.totalBytes, 0);
  assert.equal(store.get(task.id)?.status, 'running');
});

test('rolls back the claim when creating its execution round fails', (t) => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const task = store.create(input, 1000);
  store['db'].exec(`CREATE TRIGGER reject_run BEFORE INSERT ON task_runs
    BEGIN SELECT RAISE(ABORT, 'round creation failed'); END`);

  assert.throws(() => store.claim(task.id, 1001), /round creation failed/);

  assert.deepEqual(store.get(task.id), task);
  assert.deepEqual(store.listRuns(task.id), []);
});

test('rolls back additive startup migration completely when backfill fails', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'task-log-rollback-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tasks.db');
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, description TEXT, model TEXT, directory TEXT, trigger_type TEXT,
    trigger_at TEXT, status TEXT, created_at TEXT, started_at TEXT, finished_at TEXT,
    output TEXT DEFAULT '', error TEXT DEFAULT '');
    INSERT INTO tasks (id, description, model, directory, trigger_type, status, created_at, output)
    VALUES ('old', 'work', 'openai/test', '/tmp', 'quota', 'succeeded', '2026-10-16T12:00:00.000Z', 'excerpt');
    CREATE TRIGGER reject_migration BEFORE UPDATE ON tasks
    BEGIN SELECT RAISE(ABORT, 'backfill failed'); END`);

  assert.throws(() => new TaskStore(path), /backfill failed/);

  assert.equal(db.prepare('SELECT output FROM tasks').get()?.output, 'excerpt');
  assert.equal(db.prepare('PRAGMA table_info(tasks)').all().some((column) => column.name === 'current_run_id' || column.name === 'session_id'), false);
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name IN ('task_runs','task_log_chunks')").get()?.count, 0);
  db.exec('DROP TRIGGER reject_migration');
  const reopened = new TaskStore(path);
  t.after(() => reopened.close());
  assert.equal(reopened.listRuns('old')[0]?.totalBytes, 7);
});
