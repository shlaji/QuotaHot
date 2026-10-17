import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { TaskLogPageResponse, TaskRun } from '../src/shared/tasks.js';
import { loadTaskOutput, type TaskOutputLoadState } from '../src/web/task-output-loader.js';

const running: TaskRun = {
  id: 'run-2', taskId: 'task-1', ordinal: 2, kind: 'continuation', status: 'running',
  createdAt: 1000, startedAt: 2000, finishedAt: null, closedAt: null, error: '',
  archiveState: 'capturing', totalBytes: 100, totalChunks: 1,
};
const task = { id: running.taskId, createdAt: 1000, startedAt: 2000 };
const earlier: TaskRun = { ...running, id: 'run-1', ordinal: 1, kind: 'initial', status: 'succeeded', archiveState: 'complete' };

function logPage(text = '消息正文', options: Partial<TaskLogPageResponse> = {}): TaskLogPageResponse {
  const data = Buffer.from(JSON.stringify({ type: 'text', part: { text } }) + '\n');
  return {
    runId: running.id, encoding: 'base64', archiveState: 'capturing',
    chunks: [{ sequence: 0, byteOffset: 0, stream: 'stdout', data: data.toString('base64') }],
    nextCursor: { runId: running.id, sequence: 1, byteOffset: data.length },
    totalBytes: data.length, totalChunks: 1, hasEarlier: false, hasMore: false, ...options,
  };
}

function mockLogs(context: TestContext, handler: (url: URL, signal?: AbortSignal | null) => Promise<Response>) {
  return context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/runs')) return Response.json({ taskId: task.id, runs: [earlier, running] });
    assert.ok(url.pathname.endsWith('/log'));
    return handler(url, init?.signal);
  });
}

function pendingResponse() {
  let fulfill: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>((resolve) => { fulfill = resolve; });
  return {
    promise,
    resolve(response: Response) {
      assert.ok(fulfill);
      fulfill(response);
    },
  };
}

test('refreshes a running latest window serially after each previous response settles', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = pendingResponse();
  let requests = 0;
  const states: TaskOutputLoadState[] = [];
  mockLogs(context, async () => {
    requests += 1;
    return requests === 1 ? pending.promise : Response.json(logPage('new tail'));
  });
  const loader = loadTaskOutput(task, (state) => states.push(state));
  context.after(() => loader.stop());

  await setImmediate();
  context.mock.timers.tick(10_000);
  await setImmediate();
  assert.equal(requests, 1);
  pending.resolve(Response.json(logPage()));
  await setImmediate();
  context.mock.timers.tick(1999);
  assert.equal(requests, 1);
  context.mock.timers.tick(1);
  await setImmediate();

  assert.equal(requests, 2);
  assert.equal(states.at(-1)?.page?.window.messages, 'new tail');
});

for (const archiveState of ['complete', 'incomplete', 'legacy_unknown'] as const) {
  test(`loads a ${archiveState} archive once without polling it again`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const states: TaskOutputLoadState[] = [];
    let requests = 0;
    mockLogs(context, async () => { requests += 1; return Response.json(logPage('finished', { archiveState })); });
    const loader = loadTaskOutput(task, (state) => states.push(state));
    context.after(() => loader.stop());

    await setImmediate();
    context.mock.timers.tick(10_000);
    await setImmediate();

    assert.equal(requests, 1);
    assert.equal(states.at(-1)?.page?.metadata.archiveState, archiveState);
    assert.equal(states.at(-1)?.following, false);
  });
}

for (const outcome of ['success', 'error'] as const) {
  test(`aborts and ignores a late ${outcome} after the disclosure loader is disposed`, async (context) => {
    const pending = pendingResponse();
    const signals: AbortSignal[] = [];
    const states: TaskOutputLoadState[] = [];
    mockLogs(context, async (_url, signal) => {
      assert.ok(signal);
      signals.push(signal);
      return pending.promise;
    });
    const loader = loadTaskOutput(task, (state) => states.push(state));
    await setImmediate();
    const beforeStop = [...states];

    loader.stop();
    pending.resolve(outcome === 'success'
      ? Response.json(logPage())
      : Response.json({ error: 'Task not found' }, { status: 404 }));
    await setImmediate();

    assert.equal(signals[0]?.aborted, true);
    assert.deepEqual(states, beforeStop);
  });
}

test('clears a scheduled output refresh when the disclosure loader is disposed', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  mockLogs(context, async () => { requests += 1; return Response.json(logPage()); });
  const loader = loadTaskOutput(task, () => {});
  await setImmediate();

  loader.stop();
  context.mock.timers.tick(10_000);
  await setImmediate();

  assert.equal(requests, 1);
});

