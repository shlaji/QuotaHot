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
