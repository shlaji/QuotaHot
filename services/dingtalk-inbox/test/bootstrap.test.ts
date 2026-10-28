import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/http/server.js';
import { defaultDatabasePath, InboxStore } from '../src/inbox/store.js';

test('starts an independent health endpoint without QuotaHot and closes cleanly', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dingtalk-inbox-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await startServer({ hostname: '127.0.0.1', port: 0 });
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === 'string' || !('port' in address)) throw new Error('Server did not bind a TCP port');
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });

  const store = new InboxStore(join(directory, 'inbox.db'));
  t.after(() => store.close());
  store.writeBootstrapMarker('standalone');
  assert.equal(store.readBootstrapMarker(), 'standalone');
  assert.equal(defaultDatabasePath(directory), join(directory, 'inbox.db'));
});
