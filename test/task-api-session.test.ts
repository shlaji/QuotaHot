import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskSessionResponse } from '../src/shared/tasks.js';
import { taskApi } from '../src/web/task-api.js';

const taskId = 'task /?#';
const responses: readonly TaskSessionResponse[] = [
  { taskId, status: 'no_session' },
  { taskId, status: 'error', code: 'cli_unavailable', error: 'OpenCode unavailable' },
  { taskId, status: 'ready', transcript: { sessionId: 'ses_root', title: 'Root session', time: { created: 1000, updated: 2000 }, scope: 'root-only', messages: [] } },
];

for (const response of responses) {
  test(`returns the typed ${response.status} session response when the endpoint succeeds`, async (context) => {
    const controller = new AbortController();
    const requests: Request[] = [];
    context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(new URL(String(input), 'http://localhost'), init));
      return Response.json(response);
    });

    const result: TaskSessionResponse = await taskApi.session(taskId, controller.signal);
    controller.abort();

    assert.deepEqual(result, response);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, 'http://localhost/api/tasks/task%20%2F%3F%23/session');
    assert.equal(requests[0]?.method, 'GET');
    assert.equal(requests[0]?.signal.aborted, true);
  });
}

for (const failure of [
  { status: 404, body: JSON.stringify({ error: 'Task not found' }), message: 'Task not found' },
  { status: 502, body: 'Bad gateway', message: 'HTTP 502' },
]) {
  test(`rejects the session request when HTTP ${failure.status} is returned`, async (context) => {
    context.mock.method(globalThis, 'fetch', async () => new Response(failure.body, { status: failure.status }));

    await assert.rejects(taskApi.session(taskId, new AbortController().signal), { message: failure.message });
  });
}

test('propagates cancellation when the session request is aborted', async (context) => {
  const controller = new AbortController();
  context.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    return Response.json(responses[0]);
  });
  controller.abort();

  await assert.rejects(taskApi.session(taskId, controller.signal), { name: 'AbortError' });
});

test('requests only summary metadata when polling the task list', async (context) => {
  const requests: string[] = [];
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json({ tasks: [], defaultDirectory: '/work/project' });
  });

  await taskApi.list(new AbortController().signal);

  assert.deepEqual(requests, ['/api/tasks/summary']);
});
