import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { accessGuard } from '../src/server/access.js';
import { TaskStore } from '../src/server/task-store.js';
import { TaskScheduler } from '../src/server/task-scheduler.js';
import { taskRoutes } from '../src/server/task-routes.js';

const now = 1000;
const authorization = `Basic ${Buffer.from('tester:secret').toString('base64')}`;

async function fixture(t: TestContext) {
  const store = new TaskStore(':memory:');
  const scheduler = new TaskScheduler(store, { now: () => now, quota: async () => [] });
  t.after(async () => { await scheduler.stop(); store.close(); });
  const task = store.create({ description: 'work', model: 'openai/test', directory: tmpdir(), trigger: { type: 'quota' } }, now);
  const app = new Hono();
  app.use('*', accessGuard({ username: 'tester', password: 'secret' }));
  app.route('/api', taskRoutes(scheduler));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/tasks`;
  return { store, task, base };
}

test('serves metadata-only summaries without invoking the full listing over live HTTP', async (t) => {
  const { store, task, base } = await fixture(t);
  store.claim(task.id, now + 1);
  store.updateOutput(task.id, 'large output '.repeat(5000));
  t.mock.method(store, 'list', () => assert.fail('summary must not load full tasks'));

  const response = await fetch(`${base}/summary`, { headers: { authorization } });

  assert.equal(response.status, 200);
  const { output, ...metadata } = task;
  assert.deepEqual(await response.json(), {
    tasks: [{ ...metadata, status: 'running', startedAt: now + 1, hasOutput: true }],
    defaultDirectory: homedir(),
  });
});

for (const status of ['pending', 'running', 'succeeded', 'failed', 'cancelled'] as const) {
  test(`fetches retained output and time metadata for a ${status} task over live HTTP`, async (t) => {
    const { store, task, base } = await fixture(t);
    if (status !== 'pending') {
      store.claim(task.id, now + 1);
      store.updateOutput(task.id, 'current output');
    }
    if (status === 'succeeded' || status === 'failed') {
      store.finish(task.id, { status, output: 'current output', error: status === 'failed' ? 'failed reason' : '' }, now + 2);
    }
    if (status === 'cancelled') store.cancel(task.id, now + 2);

    const response = await fetch(`${base}/${task.id}/output`, { headers: { authorization } });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: task.id, status, createdAt: now, startedAt: status === 'pending' ? null : now + 1,
      finishedAt: status === 'pending' || status === 'running' ? null : now + 2,
      output: status === 'pending' ? '' : 'current output', error: status === 'failed' ? 'failed reason' : '',
    });
  });
}

test('returns 404 for an unknown output id over live HTTP', async (t) => {
  const { base } = await fixture(t);

  const response = await fetch(`${base}/missing/output`, { headers: { authorization } });

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Task not found' });
});

for (const path of ['/summary', '/missing/output']) {
  test(`protects ${path} with authentication over live HTTP`, async (t) => {
    const { base } = await fixture(t);

    const response = await fetch(base + path);

    assert.equal(response.status, 401);
  });

  test(`rejects cross-site access to ${path} over live HTTP`, async (t) => {
    const { base } = await fixture(t);

    const response = await fetch(base + path, { headers: { authorization, 'sec-fetch-site': 'cross-site' } });

    assert.equal(response.status, 403);
  });
}
