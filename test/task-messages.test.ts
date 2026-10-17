import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { TaskStore, type TaskOutcome } from '../src/server/task-store.js';
import { TaskScheduler } from '../src/server/task-scheduler.js';
import { taskRoutes } from '../src/server/task-routes.js';
import { accessGuard } from '../src/server/access.js';

const authorization = `Basic ${Buffer.from('tester:secret').toString('base64')}`;
const success: TaskOutcome = { status: 'succeeded', output: 'old', error: '' };

function fixture(t: TestContext) {
  const store = new TaskStore(':memory:');
  const finished = Promise.withResolvers<TaskOutcome>();
  const scheduler = new TaskScheduler(store, {
    quota: async () => [], run: async (_task, signal) => {
      signal.addEventListener('abort', () => finished.resolve(success));
      return finished.promise;
    },
  });
  t.after(async () => { await scheduler.stop(); store.close(); });
  const task = scheduler.create({ description: 'original', directory: '/tmp', model: 'openai/test', trigger: { type: 'quota' } });
  const app = new Hono();
  app.use('*', accessGuard({ username: 'tester', password: 'secret' }));
  app.route('/api', taskRoutes(scheduler));
  const path = `/api/tasks/${task.id}/messages`;
  const request = (body: unknown) => app.request(path, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { app, path, request, store, task, finished };
}

for (const body of [null, [], {}, { message: '' }, { message: ' ' }, { message: 3 },
  { message: 'x\0y' }, { message: 'x'.repeat(32001) }, { message: 'hello', sessionId: 'other' }]) {
  test(`rejects invalid continuation input ${JSON.stringify(body).slice(0, 60)}`, async (t) => {
    const { request } = fixture(t);
    assert.equal((await request(body)).status, 400);
  });
}

test('protects continuation and reports malformed JSON and missing tasks', async (t) => {
  const { app, path } = fixture(t);
  assert.equal((await app.request(path, { method: 'POST' })).status, 401);
  assert.equal((await app.request(path, { method: 'POST', headers: { authorization, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await app.request(path, { method: 'POST', headers: { authorization }, body: '{' })).status, 400);
  assert.equal((await app.request('/api/tasks/missing/messages', {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: '{"message":"hello"}',
  })).status, 404);
});

for (const state of ['pending', 'running', 'failed', 'cancelled', 'legacy'] as const) {
  test(`rejects continuation for ${state} tasks`, async (t) => {
    const { store, task, request } = fixture(t);
    if (state !== 'pending') store.claim(task.id, 1);
    if (state !== 'legacy' && state !== 'failed') store.setSession(task.id, 'root');
    if (state === 'failed') store.finish(task.id, { ...success, status: 'failed' }, 2);
    if (state === 'cancelled') store.cancel(task.id, 2);
    if (state === 'legacy') store.finish(task.id, success, 2);
    assert.equal((await request({ message: 'hello' })).status, 409);
  });
}

for (const status of ['succeeded', 'failed'] as const) {
test(`accepts ${status} continuation over live HTTP once and returns the running task`, async (t) => {
  const { app, path, store, task, finished } = fixture(t);
  store.claim(task.id, 1);
  store.setSession(task.id, 'root');
  store.finish(task.id, { ...success, status }, 2);
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const send = () => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'x'.repeat(32000) }),
  });

  const responses = await Promise.all([send(), send()]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
  const accepted = responses.find((response) => response.status === 202);
  assert.ok(accepted);
  const body = await accepted.json();
  assert.equal(body.id, task.id);
  assert.equal(body.sessionId, 'root');
  assert.equal(body.status, 'running');
  assert.equal(body.description, 'original');
  assert.equal(body.output, '');
  finished.resolve({ ...success, output: 'latest turn' });
});
}