test('aborts an old run request and prevents its late response from replacing the selected run', async (context) => {
  const pending = pendingResponse();
  const states: TaskOutputLoadState[] = [];
  const signals: AbortSignal[] = [];
  mockLogs(context, async (url, signal) => {
    assert.ok(signal);
    signals.push(signal);
    return url.pathname.includes(running.id) ? pending.promise : Response.json(logPage('selected run', {
      runId: earlier.id, nextCursor: { runId: earlier.id, sequence: 1, byteOffset: 50 }, archiveState: 'complete',
    }));
  });
  const loader = loadTaskOutput(task, (state) => states.push(state));
  context.after(() => loader.stop());
  await setImmediate();
  loader.selectRun(earlier.id);
  await setImmediate();

  pending.resolve(Response.json(logPage('stale run')));
  await setImmediate();

  assert.equal(signals[0]?.aborted, true);
  assert.equal(states.at(-1)?.run?.id, earlier.id);
  assert.equal(states.at(-1)?.page?.window.messages, 'selected run');
});

for (const changed of [{ runId: 'different-run' }, { nextCursor: { runId: 'different-run', sequence: 1, byteOffset: 50 } }]) {
  test(`rejects a page with a mismatched ${Object.keys(changed)[0]}`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const states: TaskOutputLoadState[] = [];
    let requests = 0;
    mockLogs(context, async () => { requests += 1; return Response.json(logPage('wrong', changed)); });
    const loader = loadTaskOutput(task, (state) => states.push(state));
    context.after(() => loader.stop());

    await setImmediate();
    context.mock.timers.tick(10_000);
    await setImmediate();

    assert.equal(states.at(-1)?.page, null);
    assert.ok(states.at(-1)?.error);
    assert.equal(requests, 1);
  });
}

test('stops on an output error and allows a fresh explicit attempt', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const states: TaskOutputLoadState[] = [];
  mockLogs(context, async () => {
    attempts += 1;
    return attempts === 1
      ? Response.json({ error: 'output unavailable' }, { status: 503 })
      : Response.json(logPage('retried', { archiveState: 'complete' }));
  });
  const loader = loadTaskOutput(task, (state) => states.push(state));
  context.after(() => loader.stop());
  await setImmediate();
  context.mock.timers.tick(10_000);
  assert.equal(attempts, 1);
  assert.equal(states.at(-1)?.error, 'output unavailable');
  loader.retry();
  await setImmediate();

  assert.equal(attempts, 2);
  assert.equal(states.at(-1)?.page?.window.messages, 'retried');
  assert.equal(states.at(-1)?.error, '');
});

test('defaults to the newest run and tail, then navigates forward with a bounded three-page cache', async (context) => {
  const requests: URL[] = [];
  const states: TaskOutputLoadState[] = [];
  mockLogs(context, async (url) => {
    requests.push(url);
    const number = Number(url.searchParams.get('byteOffset') ?? 0) / 100 + 1;
    return Response.json(logPage(`page ${number}`, {
      archiveState: 'complete', hasEarlier: number > 1, hasMore: number < 5,
      nextCursor: { runId: running.id, sequence: number, byteOffset: number * 100 },
    }));
  });
  const loader = loadTaskOutput(task, (state) => states.push(state));
  context.after(() => loader.stop());
  await setImmediate();
  assert.equal(states.at(-1)?.run?.id, running.id);
  assert.equal(requests[0]?.searchParams.get('tail'), 'true');
  assert.equal(requests[0]?.searchParams.get('maxBytes'), '65536');

  loader.first();
  await setImmediate();
  for (let number = 2; number <= 5; number += 1) { loader.next(); await setImmediate(); }
  const count = requests.length;
  loader.previous();
  loader.previous();

  assert.equal(states.at(-1)?.page?.number, 3);
  assert.equal(states.at(-1)?.cacheSize, 3);
  assert.equal(states.at(-1)?.hasPrevious, false);
  assert.equal(requests.length, count);
  assert.equal(requests.at(-1)?.searchParams.get('sequence'), '4');
  assert.equal(requests.at(-1)?.searchParams.get('byteOffset'), '400');
});

test('aborts a slow run-list request and ignores its completion after collapse', async (context) => {
  const pending = pendingResponse();
  const states: TaskOutputLoadState[] = [];
  let signal: AbortSignal | null | undefined;
  const fetch = context.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => { signal = init?.signal; return pending.promise; });
  const loader = loadTaskOutput(task, (state) => states.push(state));

  loader.stop();
  pending.resolve(Response.json({ taskId: task.id, runs: [running] }));
  await setImmediate();

  assert.equal(signal?.aborted, true);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(states.length, 1);
  assert.equal(states[0]?.page, null);
});
