import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { TaskStore } from '../src/server/task-store.js';
import type { TaskLogCursor } from '../src/shared/tasks.js';

const now = Date.parse('2026-10-16T12:00:00.000Z');
const input = { description: 'archive', model: 'openai/test', directory: tmpdir(), trigger: { type: 'quota' } } as const;

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'task-archive-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tasks.db');
  const store = new TaskStore(path);
  t.after(() => { if (store['db'].isOpen) store.close(); });
  const task = store.create(input, now);
  const run = store.claim(task.id, now + 1);
  assert.ok(run);
  return { store, path, task, runId: run.currentRunId };
}

test('retains raw binary output byte-for-byte across close and reopen', (t) => {
  const { store, path, task, runId } = fixture(t);
  const bytes = Buffer.from(Array.from({ length: 170003 }, (_, index) => index % 256));
  store.appendOutput(task.id, runId, bytes.subarray(0, 1), 'stdout');
  store.appendOutput(task.id, runId, bytes.subarray(1), 'stderr');
  store.updatePreview(task.id, runId, 'small preview');
  store.finishRun(task.id, runId, { status: 'succeeded', output: 'small preview', error: '', finishedAt: now + 2 });
  store.close();

  const reopened = new TaskStore(path);
  t.after(() => reopened.close());
  const page = reopened.readLogPage(task.id, runId, { maxBytes: 200000 });

  assert.ok(page);
  assert.deepEqual(Buffer.concat(page.chunks.map((chunk) => chunk.data)), bytes);
  assert.deepEqual(page.chunks.map((chunk) => chunk.stream), ['stdout', 'stderr', 'stderr', 'stderr']);
  assert.deepEqual(page.chunks.map((chunk) => chunk.sequence), [0, 1, 2, 3]);
  assert.deepEqual(page.chunks.map((chunk) => chunk.byteOffset), [0, 1, 65537, 131073]);
  assert.equal(page.totalBytes, bytes.length);
  assert.equal(reopened.listRuns(task.id)[0]?.archiveState, 'complete');
  assert.equal(reopened.get(task.id)?.output, 'small preview');
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT count(*) AS count FROM task_log_chunks WHERE typeof(data) != \'blob\' OR length(data) > 65536').get()?.count, 0);
});

test('pages partial chunks without gaps or duplicates under both byte and row budgets', (t) => {
  const { store, task, runId } = fixture(t);
  const bytes = Buffer.from(Array.from({ length: 210013 }, (_, index) => index % 251));
  store.appendOutput(task.id, runId, bytes.subarray(0, 4), 'stdout');
  store.appendOutput(task.id, runId, bytes.subarray(4, 13), 'stderr');
  store.appendOutput(task.id, runId, bytes.subarray(13), 'stdout');
  let cursor: TaskLogCursor = { runId, sequence: 0, byteOffset: 0 };
  const chunks: Uint8Array[] = [];

  do {
    const page = store.readLogPage(task.id, runId, { cursor, maxBytes: 997, maxChunks: 2 });
    assert.ok(page);
    assert.ok(page.chunks.length <= 2);
    assert.ok(page.chunks.reduce((size, chunk) => size + chunk.data.length, 0) <= 997);
    let offset = cursor.byteOffset;
    for (const chunk of page.chunks) {
      assert.equal(chunk.byteOffset, offset);
      assert.equal(chunk.stream, offset >= 4 && offset < 13 ? 'stderr' : 'stdout');
      offset += chunk.data.length;
      chunks.push(chunk.data);
    }
    assert.equal(page.nextCursor.byteOffset, offset);
    assert.ok(offset > cursor.byteOffset);
    assert.equal(page.totalBytes, bytes.length);
    cursor = page.nextCursor;
  } while (cursor.byteOffset < bytes.length);

  assert.deepEqual(Buffer.concat(chunks), bytes);
  const end = store.readLogPage(task.id, runId, { cursor });
  assert.deepEqual(end?.chunks, []);
  assert.equal(end?.hasMore, false);
  store.appendOutput(task.id, runId, Buffer.from('tail'), 'stderr');
  assert.equal(Buffer.concat(store.readLogPage(task.id, runId, { cursor })?.chunks.map((chunk) => chunk.data) ?? []).toString(), 'tail');
});

