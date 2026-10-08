import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../src/web/api.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAccounts } from '../src/server/creds.js';
import { buildAccountViews } from '../src/server/accounts-view.js';
import { syncTargetsOf } from '../src/server/clientsync.js';
import { setClientPaths } from '../src/server/clientpaths.js';
import { DEFAULT_ACCOUNT_SETTING, EMPTY_STAT } from '../src/shared/gateway.js';

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
