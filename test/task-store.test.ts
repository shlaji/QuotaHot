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
  const execution = original.claim(running.id, now + 1000);
  assert.ok(execution);
  original.updatePreview(running.id, execution.currentRunId, 'before restart');
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

test('claims distinct tasks across connections while rejecting duplicate claims per task', (t) => {
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
  assert.equal(second.claim(two.id, now)?.status, 'running');
  assert.equal(first.claim(two.id, now), null);
  assert.equal(first.remove(one.id), false);
  assert.equal(second.remove(two.id), false);
});

test('keeps cancellation terminal when a late process result arrives', (t) => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const task = store.create(input, now);
  const execution = store.claim(task.id, now);
  assert.ok(execution);
  store.cancel(task.id, now + 100);

  store.finishRun(task.id, execution.currentRunId, { status: 'succeeded', output: 'late', error: '', finishedAt: now + 200 });

  assert.equal(store.get(task.id)?.status, 'cancelled');
  assert.equal(store.get(task.id)?.finishedAt, now + 100);
  assert.equal(store.get(task.id)?.output, 'late');
  assert.equal(store.remove(task.id), true);
});

test('bounds progress and final output without splitting UTF-8 characters', (t) => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const task = store.create(input, now);
  const execution = store.claim(task.id, now);
  assert.ok(execution);
  const output = '\u732b'.repeat(30000);

  store.updatePreview(task.id, execution.currentRunId, output);

  const retained = store.get(task.id)?.output ?? '';
  assert.ok(retained.startsWith('猫'));
  assert.ok(retained.endsWith('猫'));
  assert.match(retained, /output omitted/);
  assert.ok(Buffer.byteLength(retained) <= 65536);
  assert.ok(!retained.includes('\ufffd'));
  store.finishRun(task.id, execution.currentRunId, { status: 'succeeded', output, error: '', finishedAt: now + 100 });
  assert.equal(store.get(task.id)?.output, retained);
});

test('lists metadata without output and fetches output for only the requested task', (t) => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const pending = store.create(input, now);
  const running = store.create(input, now + 1);
  const execution = store.claim(running.id, now + 2);
  assert.ok(execution);
  store.updatePreview(running.id, execution.currentRunId, 'retained output');

  const summaries = store.listSummaries();

  assert.deepEqual(summaries.map(({ id, hasOutput }) => ({ id, hasOutput })), [
    { id: pending.id, hasOutput: false }, { id: running.id, hasOutput: true },
  ]);
  assert.ok(summaries.every((summary) => !('output' in summary)));
  assert.deepEqual(store.getOutput(running.id), {
    id: running.id, status: 'running', createdAt: now + 1, startedAt: now + 2,
    finishedAt: null, output: 'retained output', error: '',
  });
  assert.equal(store.getOutput('missing'), null);
  assert.equal(store.list()[1]?.output, 'retained output');
});

test('bounds errors at the persistence boundary', (t) => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const task = store.create(input, now);
  const execution = store.claim(task.id, now);
  assert.ok(execution);

  store.finishRun(task.id, execution.currentRunId, { status: 'failed', output: '', error: '猫'.repeat(100000) + 'FINAL', finishedAt: now + 1 });

  const error = store.getOutput(task.id)?.error ?? '';
  assert.ok(Buffer.byteLength(error) <= 65536);
  assert.ok(error.endsWith('FINAL'));
});

test('persists the first discovered session across reopen', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'task-session-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tasks.db');
  const original = new TaskStore(path);
  const task = original.create(input, now);
  assert.equal(task.sessionId, null);
  assert.equal(original.claimContinuation(task.id, now), null);
  original.claim(task.id, now);
  original.setSession(task.id, 'session-root');
  original.setSession(task.id, 'unrelated-child');
  original.close();
  const reopened = new TaskStore(path);
  t.after(() => reopened.close());
  assert.equal(reopened.get(task.id)?.sessionId, 'session-root');
});

for (const status of ['succeeded', 'failed'] as const) {
test(`claims a ${status} session once across connections and clears only turn state`, (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'task-resume-claim-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tasks.db');
  const first = new TaskStore(path);
  const second = new TaskStore(path);
  t.after(() => { first.close(); second.close(); });
  const task = first.create(input, now);
  const execution = first.claim(task.id, now);
  assert.ok(execution);
  first.setSession(task.id, 'root');
  first.finishRun(task.id, execution.currentRunId, { status, output: 'old output', error: status === 'failed' ? 'old failure' : '', finishedAt: now + 1 });
  const previousRuns = first.listRuns(task.id);
  const peer = first.create(input, now);
  const peerExecution = first.claim(peer.id, now);
  assert.ok(peerExecution);
  first.setSession(peer.id, 'peer-root');
  first.finishRun(peer.id, peerExecution.currentRunId, { status: 'succeeded', output: 'peer output', error: '', finishedAt: now + 1 });
  const pending = first.create(input, now);
  first.claim(pending.id, now + 1);

  const continued = second.claimContinuation(task.id, now + 2);

  assert.ok(continued);
  assert.notEqual(continued.currentRunId, execution.currentRunId);
  assert.deepEqual(continued, { ...task, sessionId: 'root', status: 'running', startedAt: now + 2, currentRunId: continued.currentRunId });
  const runs = first.listRuns(task.id);
  assert.deepEqual(runs.slice(0, -1), previousRuns);
  assert.equal(runs.at(-1)?.kind, 'continuation');
  assert.equal(runs.at(-1)?.status, 'running');
  assert.equal(first.claimContinuation(peer.id, now + 2)?.sessionId, 'peer-root');
  assert.equal(first.claimContinuation(task.id, now + 3), null);
  assert.equal(second.claimContinuation(peer.id, now + 3), null);
  assert.equal(first.claim(pending.id, now + 3), null);
  second.cancel(task.id, now + 4);
  assert.equal(first.claimContinuation(task.id, now + 5), null);
});
}

for (const sessionId of [null, '']) {
test(`rejects failed continuation with ${JSON.stringify(sessionId)} session`, (t) => {
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const task = store.create(input, now);
  store.claim(task.id, now);
  if (sessionId !== null) store.setSession(task.id, sessionId);
  store.finish(task.id, { status: 'failed', output: 'partial', error: 'failure' }, now + 1);
  const previousRuns = store.listRuns(task.id);

  const continued = store.claimContinuation(task.id, now + 2);

  assert.equal(continued, null);
  assert.equal(store.get(task.id)?.status, 'failed');
  assert.deepEqual(store.listRuns(task.id), previousRuns);
});
}
