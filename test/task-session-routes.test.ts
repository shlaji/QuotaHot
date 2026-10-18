import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { copyFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { TaskStore } from '../src/server/task-store.js';
import { TaskScheduler } from '../src/server/task-scheduler.js';
import { taskRoutes } from '../src/server/task-routes.js';
import { SessionExportError } from '../src/server/opencode-export-payload.js';
import type { SessionExporter, SessionExportSource } from '../src/server/opencode-session-export.js';
import { exportSession } from '../src/server/opencode-session-export.js';
import type { TaskSessionResponse, TaskSessionTranscript } from '../src/shared/tasks.js';

const transcript: TaskSessionTranscript = { sessionId: 'ses_stored', title: 'Saved', time: { created: 1000, updated: 2000 }, scope: 'root-only', messages: [] };

async function fixture(context: TestContext, exporter: SessionExporter) {
  const store = new TaskStore(':memory:');
  const scheduler = new TaskScheduler(store, { quota: async () => [], exportSession: exporter });
  context.after(async () => { await scheduler.stop(); store.close(); });
  const task = store.create({ description: 'work', directory: tmpdir(), model: 'openai/test', trigger: { type: 'quota' } }, 1000);
  const app = new Hono().route('/api', taskRoutes(scheduler));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { store, task, base: `http://127.0.0.1:${address.port}/api/tasks` };
}

test('returns no-session without invoking export when a task has no saved session', async (context) => {
  const { task, base } = await fixture(context, async () => assert.fail('must not export'));

  const response = await fetch(`${base}/${task.id}/session`);

  const expected: TaskSessionResponse = { taskId: task.id, status: 'no_session' };
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), expected);
});

test('returns uncached 404 when the task does not exist', async (context) => {
  const { base } = await fixture(context, async () => assert.fail('must not export'));

  const response = await fetch(`${base}/missing/session`);

  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'Task not found' });
});

test('binds export only to stored identity and directory when query parameters attempt overrides', async (context) => {
  const sources: SessionExportSource[] = [];
  const { store, task, base } = await fixture(context, async (source) => { sources.push(source); return transcript; });
  store.claim(task.id, 1001);
  store.setSession(task.id, 'ses_stored');

  const response = await fetch(`${base}/${task.id}/session?sessionId=ses_other&directory=/other`);

  const expected: TaskSessionResponse = { taskId: task.id, status: 'ready', transcript };
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), expected);
  assert.deepEqual(sources, [{ sessionId: 'ses_stored', directory: task.directory }]);
});

test('leaves task status untouched when export times out', async (context) => {
  const { store, task, base } = await fixture(context, async () => { throw new SessionExportError('timeout', 'Export timed out'); });
  store.claim(task.id, 1001);
  store.setSession(task.id, 'ses_stored');
  const before = store.get(task.id);

  const response = await fetch(`${base}/${task.id}/session`);

  const expected: TaskSessionResponse = { taskId: task.id, status: 'error', code: 'timeout', error: 'Export timed out' };
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), expected);
  assert.deepEqual(store.get(task.id), before);
});

test('does not export or include transcript data when polling summaries', async (context) => {
  const { task, base } = await fixture(context, async () => assert.fail('summary must not export'));

  const response = await fetch(`${base}/summary`);

  const body = await response.json();
  assert.equal(response.status, 200);
  const { output, ...metadata } = task;
  assert.deepEqual(body.tasks, [{ ...metadata, hasOutput: false }]);
});

for (const mode of ['valid', 'invalid']) {
  test(`serves ${mode} native export through HTTP, SQLite and a real subprocess`, async (context) => {
    const directory = mkdtempSync(join(tmpdir(), 'session-http-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const executable = join(directory, 'opencode');
    copyFileSync(new URL('./fixtures/opencode-export.cjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    const { store, task, base } = await fixture(context, (source) => exportSession(source, {
      executable, env: { EXPORT_DIRECTORY: source.directory, EXPORT_MODE: mode,
        EXPORT_PAYLOAD: JSON.stringify({ info: { id: 'ses_root', title: 'Live export', time: { created: 1000, updated: 2000 } }, messages: [
          { info: { id: 'msg', sessionID: 'ses_root', role: 'assistant', time: { created: 1500, completed: 2000 }, agent: 'build', providerID: 'openai', modelID: 'test' },
            parts: [{ id: 'prt', sessionID: 'ses_root', messageID: 'msg', type: 'text', text: 'internal', synthetic: true }] },
        ] }) },
    }));
    store.claim(task.id, 1001);
    store.setSession(task.id, 'ses_root');

    const response = await fetch(`${base}/${task.id}/session`);

    assert.equal(response.status, mode === 'valid' ? 200 : 502);
    const body = await response.json();
    assert.equal(body.status, mode === 'valid' ? 'ready' : 'error');
    if (mode === 'valid') assert.deepEqual(body.transcript, {
      sessionId: 'ses_root', title: 'Live export', time: { created: 1000, updated: 2000 }, scope: 'root-only', messages: [
        { id: 'msg', role: 'assistant', time: { created: 1500, completed: 2000 }, agent: 'build', providerID: 'openai', modelID: 'test',
          parts: [{ id: 'prt', type: 'text', text: 'internal', synthetic: true }] },
      ],
    });
    else assert.equal(body.code, 'invalid_output');
  });
}
