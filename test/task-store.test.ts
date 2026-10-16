import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/server/task-store.js';
import type { CreateTaskInput } from '../src/shared/tasks.js';

const now = Date.parse('2026-10-16T12:00:00.000Z');
const input: CreateTaskInput = {
  description: 'inspect project', model: 'openai/gpt-test', directory: tmpdir(),
  trigger: { type: 'time', at: now + 1000 },
};

test('preserves pending tasks and fails interrupted work when the store is reopened', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'task-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tasks.db');
  const original = new TaskStore(path);
  const pending = original.create(input, now);
  const running = original.create(input, now);
  original.claim(running.id, now + 1000);
  original.updateOutput(running.id, 'before restart');
  original.close();

  const reopened = new TaskStore(path);
  t.after(() => reopened.close());
  reopened.recoverInterrupted(now + 2000);

  assert.deepEqual(reopened.get(pending.id), pending);
  assert.equal(reopened.get(running.id)?.status, 'failed');
  assert.equal(reopened.get(running.id)?.finishedAt, now + 2000);
  assert.match(reopened.get(running.id)?.error ?? '', /interrupted/i);
  assert.equal(reopened.get(running.id)?.output, 'before restart');
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  assert.deepEqual({ ...db.prepare('SELECT created_at, trigger_at FROM tasks WHERE id = ?').get(pending.id) }, {
    created_at: new Date(now).toISOString(), trigger_at: new Date(now + 1000).toISOString(),
  });
});

test('claims atomically and admits only one running task across connections', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'task-claim-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tasks.db');
  const first = new TaskStore(path);
  const second = new TaskStore(path);
  t.after(() => { first.close(); second.close(); });
  const one = first.create(input, now);
  const two = first.create(input, now);

  assert.equal(first.claim(one.id, now)?.status, 'running');
  assert.equal(second.claim(one.id, now), null);
  assert.equal(second.claim(two.id, now), null);
  assert.equal(first.remove(one.id), false);
});

test('keeps cancellation terminal when a late process result arrives', (t) => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const task = store.create(input, now);
  store.claim(task.id, now);
  store.cancel(task.id, now + 100);

  store.finish(task.id, { status: 'succeeded', output: 'late', error: '' }, now + 200);

  assert.equal(store.get(task.id)?.status, 'cancelled');
  assert.equal(store.get(task.id)?.finishedAt, now + 100);
  assert.equal(store.get(task.id)?.output, 'late');
  assert.equal(store.remove(task.id), true);
});

test('bounds progress and final output without splitting UTF-8 characters', (t) => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const task = store.create(input, now);
  store.claim(task.id, now);
  const output = '\u732b'.repeat(30000);
  const expected = '\u732b'.repeat(Math.floor(65536 / 3));

  store.updateOutput(task.id, output);

  assert.equal(store.get(task.id)?.output, expected);
  store.finish(task.id, { status: 'succeeded', output, error: '' }, now + 100);
  assert.equal(store.get(task.id)?.output, expected);
});

test('migrates a legacy database additively and persists discovered sessions across reopen', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'task-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tasks.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, description TEXT, model TEXT, directory TEXT, trigger_type TEXT,
    trigger_at TEXT, status TEXT, created_at TEXT, started_at TEXT, finished_at TEXT,
    output TEXT DEFAULT '', error TEXT DEFAULT '');
    INSERT INTO tasks (id, description, model, directory, trigger_type, status, created_at)
    VALUES ('legacy', 'old task', 'openai/test', '/tmp', 'quota', 'succeeded', '2026-10-16T12:00:00.000Z');`);
  legacy.close();

  const migrated = new TaskStore(path);
  assert.equal(migrated.get('legacy')?.description, 'old task');
  assert.equal(migrated.get('legacy')?.sessionId, null);
  assert.equal(migrated.claimContinuation('legacy', now), null);
  const task = migrated.create(input, now);
  migrated.claim(task.id, now);
  migrated.setSession(task.id, 'session-root');
  migrated.setSession(task.id, 'unrelated-child');
  migrated.close();
  const reopened = new TaskStore(path);
  t.after(() => reopened.close());
  assert.equal(reopened.get(task.id)?.sessionId, 'session-root');
});

test('claims a successful session once across connections and clears only turn state', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'task-resume-claim-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tasks.db');
  const first = new TaskStore(path);
  const second = new TaskStore(path);
  t.after(() => { first.close(); second.close(); });
  const task = first.create(input, now);
  first.claim(task.id, now);
  first.setSession(task.id, 'root');
  first.finish(task.id, { status: 'succeeded', output: 'old output', error: '' }, now + 1);
  const pending = first.create(input, now);

  const continued = second.claimContinuation(task.id, now + 2);

  assert.deepEqual(continued, { ...task, sessionId: 'root', status: 'running', startedAt: now + 2 });
  assert.equal(first.claimContinuation(task.id, now + 3), null);
  assert.equal(first.claim(pending.id, now + 3), null);
  second.cancel(task.id, now + 4);
  assert.equal(first.claimContinuation(task.id, now + 5), null);
});
