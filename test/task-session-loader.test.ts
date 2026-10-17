import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { TaskSessionResponse } from '../src/shared/tasks.js';
import { loadTaskSession, type TaskSessionLoadState, type TaskSessionSelection } from '../src/web/task-session-loader.js';

const task = { id: 'task-1', sessionId: 'ses_root', status: 'running' } as const satisfies TaskSessionSelection;

function sessionResponse(title = 'Root session'): Extract<TaskSessionResponse, { status: 'ready' }> {
  return { taskId: task.id, status: 'ready', transcript: { sessionId: task.sessionId, title, scope: 'root-only', messages: [] } };
}

function pendingResponse() {
  let fulfill: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>((resolve) => { fulfill = resolve; });
  return { promise, resolve(response: Response) { assert.ok(fulfill); fulfill(response); } };
}

test('captures the read time and task status when a session fetch completes', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  context.mock.method(globalThis, 'fetch', async () => Response.json(sessionResponse()));
  const states: TaskSessionLoadState[] = [];

  const loader = loadTaskSession(task, (state) => states.push(state));
  context.after(() => loader.stop());
  await setImmediate();

  assert.deepEqual(states, [
    { status: 'loading' },
    { status: 'ready', transcript: sessionResponse().transcript, fetchedAt: 1_700_000_000_000, taskStatus: 'running' },
  ]);
});

test('does not poll the native export when a running task snapshot is loaded', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const fetch = context.mock.method(globalThis, 'fetch', async () => Response.json(sessionResponse()));
  const loader = loadTaskSession(task, () => {});
  context.after(() => loader.stop());
  await setImmediate();

  context.mock.timers.tick(60_000);
  await setImmediate();

  assert.equal(fetch.mock.callCount(), 1);
});

test('reads a new transcript and timestamp when refresh is explicitly requested', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let attempts = 0;
  context.mock.method(globalThis, 'fetch', async () => Response.json(sessionResponse(`snapshot-${++attempts}`)));
  const states: TaskSessionLoadState[] = [];
  const loader = loadTaskSession(task, (state) => states.push(state));
  context.after(() => loader.stop());
  await setImmediate();
  context.mock.timers.setTime(2000);

  loader.refresh();
  await setImmediate();

  assert.equal(attempts, 2);
  assert.deepEqual(states[states.length - 1], { status: 'ready', transcript: sessionResponse('snapshot-2').transcript, fetchedAt: 2000, taskStatus: 'running' });
});

for (const failure of [
  { body: { taskId: task.id, status: 'error', code: 'timeout', error: 'Export timed out' } satisfies TaskSessionResponse, httpStatus: 200, message: 'Export timed out' },
  { body: { error: 'Session temporarily unavailable' }, httpStatus: 503, message: 'Session temporarily unavailable' },
]) {
  test(`reports ${failure.message} and stops when the export fails`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const fetch = context.mock.method(globalThis, 'fetch', async () => Response.json(failure.body, { status: failure.httpStatus }));
    const states: TaskSessionLoadState[] = [];

    const loader = loadTaskSession(task, (state) => states.push(state));
    context.after(() => loader.stop());
    await setImmediate();
    context.mock.timers.tick(60_000);

    assert.deepEqual(states[states.length - 1], { status: 'error', error: failure.message });
    assert.equal(fetch.mock.callCount(), 1);
  });

  test(`recovers from ${failure.message} when the user retries`, async (context) => {
    let attempts = 0;
    context.mock.method(globalThis, 'fetch', async () => ++attempts === 1
      ? Response.json(failure.body, { status: failure.httpStatus }) : Response.json(sessionResponse('retried')));
    const states: TaskSessionLoadState[] = [];
    const loader = loadTaskSession(task, (state) => states.push(state));
    context.after(() => loader.stop());
    await setImmediate();

    loader.refresh();
    await setImmediate();

    const latest = states[states.length - 1];
    assert.ok(latest?.status === 'ready');
    assert.equal(latest.transcript.title, 'retried');
    assert.equal(attempts, 2);
  });
}

