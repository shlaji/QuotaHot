import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/server/task-store.js';

const now = Date.parse('2026-10-16T12:00:00.000Z');
const input = { description: 'work', model: 'openai/test', directory: tmpdir(), trigger: { type: 'quota' } } as const;

test('migrates legacy excerpts as unknown archives once without modifying existing rows', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'task-log-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tasks.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, description TEXT, model TEXT, directory TEXT, trigger_type TEXT,
    trigger_at TEXT, status TEXT, created_at TEXT, started_at TEXT, finished_at TEXT,
    output TEXT DEFAULT '', error TEXT DEFAULT '');`);
  const excerpt = 'x'.repeat(70000) + '\n[... output omitted ...]\n' + '\0猫';
  legacy.prepare(`INSERT INTO tasks VALUES ('legacy', 'old task', 'openai/test', '/tmp', 'quota',
    NULL, 'succeeded', ?, ?, ?, ?, 'original error')`).run(
    new Date(now).toISOString(), new Date(now + 1).toISOString(), new Date(now + 2).toISOString(), excerpt);
  legacy.exec(`INSERT INTO tasks (id, description, model, directory, trigger_type, status, created_at)
    VALUES ('pending', 'waiting', 'openai/test', '/tmp', 'quota', 'pending', '2026-10-16T12:00:00.000Z')`);
  const original = legacy.prepare('SELECT * FROM tasks ORDER BY id').all();
  legacy.close();
  const first = new TaskStore(path);
  const originalRuns = first.listRuns('legacy');
  const newPending = first.create(input, now);
  first.close();

  const reopened = new TaskStore(path);
  t.after(() => reopened.close());

  assert.deepEqual(reopened.listRuns('legacy'), originalRuns);
  const [run] = originalRuns;
  assert.ok(run);
  assert.equal(run.kind, 'legacy_unknown');
  assert.equal(run.archiveState, 'legacy_unknown');
  assert.equal(run.totalBytes, Buffer.byteLength(excerpt));
  assert.equal(run.ordinal, 1);
  assert.equal(run.startedAt, now + 1);
  assert.equal(run.finishedAt, now + 2);
  const page = reopened.readLogPage('legacy', run.id, { maxBytes: 200000 });
  assert.ok(page);
  assert.deepEqual(page.chunks.map((chunk) => chunk.stream), ['legacy', 'legacy']);
  assert.equal(Buffer.concat(page.chunks.map((chunk) => chunk.data)).toString(), excerpt);
  assert.deepEqual(reopened.listRuns('pending'), []);
  assert.deepEqual(reopened.listRuns(newPending.id), []);
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  assert.deepEqual(db.prepare(`SELECT id, description, model, directory, trigger_type, trigger_at,
    status, created_at, started_at, finished_at, output, error FROM tasks WHERE id IN ('legacy','pending') ORDER BY id`).all(), original);
  const claimedPending = reopened.claim('pending', now + 3);
  assert.ok(claimedPending);
  assert.equal(reopened.listRuns('pending')[0]?.kind, 'initial');
  assert.equal(reopened.listRuns('pending')[0]?.ordinal, 1);
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
