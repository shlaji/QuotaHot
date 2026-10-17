import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedTask, TaskOutputResponse, TaskSummaryListResponse } from '../src/shared/tasks.js';
import { taskApi } from '../src/web/task-api.js';
import { copyTaskMessages } from '../src/web/task-message-copy.js';

const task: ManagedTask = {
  id: 'task /?#', description: 'Run tests', model: 'openai/test-model', directory: '/work/project',
  trigger: { type: 'quota' }, status: 'running', sessionId: 'ses_test',
  createdAt: 1000, startedAt: 2000, finishedAt: null, output: 'retained excerpt', error: '',
};

test('loads the summary list with the supplied cancellation signal', async (context) => {
  const { output, ...metadata } = task;
  const summary: TaskSummaryListResponse = {
    tasks: [{ ...metadata, hasOutput: output !== '' }], defaultDirectory: '/work/project',
  };
  const controller = new AbortController();
  const requests: Request[] = [];
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(new URL(String(input), 'http://localhost'), init));
    return Response.json(summary);
  });

  const result = await taskApi.list(controller.signal);
  controller.abort();

  assert.equal(requests[0]?.url, 'http://localhost/api/tasks/summary');
  assert.equal(requests[0]?.method, 'GET');
  assert.equal(requests[0]?.signal.aborted, true);
  assert.deepEqual(result, summary);
});

test('fetches only the selected task output at its encoded URL with cancellation', async (context) => {
  const output: TaskOutputResponse = {
    id: task.id, status: task.status, createdAt: task.createdAt, startedAt: task.startedAt,
    finishedAt: task.finishedAt, output: task.output, error: task.error,
  };
  const controller = new AbortController();
  const requests: Request[] = [];
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(new URL(String(input), 'http://localhost'), init));
    return Response.json(output);
  });

  const result = await taskApi.output(task.id, controller.signal);
  controller.abort();

  assert.equal(requests[0]?.url, 'http://localhost/api/tasks/task%20%2F%3F%23/output');
  assert.equal(requests[0]?.method, 'GET');
  assert.equal(requests[0]?.signal.aborted, true);
  assert.deepEqual(result, output);
  assert.equal(requests.length, 1);
});

for (const mutation of ['create', 'cancel', 'sendMessage'] as const) {
  for (const output of ['', 'retained excerpt']) {
    test(`${mutation} strips output from the returned task when hasOutput is ${output !== ''}`, async (context) => {
      const returned = { ...task, output };
      context.mock.method(globalThis, 'fetch', async () => Response.json(returned));

      const result = await (mutation === 'create'
        ? taskApi.create(task)
        : mutation === 'cancel'
          ? taskApi.cancel(task.id)
          : taskApi.sendMessage(task.id, 'Continue'));

      const { output: excerpt, ...metadata } = returned;
      assert.deepEqual(result, { ...metadata, hasOutput: excerpt !== '' });
      assert.equal('output' in result, false);
    });
  }
}

for (const failure of [
  { status: 404, body: JSON.stringify({ error: 'Task not found' }), message: 'Task not found' },
  { status: 502, body: 'Bad gateway', message: 'HTTP 502' },
]) {
  test(`reports output HTTP ${failure.status} as a caller-local error`, async (context) => {
    context.mock.method(globalThis, 'fetch', async () => new Response(failure.body, { status: failure.status }));

    await assert.rejects(taskApi.output(task.id, new AbortController().signal), { message: failure.message });
  });
}

test('propagates output cancellation without substituting a successful response', async (context) => {
  const controller = new AbortController();
  context.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    return Response.json(task);
  });
  controller.abort();

  await assert.rejects(taskApi.output(task.id, controller.signal), { name: 'AbortError' });
});

test('loads runs and bounded byte pages at encoded URLs with the selected cursor', async (context) => {
  const requests: Request[] = [];
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(new URL(String(input), 'http://localhost'), init));
    return Response.json({});
  });
  const controller = new AbortController();
  const cursor = { runId: 'run /?#', sequence: 4, byteOffset: 131_072 };

  await taskApi.runs(task.id, controller.signal);
  await taskApi.log(task.id, { runId: cursor.runId, cursor }, controller.signal);
  await taskApi.log(task.id, { runId: cursor.runId, tail: true }, controller.signal);
  controller.abort();

  assert.equal(requests[0]?.url, 'http://localhost/api/tasks/task%20%2F%3F%23/runs');
  assert.equal(requests[1]?.url, 'http://localhost/api/tasks/task%20%2F%3F%23/runs/run%20%2F%3F%23/log?maxBytes=65536&sequence=4&byteOffset=131072');
  assert.equal(requests[2]?.url, 'http://localhost/api/tasks/task%20%2F%3F%23/runs/run%20%2F%3F%23/log?maxBytes=65536&tail=true');
  assert.equal(requests.every((request) => request.signal.aborted), true);
});

const serializedEvents = '[\n {"sessionID":"root","extra":1},\n {"type":"step_start","part":{"text":"hidden"}},\n {"type":"tool_use","part":{"input":{"command":"test"}}},\n {"type":"text","part":{"text":"中文\\n"}},\n {"type":"step_finish","usage":{"total":42}}\n]\n';

test('copies the exact already-serialized full event array from the messages download endpoint', async (context) => {
  const requests: Request[] = [];
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(new URL(String(input), 'http://localhost'), init));
    return new Response(serializedEvents, { headers: { 'content-type': 'application/json' } });
  });
  const copied: string[] = [];

  const result = await copyTaskMessages({ id: task.id, runId: 'run /?#', signal: new AbortController().signal }, async (text) => { copied.push(text); });

  assert.equal(requests[0]?.url, 'http://localhost/api/tasks/task%20%2F%3F%23/runs/run%20%2F%3F%23/messages/download');
  assert.deepEqual(result, { status: 'copied' });
  assert.deepEqual(copied, [serializedEvents]);
});

test('retains the exact array for a second user click when clipboard permission expires', async (context) => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => new Response(serializedEvents));

  const result = await copyTaskMessages({ id: task.id, runId: 'run', signal: new AbortController().signal }, async () => { throw new DOMException('gesture expired', 'NotAllowedError'); });

  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.serialized, serializedEvents);
  assert.equal(fetch.mock.callCount(), 1);
});

test('retries a prepared copy without rereading or reconstructing the archive', async (context) => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Archive must not be fetched again'); });
  const copied: string[] = [];

  const result = await copyTaskMessages({ id: task.id, runId: 'run', signal: new AbortController().signal, prepared: serializedEvents }, async (text) => { copied.push(text); });

  assert.deepEqual(result, { status: 'copied' });
  assert.deepEqual(copied, [serializedEvents]);
  assert.equal(fetch.mock.callCount(), 0);
});

test('surfaces a full-array endpoint error without copying error JSON as messages', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Archive unavailable' }, { status: 503 }));
  const copied: string[] = [];

  await assert.rejects(copyTaskMessages({ id: task.id, runId: 'run', signal: new AbortController().signal }, async (text) => { copied.push(text); }), { message: 'Archive unavailable' });

  assert.deepEqual(copied, []);
});