test('reports no session without inventing an empty transcript when the endpoint has no session', async (context) => {
  const response: TaskSessionResponse = { taskId: task.id, status: 'no_session' };
  context.mock.method(globalThis, 'fetch', async () => Response.json(response));
  const states: TaskSessionLoadState[] = [];

  const loader = loadTaskSession(task, (state) => states.push(state));
  context.after(() => loader.stop());
  await setImmediate();

  assert.deepEqual(states[states.length - 1], { status: 'no_session' });
});

for (const outcome of ['success', 'error'] as const) {
  test(`aborts and ignores a late ${outcome} when the disclosure is stopped`, async (context) => {
    const pending = pendingResponse();
    const signals: AbortSignal[] = [];
    context.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.ok(init?.signal);
      signals.push(init.signal);
      return pending.promise;
    });
    const states: TaskSessionLoadState[] = [];
    const loader = loadTaskSession(task, (state) => states.push(state));

    loader.stop();
    pending.resolve(outcome === 'success' ? Response.json(sessionResponse()) : Response.json({ error: 'Late error' }, { status: 503 }));
    await setImmediate();

    assert.equal(signals[0]?.aborted, true);
    assert.deepEqual(states, [{ status: 'loading' }]);
  });
}

test('keeps the latest request when an aborted export finishes after refresh', async (context) => {
  const pending = pendingResponse();
  let attempts = 0;
  const signals: AbortSignal[] = [];
  context.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(init?.signal);
    signals.push(init.signal);
    return ++attempts === 1 ? pending.promise : Response.json(sessionResponse('current'));
  });
  const states: TaskSessionLoadState[] = [];
  const loader = loadTaskSession(task, (state) => states.push(state));
  context.after(() => loader.stop());

  loader.refresh();
  await setImmediate();
  pending.resolve(Response.json(sessionResponse('stale')));
  await setImmediate();

  const latest = states[states.length - 1];
  assert.ok(latest?.status === 'ready');
  assert.equal(latest.transcript.title, 'current');
  assert.equal(signals[0]?.aborted, true);
});

test('ignores a previous task export when another task replaces the disclosure content', async (context) => {
  const pending = pendingResponse();
  const selected = { ...task, id: 'task-2', sessionId: 'ses_other', status: 'succeeded' } as const;
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => String(input).includes(task.id)
    ? pending.promise : Response.json({ ...sessionResponse('selected'), taskId: selected.id, transcript: { ...sessionResponse().transcript, sessionId: selected.sessionId } }));
  const states: TaskSessionLoadState[] = [];
  const previous = loadTaskSession(task, (state) => states.push(state));

  previous.stop();
  const current = loadTaskSession(selected, (state) => states.push(state));
  context.after(() => current.stop());
  await setImmediate();
  pending.resolve(Response.json(sessionResponse('previous')));
  await setImmediate();

  const latest = states[states.length - 1];
  assert.ok(latest?.status === 'ready');
  assert.equal(latest.transcript.sessionId, selected.sessionId);
  assert.equal(latest.taskStatus, 'succeeded');
});

for (const response of [
  { ...sessionResponse(), taskId: 'different-task' },
  { ...sessionResponse(), transcript: { ...sessionResponse().transcript, sessionId: 'different-session' } },
]) {
  test(`rejects unrelated transcript ${response.taskId}/${response.transcript.sessionId} when identities mismatch`, async (context) => {
    context.mock.method(globalThis, 'fetch', async () => Response.json(response));
    const states: TaskSessionLoadState[] = [];

    const loader = loadTaskSession(task, (state) => states.push(state));
    context.after(() => loader.stop());
    await setImmediate();

    assert.equal(states[states.length - 1]?.status, 'error');
    assert.equal(states.some((state) => state.status === 'ready'), false);
  });
}
