import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../src/web/api.js';
import { taskApi } from '../src/web/task-api.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAccounts } from '../src/server/creds.js';
import { buildAccountViews } from '../src/server/accounts-view.js';
import { syncTargetsOf } from '../src/server/clientsync.js';
import { setClientPaths } from '../src/server/clientpaths.js';
import { DEFAULT_ACCOUNT_SETTING, EMPTY_STAT } from '../src/shared/gateway.js';
import type { ManagedTask } from '../src/shared/tasks.js';

test('task model discovery uses the current directory and omits a blank fallback', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ models: ['openai/test-model'] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const scoped = await taskApi.models('/work/project name');
    const fallback = await taskApi.models('   ');

    assert.deepEqual(scoped.models, ['openai/test-model']);
    assert.deepEqual(fallback.models, ['openai/test-model']);
    assert.deepEqual(requests, [
      '/api/tasks/models?directory=%2Fwork%2Fproject+name',
      '/api/tasks/models',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sends a task follow-up as JSON to the encoded task URL and returns the resumed task', async (context) => {
  const resumed: ManagedTask & { readonly sessionId: string } = {
    id: 'task /?#',
    description: 'Review the project',
    model: 'openai/test-model',
    directory: '/work/project',
    trigger: { type: 'quota' },
    status: 'running',
    sessionId: 'ses_test',
    createdAt: 1000,
    startedAt: 2000,
    finishedAt: null,
    output: '',
    error: '',
  };
  const message = 'Continue with tests\nPreserve "quoted" details.';
  const originalFetch = globalThis.fetch;
  let request: Request | undefined;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    request = new Request(new URL(String(input), 'http://localhost'), init);
    return Response.json(resumed, { status: 202 });
  };

  const result = await taskApi.sendMessage(resumed.id, message);

  assert.equal(request?.url, 'http://localhost/api/tasks/task%20%2F%3F%23/messages');
  assert.equal(request?.method, 'POST');
  assert.equal(request?.headers.get('content-type'), 'application/json');
  assert.deepEqual(await request?.json(), { message });
  assert.deepEqual(result, resumed);
});

for (const failure of [
  { status: 400, body: JSON.stringify({ error: 'task is not eligible' }), message: 'task is not eligible' },
  { status: 409, body: JSON.stringify({ error: 'another task is running' }), message: 'another task is running' },
  { status: 502, body: 'Bad gateway', message: 'HTTP 502' },
]) {
  test(`reports task follow-up errors for HTTP ${failure.status}`, async (context) => {
    const originalFetch = globalThis.fetch;
    context.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response(failure.body, { status: failure.status });

    await assert.rejects(() => taskApi.sendMessage('task-1', 'Continue'), { message: failure.message });
  });
}

test('propagates task follow-up network failures', async (context) => {
  const originalFetch = globalThis.fetch;
  const failure = new TypeError('Network unavailable');
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw failure; };

  await assert.rejects(() => taskApi.sendMessage('task-1', 'Continue'), failure);
});

test('imports token files as repeated multipart fields', async () => {
  const first = new File(['first'], 'first.json', { type: 'application/json' });
  const second = new File(['second'], 'second.json', { type: 'application/json' });
  const originalFetch = globalThis.fetch;
  let request: Request | undefined;
  let suppliedHeaders: HeadersInit | undefined;

  globalThis.fetch = async (input, init) => {
    suppliedHeaders = init?.headers;
    request = new Request(new URL(String(input), 'http://localhost'), init);
    return new Response(JSON.stringify({ imported: ['first'], skipped: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await api.importTokenFiles([first, second]);

    assert.deepEqual(result, { imported: ['first'], skipped: [] });
    assert.equal(request?.url, 'http://localhost/api/accounts/import-files');
    assert.equal(request?.method, 'POST');
    assert.equal(suppliedHeaders, undefined);
    assert.match(request?.headers.get('content-type') ?? '', /^multipart\/form-data; boundary=/);
    assert.deepEqual(
      [...(await request?.formData() ?? new FormData())].map(([name, value]) => [
        name,
        value instanceof File ? value.name : value,
      ]),
      [
        ['files', 'first.json'],
        ['files', 'second.json'],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reports upload errors using the API error message', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: 'invalid upload' }), { status: 400 });

  try {
    await assert.rejects(() => api.importTokenFiles([]), { message: 'invalid upload' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('account view exposes exactly the Pi paths written by the sync endpoint', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-view-pi-'));
  const configured = join(dir, 'configured', 'auth.json');
  const imported = join(dir, 'imported', 'auth.json');
  setClientPaths({ pi: configured, 'codex-cli': join(dir, 'codex.json'), 'claude-cli': join(dir, 'claude.json') });
  context.after(async () => { setClientPaths({}); await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, 'pi.json'), JSON.stringify({ type: 'claude', source: 'pi', sync_source: 'pi-claude',
    sync_path: imported, access_token: 'pi-access', email: 'pi@example.com' }));
  await writeFile(join(dir, 'normal.json'), JSON.stringify({ type: 'codex', source: 'oauth',
    access_token: 'codex-access', email: 'normal@example.com' }));
  const accounts = await loadAccounts(dir);
  const views = await buildAccountViews(accounts, new Map(), () => null, () => ({
    ...DEFAULT_ACCOUNT_SETTING, ...EMPTY_STAT, state: 'off', inFlight: 0,
    cooldownUntil: null, lastError: '', supported: true, needsPat: false, hasPat: false,
  }));
  for (const account of accounts) {
    const view = views.find((item) => item.id === account.id);
    assert.deepEqual(view?.syncTargets, (await syncTargetsOf(account)).map((target) => target.path));
    if (account.syncSource === 'pi-claude') assert.deepEqual(view.syncTargets, [imported]);
    else assert.ok(view?.syncTargets.includes(configured));
  }
});
