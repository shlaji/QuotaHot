import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { TaskStore, type TaskOutcome } from '../src/server/task-store.js';
import { TaskScheduler } from '../src/server/task-scheduler.js';
import { taskRoutes } from '../src/server/task-routes.js';
import { parseTaskInput } from '../src/server/task-input.js';
import { accessGuard } from '../src/server/access.js';

const now = Date.now();
const valid = { description: 'do work', model: 'openai/test', directory: tmpdir(), trigger: { type: 'time', at: now + 10000 } };
const authorization = `Basic ${Buffer.from('tester:secret').toString('base64')}`;

function fixture(t: TestContext) {
  const store = new TaskStore(':memory:');
  const scheduler = new TaskScheduler(store, { now: () => now, quota: async () => [] });
  t.after(async () => { await scheduler.stop(); store.close(); });
  const app = new Hono();
  app.use('*', accessGuard({ username: 'tester', password: 'secret' }));
  app.route('/api', taskRoutes(scheduler, () => now));
  const request = (path: string, method = 'GET', body?: unknown) => app.request(`http://localhost/api/tasks${path}`, {
    method, headers: { authorization, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { app, request, store, scheduler };
}

test('creates, lists, cancels and deletes tasks through the protected HTTP contract', async (t) => {
  const { request } = fixture(t);
  const created = await request('', 'POST', valid);
  assert.equal(created.status, 201);
  const task = await created.json();
  assert.equal(task.status, 'pending');
  assert.equal(task.model, valid.model);
  assert.deepEqual(await (await request('')).json(), { tasks: [task], defaultDirectory: homedir() });
  const cancelled = await request(`/${task.id}/cancel`, 'POST');
  assert.equal((await cancelled.json()).status, 'cancelled');
  assert.deepEqual(await (await request(`/${task.id}`, 'DELETE')).json(), { removed: task.id });
  assert.equal((await request(`/${task.id}`, 'DELETE')).status, 404);
  assert.equal((await request('/missing/cancel', 'POST')).status, 404);
});

test('rejects malformed JSON, unauthenticated requests and cross-site access', async (t) => {
  const { app } = fixture(t);
  assert.equal((await app.request('/api/tasks')).status, 401);
  assert.equal((await app.request('/api/tasks', { method: 'POST', headers: { authorization }, body: '{' })).status, 400);
  assert.equal((await app.request('/api/tasks', { headers: { authorization, 'sec-fetch-site': 'cross-site' } })).status, 403);
});

test('refuses deleting running tasks and cancelling completed tasks', async (t) => {
  const { request, scheduler, store } = fixture(t);
  const running = scheduler.create({ ...valid, trigger: { type: 'quota' } });
  store.claim(running.id, now);
  assert.equal((await request(`/${running.id}`, 'DELETE')).status, 409);
  const result: TaskOutcome = { status: 'succeeded', output: '', error: '' };
  store.finish(running.id, result, now);
  assert.equal((await request(`/${running.id}/cancel`, 'POST')).status, 409);
});

const invalid: unknown[] = [
  null, [], {}, { ...valid, description: '' }, { ...valid, description: ' ' },
  { ...valid, description: 'x'.repeat(32001) }, { ...valid, description: 'x\0y' },
  ...['', 'model', '/model', 'provider/', 'pro vider/model', 'provider/model name', 'p/' + 'm'.repeat(199), 'p/\0'].map((model) => ({ ...valid, model })),
  ...['relative', '', '/missing-task-directory', new URL(import.meta.url).pathname, null].map((directory) => ({ ...valid, directory })),
  ...[null, { type: 'unknown' }, { type: 'time' }, { type: 'time', at: now }, { type: 'time', at: 'later' }, { type: 'time', at: 1e100 }].map((trigger) => ({ ...valid, trigger })),
];
for (const [index, body] of invalid.entries()) {
  test(`rejects invalid task request ${index}`, async (t) => {
    const { request } = fixture(t);
    assert.equal((await request('', 'POST', body)).status, 400);
  });
}

test('defaults only an omitted directory and accepts boundary input sizes', async () => {
  const task = await parseTaskInput({
    description: 'x'.repeat(32000), model: 'p/' + 'm'.repeat(198), trigger: { type: 'quota' },
  }, now);
  assert.equal(task.directory, homedir());
  assert.equal(task.description.length, 32000);
  assert.equal(task.model.length, 200);
  for (const at of [NaN, Infinity, -Infinity]) {
    await assert.rejects(parseTaskInput({ ...valid, trigger: { type: 'time', at } }, now));
  }
});

async function modelCommand(t: TestContext, source: string) {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-models-'));
  const directory = join(root, 'project with spaces;echo injected');
  const originalPath = process.env.PATH;
  t.after(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(directory);
  await writeFile(join(root, 'opencode'), `#!${process.execPath}\n${source}`, { mode: 0o700 });
  process.env.PATH = `${root}${delimiter}${originalPath ?? ''}`;
  return directory;
}

test('discovers unique models when an explicit directory is provided', async (t) => {
  const directory = await modelCommand(t, `
    const assert = require('node:assert/strict');
    assert.deepEqual(process.argv.slice(2), ['models']);
    assert.equal(require('node:path').basename(process.cwd()), 'project with spaces;echo injected');
    process.stdout.write('\u001b[32mopenai/test\u001b[0m\\r\\n\\n anthropic/claude-test \\nopenai/test\\n');
  `);
  const { request } = fixture(t);

  const response = await request(`/models?directory=${encodeURIComponent(directory)}`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { models: ['openai/test', 'anthropic/claude-test'], directory });
});

for (const query of ['', '?directory=', '?directory=%20%20']) {
  test(`uses the scheduler default when directory is omitted or blank (${query})`, async (t) => {
    const directory = await modelCommand(t, `
      require('node:assert/strict').equal(require('node:path').basename(process.cwd()), 'project with spaces;echo injected');
      console.log('openai/default');
    `);
    const { request, scheduler } = fixture(t);
    t.mock.method(scheduler, 'list', () => ({ tasks: [], defaultDirectory: directory }));

    const response = await request(`/models${query}`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { models: ['openai/default'], directory });
  });
}

for (const directory of ['relative', '/missing-task-model-directory', new URL(import.meta.url).pathname, '/tmp/\0']) {
  test(`rejects model discovery when directory is invalid (${JSON.stringify(directory)})`, async (t) => {
    const { request } = fixture(t);

    const response = await request(`/models?directory=${encodeURIComponent(directory)}`);

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /directory/i);
  });
}

test('returns a bounded actionable error when the models command fails', async (t) => {
  const directory = await modelCommand(t, "process.stderr.write('private diagnostic '.repeat(2000)); process.exitCode = 1;");
  const { request } = fixture(t);

  const response = await request(`/models?directory=${encodeURIComponent(directory)}`);

  assert.equal(response.status, 503);
  const { error } = await response.json();
  assert.match(error, /opencode models/);
  assert.ok(error.length <= 1000);
  assert.doesNotMatch(error, /private diagnostic/);
});

test('rejects model discovery when command output exceeds the buffer limit', async (t) => {
  const directory = await modelCommand(t, "process.stdout.write('openai/test\\n'.repeat(200000));");
  const { request } = fixture(t);

  const response = await request(`/models?directory=${encodeURIComponent(directory)}`);

  assert.equal(response.status, 503);
});

test('protects model discovery with the existing access guard', async (t) => {
  const { app } = fixture(t);

  const response = await app.request('/api/tasks/models');

  assert.equal(response.status, 401);
});

test('returns an actionable error when OpenCode is missing from PATH', async (t) => {
  const directory = await modelCommand(t, '');
  process.env.PATH = directory;
  const { request } = fixture(t);

  const response = await request(`/models?directory=${encodeURIComponent(directory)}`);

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /PATH/);
});

test('returns no models when the command only emits blank lines or diagnostics', async (t) => {
  const directory = await modelCommand(t, "console.log('\\nLoading models...\\nnot-a-model\\n');");
  const { request } = fixture(t);

  const response = await request(`/models?directory=${encodeURIComponent(directory)}`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { models: [], directory });
});

test('terminates model discovery when the command hangs', { timeout: 20000 }, async (t) => {
  const directory = await modelCommand(t, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  const { request } = fixture(t);

  const response = await request(`/models?directory=${encodeURIComponent(directory)}`);

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /timed out/);
});

for (const succeeds of [true, false]) {
  test(`serves model discovery over live HTTP when the CLI ${succeeds ? 'succeeds' : 'fails'}`, async (t) => {
    const directory = await modelCommand(t, succeeds ? "console.log('openai/live');" : 'process.exitCode = 1;');
    const { app } = fixture(t);
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/models?directory=${encodeURIComponent(directory)}`, {
      headers: { authorization },
    });

    assert.equal(response.status, succeeds ? 200 : 503);
    const body = await response.json();
    if (succeeds) assert.deepEqual(body, { models: ['openai/live'], directory });
    else assert.match(body.error, /opencode models/);
  });
}
