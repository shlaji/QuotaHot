import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { DwsRunner, DwsProcessError } from '../src/dws/runner.js';
import { InboxStore } from '../src/inbox/store.js';
import { InboxService } from '../src/inbox/service.js';
import { createApp } from '../src/http/routes.js';

export const token = 'test-only-inbox-token';
export const target = {
  profileKey: 'dedicated', targetType: 'person', targetId: 'user-id', displayName: 'Person',
  createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
} as const;

export async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'inbox-http-'));
  const path = join(directory, 'inbox.db');
  const store = new InboxStore(path);
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const runner = new DwsRunner({ binary: '/not-executed', profile: 'dedicated', configDir: '/not-read' }, () => {
    throw new DwsProcessError('process_error');
  });
  const service = new InboxService(store, runner, { profileKey: 'dedicated' });
  const app = createApp(service, { bearerToken: token });
  return { app, service, store, path, runner, InboxService, createApp };
}

export const authorization = { Authorization: `Bearer ${token}` } as const;