test('retains separate initial and continuation rounds with latest preview metadata', (t) => {
  const { store, task, runId } = fixture(t);
  store.setSession(task.id, 'root');
  store.appendOutput(task.id, runId, Buffer.from('first raw'), 'stdout');
  store.finishRun(task.id, runId, { status: 'succeeded', output: 'first preview', error: '', finishedAt: now + 2 });

  const continuation = store.claimContinuation(task.id, now + 3);

  assert.ok(continuation);
  assert.notEqual(continuation.currentRunId, runId);
  store.appendOutput(task.id, continuation.currentRunId, Buffer.from('second raw'), 'stderr');
  store.updatePreview(task.id, continuation.currentRunId, 'second preview');
  assert.deepEqual(store.listRuns(task.id).map(({ id, ordinal, kind, status }) => ({ id, ordinal, kind, status })), [
    { id: runId, ordinal: 1, kind: 'initial', status: 'succeeded' },
    { id: continuation.currentRunId, ordinal: 2, kind: 'continuation', status: 'running' },
  ]);
  assert.equal(Buffer.concat(store.readLogPage(task.id, runId)?.chunks.map((chunk) => chunk.data) ?? []).toString(), 'first raw');
  assert.deepEqual(store.getPreviewMetadata(task.id), {
    taskId: task.id, currentRunId: continuation.currentRunId, previewBytes: 14,
    totalBytes: 10, totalChunks: 1, archiveState: 'capturing',
  });
});

test('rejects obsolete run append, preview and finalization without changing the current round', (t) => {
  const { store, task, runId } = fixture(t);
  store.setSession(task.id, 'root');
  store.finishRun(task.id, runId, { status: 'succeeded', output: 'first', error: '', finishedAt: now + 2 });
  const current = store.claimContinuation(task.id, now + 3);
  assert.ok(current);

  assert.throws(() => store.appendOutput(task.id, runId, Buffer.from('stale'), 'stdout'), { name: 'TaskRunWriteError' });
  assert.throws(() => store.updatePreview(task.id, runId, 'stale'), { name: 'TaskRunWriteError' });
  assert.throws(() => store.finishRun(task.id, runId, { status: 'failed', output: 'stale', error: 'stale', finishedAt: now + 4 }), { name: 'TaskRunWriteError' });

  assert.equal(store.get(task.id)?.status, 'running');
  assert.equal(store.get(task.id)?.output, '');
  assert.equal(store.listRuns(task.id)[1]?.totalBytes, 0);
});

test('retains committed and draining bytes when cancellation precedes finalization', (t) => {
  const { store, task, runId } = fixture(t);
  store.appendOutput(task.id, runId, Buffer.from('before'), 'stdout');
  store.cancel(task.id, now + 2);
  assert.equal(store.remove(task.id), false);

  store.appendOutput(task.id, runId, Buffer.from('after'), 'stderr');
  store.finishRun(task.id, runId, { status: 'succeeded', output: 'cancelled preview', error: '', finishedAt: now + 3 });

  assert.equal(store.get(task.id)?.status, 'cancelled');
  assert.equal(store.get(task.id)?.finishedAt, now + 2);
  const [run] = store.listRuns(task.id);
  assert.equal(run?.status, 'cancelled');
  assert.equal(run?.finishedAt, now + 2);
  assert.equal(run?.closedAt, now + 3);
  assert.equal(run?.archiveState, 'complete');
  assert.equal(Buffer.concat(store.readLogPage(task.id, runId)?.chunks.map((chunk) => chunk.data) ?? []).toString(), 'beforeafter');
  assert.throws(() => store.appendOutput(task.id, runId, Buffer.from('closed'), 'stderr'), { name: 'TaskRunWriteError' });
});

