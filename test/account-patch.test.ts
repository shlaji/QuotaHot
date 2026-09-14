import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const entry = new URL('../src/main.ts', import.meta.url).pathname;

type RunningServer = {
  readonly base: string;
  readonly stop: () => Promise<void>;
};

function sseEvents(reader: ReadableStreamDefaultReader<Uint8Array>): () => Promise<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  return async () => {
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary < 0) {
        const { done, value } = await reader.read();
        if (done) throw new Error('SSE stream ended before the next event');
        buffer += decoder.decode(value, { stream: true }).replaceAll('\r', '');
        continue;
      }
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('\n');
      if (data) return JSON.parse(data) as unknown;
    }
  };
}

async function expectSseEvent(
  nextEvent: () => Promise<unknown>,
  label: string,
  timeoutMs = 1_000,
): Promise<unknown> {
  return await Promise.race([
    nextEvent(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${label} SSE event`)), timeoutMs)),
  ]);
}

async function expectSseEventType(
  nextEvent: () => Promise<unknown>,
  type: string,
  timeoutMs = 1_000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const event = await expectSseEvent(nextEvent, type, Math.max(1, deadline - Date.now()));
    if ((event as { type?: unknown }).type === type) return event;
  }
}

async function serveOn(dataDir: string): Promise<RunningServer> {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: {
      ...process.env,
      HOME: dataDir,
      XDG_DATA_HOME: dataDir,
      PORT: '0',
      QUOTAHOT_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = await new Promise<string>((resolveBase, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start')), 10_000);
    let text = '';
    const collect = (chunk: string): void => {
      text += chunk;
      const hit = /QuotaHot 已启动: (http:\/\/\S+)/.exec(text);
      if (!hit) return;
      clearTimeout(timeout);
      resolveBase(hit[1]);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
  });
  return {
    base,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    },
  };
}

async function followClientFixture(dataDir: string): Promise<void> {
  const expiresAt = Date.now() + 3_600_000;
  await mkdir(join(dataDir, 'accounts'), { recursive: true });
  await mkdir(join(dataDir, '.claude'), { recursive: true });
  await Promise.all([
    writeFile(
      join(dataDir, 'config.json'),
      JSON.stringify({ clientCheckMinutes: 0, usageRefreshMinutes: 0 }),
      'utf8',
    ),
    writeFile(
      join(dataDir, 'accounts', 'claude-a.json'),
      JSON.stringify({
        type: 'claude',
        email: 'a@example.com',
        access_token: 'client-token',
        refresh_token: 'refresh-token',
        expired: new Date(expiresAt).toISOString(),
        source: 'claude-cli',
        auto_refresh: true,
      }),
      'utf8',
    ),
    writeFile(
      join(dataDir, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'client-token', expiresAt } }),
      'utf8',
    ),
    writeFile(join(dataDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }), 'utf8'),
  ]);
}

test('PATCH sync-only mode immediately refreshes the account snapshot', async (context) => {
  // Given: a matching Claude Code session, but client polling disabled so the PATCH owns the first scan.
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-account-patch-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await followClientFixture(dataDir);
  const server = await serveOn(dataDir);
  context.after(server.stop);

  // When: the user switches the account to follow the matching client.
  const changed = await fetch(`${server.base}/api/accounts/claude%3Aa%40example.com`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ autoRefresh: false }),
  });

  // Then: the snapshot has the persisted mode and client-use state without waiting for the polling interval.
  assert.equal(changed.status, 200);
  const state = await fetch(`${server.base}/api/state`);
  const snapshot = await state.text();
  assert.match(snapshot, /"autoRefresh":false/);
  assert.match(snapshot, /"inUseBy":\[{"source":"claude-cli"/);
});

test('sync-to-client publishes an account snapshot when client identity is unchanged', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-sync-sse-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await followClientFixture(dataDir);
  const server = await serveOn(dataDir);
  context.after(server.stop);

  const accountId = 'claude%3Aa%40example.com';
  const follow = await fetch(`${server.base}/api/accounts/${accountId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ autoRefresh: false }),
  });
  assert.equal(follow.status, 200);

  const controller = new AbortController();
  context.after(() => controller.abort());
  const events = await fetch(`${server.base}/api/events`, { signal: controller.signal });
  assert.ok(events.body);
  const reader = events.body.getReader();
  const nextEvent = sseEvents(reader);
  await expectSseEventType(nextEvent, 'accounts');
  await expectSseEventType(nextEvent, 'scheduler');

  const synced = await fetch(`${server.base}/api/accounts/${accountId}/sync-to-client`, { method: 'POST' });
  assert.equal(synced.status, 200);

  await expectSseEventType(nextEvent, 'accounts', 1_000);
});
