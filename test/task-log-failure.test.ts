import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/server/task-store.js';
import { initializeTaskLogSchema } from '../src/server/task-log-schema.js';

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

test('rolls back schema creation completely when a later table cannot be created', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE sentinel (id TEXT);
    CREATE INDEX task_log_chunks ON sentinel(id);`);
  const schema = db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();

  assert.throws(() => initializeTaskLogSchema(db), /already an index named task_log_chunks/);

  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  assert.deepEqual(db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all(), schema);
});