test('creates only one round when two workers race for the same claim', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'task-archive-race-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tasks.db');
  const store = new TaskStore(path);
  t.after(() => store.close());
  const task = store.create(input, now);
  const workers = Array.from({ length: 2 }, () => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    require('tsx/cjs');
    const { TaskStore } = require(workerData.module);
    const store = new TaskStore(workerData.path);
    parentPort.postMessage('ready');
    parentPort.once('message', () => {
      const claimed = store.claim(workerData.id, workerData.now);
      store.close();
      parentPort.postMessage(claimed?.currentRunId ?? null);
    });
  `, { eval: true, workerData: { path, id: task.id, now, module: new URL('../src/server/task-store.ts', import.meta.url).pathname } }));
  t.after(() => Promise.all(workers.map((worker) => worker.terminate())));
  await Promise.all(workers.map((worker) => once(worker, 'message')));

  const results = await Promise.all(workers.map((worker) => {
    const result = once(worker, 'message');
    worker.postMessage('claim');
    return result;
  }));

  assert.equal(results.filter(([runId]) => typeof runId === 'string').length, 1);
  assert.equal(store.listRuns(task.id).length, 1);
});

test('rejects out-of-run and invalid cursors and clamps oversized page requests', (t) => {
  const { store, task, runId } = fixture(t);
  store.appendOutput(task.id, runId, Buffer.alloc(600000, 42), 'stdout');

  const page = store.readLogPage(task.id, runId, { maxBytes: Number.MAX_SAFE_INTEGER, maxChunks: Number.MAX_SAFE_INTEGER });

  assert.ok(page);
  assert.ok(page.chunks.reduce((size, chunk) => size + chunk.data.length, 0) <= 262144);
  assert.ok(page.chunks.length <= 128);
  for (const cursor of [
    { runId: 'different', sequence: 0, byteOffset: 0 },
    { runId, sequence: 2, byteOffset: 0 },
    { runId, sequence: 0, byteOffset: -1 },
    { runId, sequence: 0, byteOffset: 999999 },
  ]) assert.throws(() => store.readLogPage(task.id, runId, { cursor }), RangeError);
  assert.throws(() => store.readLogPage(task.id, runId, { maxBytes: 0 }), RangeError);
  assert.throws(() => store.readLogPage(task.id, runId, { maxChunks: NaN }), RangeError);
  assert.equal(store.readLogPage('another-task', runId), null);
});

test('deletes archive rounds and chunks only on explicit inactive-task deletion', (t) => {
  const { store, path, task, runId } = fixture(t);
  store.appendOutput(task.id, runId, Buffer.from('retained'), 'stdout');
  assert.equal(store.remove(task.id), false);
  store.setSession(task.id, 'root');
  store.finishRun(task.id, runId, { status: 'succeeded', output: '', error: '', finishedAt: now + 2 });
  const continued = store.claimContinuation(task.id, now + 3);
  assert.ok(continued);
  store.appendOutput(task.id, continued.currentRunId, Buffer.from('next round'), 'stderr');
  store.finishRun(task.id, continued.currentRunId, { status: 'succeeded', output: '', error: '', finishedAt: now + 4 });
  const db = new DatabaseSync(path);
  t.after(() => db.close());

  assert.equal(store.remove(task.id), true);

  assert.equal(db.prepare('SELECT count(*) AS count FROM task_runs').get()?.count, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM task_log_chunks').get()?.count, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('queries summaries and legacy lists without reading archive chunks', (t) => {
  const { store, task, runId } = fixture(t);
  store.appendOutput(task.id, runId, Buffer.alloc(200000, 65), 'stdout');
  store.updatePreview(task.id, runId, 'preview');
  store['db'].setAuthorizer((_action, table) => table === 'task_log_chunks' ? constants.SQLITE_DENY : constants.SQLITE_OK);

  const summaries = store.listSummaries();

  assert.equal(summaries[0]?.hasOutput, true);
  assert.ok(!('output' in summaries[0]));
  assert.equal(store.list()[0]?.output, 'preview');
  assert.equal(store.getPreviewMetadata(task.id)?.totalBytes, 200000);
});

test('pages an empty round and caps rows even when the byte budget permits more', (t) => {
  const { store, task, runId } = fixture(t);
  store.appendOutput(task.id, runId, Buffer.alloc(0), 'stdout');
  const empty = store.readLogPage(task.id, runId);
  assert.deepEqual(empty?.chunks, []);
  assert.equal(empty?.totalChunks, 0);
  assert.deepEqual(empty?.nextCursor, { runId, sequence: 0, byteOffset: 0 });
  for (let index = 0; index < 140; index++) store.appendOutput(task.id, runId, Buffer.from([index]), 'stdout');

  const page = store.readLogPage(task.id, runId, { maxBytes: 1000, maxChunks: 1000 });

  assert.equal(page?.chunks.length, 128);
  assert.equal(page?.nextCursor.sequence, 128);
  assert.equal(page?.nextCursor.byteOffset, 128);
  assert.equal(page?.totalChunks, 140);
  assert.equal(page?.hasMore, true);
});

test('starts at the latest bounded page when tail mode is requested', (t) => {
  const { store, task, runId } = fixture(t);
  const bytes = Buffer.from(Array.from({ length: 180000 }, (_, index) => index % 239));
  store.appendOutput(task.id, runId, bytes, 'stderr');

  const page = store.readLogPage(task.id, runId, { tail: true, maxBytes: 1000, maxChunks: 2 });

  assert.ok(page);
  assert.equal(page.hasEarlier, true);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor.byteOffset, bytes.length);
  assert.ok(page.chunks.every((chunk) => chunk.stream === 'stderr'));
  assert.equal(Buffer.concat(page.chunks.map((chunk) => Buffer.from(chunk.data))).compare(bytes.subarray(-1000)), 0);
});
