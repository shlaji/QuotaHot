import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/server/store.js';
import { buildCurl, fillSecrets, maskSecrets } from '../src/shared/curl.js';
import type { RequestLogPage } from '../src/shared/types.js';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { basename } from 'node:path';
import { WECHAT_DB_PATH } from '../src/server/config.js';
import { WechatSessionStore } from '../src/server/wechat-session-store.js';
import { WechatInboxStore } from '../src/server/wechat-inbox/store.js';

const entry = new URL('../src/main.ts', import.meta.url).pathname;
const networkBarrier = `data:text/javascript,${encodeURIComponent(`
  import { Socket } from 'node:net';
  import fs from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function (path, ...args) {
    if (String(path).endsWith('/wechat/system-config.json')) {
      console.error('TEST_LEGACY_CONFIG_READ');
      throw new Error('Legacy config must not be read');
    }
    return readFileSync.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  const connect = Socket.prototype.connect;
  Socket.prototype.connect = function (...args) {
    const target = Array.isArray(args[0]) ? args[0][0] : args[0];
    if ((typeof target === 'string' && target.startsWith('/')) || target?.path) {
      return connect.apply(this, args);
    }
    console.error('TEST_OUTBOUND_BLOCKED');
    throw new Error('Test outbound network disabled');
  };
`)}`;

type CliResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

async function terminateChild(
  child: ReturnType<typeof spawn>,
  closed: Promise<void>,
  graceMs = 2_000,
  signal: 'SIGINT' | 'SIGTERM' = 'SIGTERM',
): Promise<void> {
  child.kill(signal);
  const waitForClose = async (): Promise<boolean> => {
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolveDeadline) => {
      timeout = setTimeout(() => resolveDeadline(false), graceMs);
    });
    const didClose = await Promise.race([closed.then(() => true), timedOut]);
    if (timeout) clearTimeout(timeout);
    return didClose;
  };
  if (await waitForClose()) return;
  child.kill('SIGKILL');
  if (!await waitForClose()) throw new Error('child process did not close');
}

function waitForReady(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  const stdout = child.stdout;
  assert.ok(stdout);
  return new Promise<void>((resolveReady, rejectReady) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      stdout.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
    };
    const settle = (error?: Error): void => {
      cleanup();
      if (error) rejectReady(error);
      else resolveReady();
    };
    const onData = (): void => settle();
    const onError = (): void => settle(new Error('child process failed before readiness'));
    const onClose = (): void => settle(new Error('child process closed before readiness'));
    const timeout = setTimeout(() => settle(new Error('child process readiness timed out')), timeoutMs);
    stdout.once('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

function cli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolveResult) => {
    execFile(process.execPath, ['--import', 'tsx', entry, ...args], { timeout: 5_000 }, (error, stdout, stderr) => {
      resolveResult({ code: error?.code === undefined ? 0 : Number(error.code), stdout, stderr });
    });
  });
}

async function startsServer(args: readonly string[], dataDir: string): Promise<string> {
  const server = await serveOn(dataDir, {}, args);
  const output = server.output();
  await server.kill();
  return output;
}

test('help exits successfully without starting the server', async () => {
  // Given: the main distribution entrypoint.
  // When: a user requests help.
  const result = await cli(['--help']);
  // Then: usage is printed and the process exits instead of listening.
  assert.equal(result.code, 0);
  assert.match(result.stdout, /quotahot \[serve\]/);
  assert.doesNotMatch(result.stdout, /已启动/);
});

test('terminateChild escalates to SIGKILL when the child ignores SIGTERM', async () => {
  // Given: a real child process whose SIGTERM handler deliberately keeps it alive.
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready\\n');"], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
  let termination: Promise<void> | undefined;
  const cleanup = (): Promise<void> => termination ??= terminateChild(child, closed, 20);
  try {
    await waitForReady(child, 1_000);
    // When: the test-local terminator gets a short grace period before escalation.
    await cleanup();

    // Then: completion is observed through close after SIGKILL escalation.
    assert.equal(child.signalCode, 'SIGKILL');
  } finally {
    await cleanup();
  }
});

test('waitForReady rejects when the child closes before emitting readiness', async (context) => {
  // Given: a child process that exits without writing readiness output.
  const child = spawn(process.execPath, ['-e', 'process.exit(1)'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
  let termination: Promise<void> | undefined;
  const cleanup = (): Promise<void> => termination ??= terminateChild(child, closed);
  context.after(cleanup);

  // When: readiness is awaited.
  const waiting = waitForReady(child, 1_000);

  // Then: the close event rejects promptly with a fixed error.
  await assert.rejects(waiting, { message: 'child process closed before readiness' });
});

test('unknown command exits with usage error without starting the server', async () => {
  // Given: an argument that is not part of the main program's command surface.
  // When: command dispatch runs.
  const result = await cli(['hook']);
  // Then: it exits 2 and does not fall through to the service.
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown command: hook/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /已启动/);
});

test('no arguments starts the service', async (context) => {
  // Given: an isolated data directory and ephemeral port.
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-main-noargs-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  // When: the main program runs without arguments.
  const output = await startsServer([], dataDir);
  // Then: the HTTP service starts.
  assert.match(output, /QuotaHot 已启动:/);
});

test('serve explicitly starts the service', async (context) => {
  // Given: an isolated data directory and ephemeral port.
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-main-serve-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  // When: the serve command is explicit.
  const output = await startsServer(['serve'], dataDir);
  // Then: the HTTP service starts.
  assert.match(output, /QuotaHot 已启动:/);
});

test('serveOn rejects promptly and cleans up when the child exits before its startup banner', async (context) => {
  // Given: an invalid port that makes the real entrypoint exit before announcing readiness.
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-main-invalid-port-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));

  // When: the test startup helper waits for readiness.
  const startup = serveOn(dataDir, { PORT: '65536' });
  const result = await Promise.race([
    startup.then(() => 'resolved', (error: unknown) => error),
    new Promise<'pending'>((resolveResult) => setTimeout(() => resolveResult('pending'), 3_000)),
  ]);

  // Then: the closed child is reaped and the rejection is fixed and non-sensitive.
  assert.notEqual(result, 'pending', 'startup failure must not leave child pipes or close pending');
  assert.ok(result instanceof Error);
  assert.equal(result.message, 'child process failed before readiness');
});

test('WeChat legacy config is not mounted, read or mutated across restart', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-wechat-config-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const secretKey = `synthetic-${crypto.randomUUID()}`;
  const replacementSentinels = [crypto.randomUUID(), crypto.randomUUID()];
  const configPath = join(dataDir, 'wechat', 'system-config.json');
  await mkdir(join(dataDir, 'wechat'), { recursive: true });
  const contents = `${JSON.stringify({ appId: 'legacy-app', secretKey })}\n`;
  await writeFile(configPath, contents, { mode: 0o640 });
  const original = await stat(configPath);
  const first = await serveOn(dataDir);
  try {
    const saved = await fetch(`${first.base}/api/wechat/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: 'legacy-app', secretKey }),
    });
    assert.equal(saved.status, 404);
    const body = await saved.text();
    assert.ok(!body.includes(secretKey), 'dedicated PUT must not disclose credentials');
    assert.equal(body, '404 Not Found');
    const removed = await fetch(`${first.base}/api/wechat/config`);
    assert.equal(removed.status, 404);
    assert.equal(await removed.text(), '404 Not Found');
    for (const path of ['/api/config', '/api/state', '/api/logs']) {
      const response = await fetch(`${first.base}${path}`);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(!text.includes(secretKey), 'read responses must not disclose credentials');
    }
    for (const [extra, sentinel] of [
      [{}, ''],
      [{ secretKey: '', 'Secret-Key': '', wechat: null }, replacementSentinels[0]],
      [{ secretKey, 'Secret-Key': secretKey, wechat: { appId: 'replacement', secretKey } }, replacementSentinels[1]],
    ] as const) {
      const response = await fetch(`${first.base}/api/config`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'integration-update', usageRefreshMinutes: 0, clientCheckMinutes: 0,
          ...(sentinel ? { replacementSecretKey: sentinel, nested: { wechat: { secretKey: sentinel } } } : {}), ...extra }),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(!text.includes(secretKey), 'generic PUT must not echo unknown credentials');
      assert.ok(!sentinel || !text.includes(sentinel), 'generic PUT must not echo replacement credentials');
      const responseConfig: unknown = JSON.parse(text);
      assert.ok(typeof responseConfig === 'object' && responseConfig !== null && 'text' in responseConfig
        && responseConfig.text === 'integration-update');
      assert.ok(!JSON.stringify(responseConfig).includes('secretKey') && !JSON.stringify(responseConfig).includes('Secret-Key'));
      assert.ok(!sentinel || !JSON.stringify(responseConfig).includes(sentinel));
      assert.equal(await readFile(configPath, 'utf8'), contents);
      const status = await fetch(`${first.base}/api/wechat/config`);
      assert.equal(status.status, 404);
      const statusBody = await status.text();
      assert.ok(!statusBody.includes(secretKey), 'generic update must not disclose private credentials');
      assert.ok(!sentinel || !statusBody.includes(sentinel), 'WeChat status must not echo replacement credentials');
      assert.equal(statusBody, '404 Not Found');
    }
    const retained = await fetch(`${first.base}/api/wechat/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: 'legacy-app', secretKey: '' }),
    });
    assert.equal(retained.status, 404);
    const retainedBody = await retained.text();
    assert.ok(!retainedBody.includes(secretKey), 'blank-secret update must not disclose credentials');
    assert.equal(retainedBody, '404 Not Found');
  } finally {
    await first.kill();
    const output = first.output();
    assert.ok(![secretKey, ...replacementSentinels].some((sentinel) => output.includes(sentinel)),
      'process logs must not disclose credential values');
  }

  const restarted = await serveOn(dataDir);
  try {
    const status = await fetch(`${restarted.base}/api/wechat/config`);
    assert.equal(status.status, 404);
    const statusBody = await status.text();
    assert.ok(!statusBody.includes(secretKey), 'dedicated GET must remain private after restart');
    assert.equal(statusBody, '404 Not Found');
    const persisted: unknown = JSON.parse(await readFile(join(dataDir, 'wechat', 'system-config.json'), 'utf8'));
    assert.ok(typeof persisted === 'object' && persisted !== null && 'secretKey' in persisted
      && persisted.secretKey === secretKey, 'restart must preserve the original private credential');
    for (const path of ['/api/config', '/api/state', '/api/logs']) {
      const response = await fetch(`${restarted.base}${path}`);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(!text.includes(secretKey), 'generic reads must remain private after config updates and restart');
      assert.ok(!text.includes('secretKey') && !text.includes('Secret-Key'), 'unknown fields must not persist');
    }
    assert.ok(!(await readFile(join(dataDir, 'config.json'), 'utf8')).includes(secretKey));
    const after = await stat(configPath);
    assert.equal(await readFile(configPath, 'utf8'), contents);
    assert.equal(after.mode, original.mode);
    assert.equal(after.mtimeMs, original.mtimeMs);
    assert.equal(after.ctimeMs, original.ctimeMs);
  } finally {
    await restarted.kill();
    const output = restarted.output();
    assert.ok(![secretKey, ...replacementSentinels].some((sentinel) => output.includes(sentinel)),
      'restart logs must not disclose credential values');
  }
  assert.doesNotMatch(`${first.output()}${restarted.output()}`, /TEST_LEGACY_CONFIG_READ/);
});

test('WeChat QR routes retain Web auth and cross-site protection', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-wechat-config-auth-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const server = await serveOn(dataDir, {
    QUOTAHOT_AUTH_USERNAME: 'wechat-test', QUOTAHOT_AUTH_PASSWORD: 'local-test-password',
  });
  context.after(() => server.kill());
  const authorization = `Basic ${Buffer.from('wechat-test:local-test-password').toString('base64')}`;
  for (const [path, method] of [['/api/wechat/qrcode', 'POST'], ['/api/wechat/qrcode/unknown', 'GET'],
    ['/api/wechat/qrcode/unknown', 'DELETE'], ['/api/wechat-inbox/bindings', 'GET'],
    ['/api/wechat/bindings/unknown', 'DELETE']]) {
    const denied = await fetch(`${server.base}${path}`, { method });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate') ?? '', /^Basic /);
    for (const [name, value] of [['origin', 'https://external.invalid'], ['sec-fetch-site', 'cross-site']]) {
      const response = await fetch(`${server.base}${path}`, {
        method, headers: { authorization, [name]: value },
      });
      assert.equal(response.status, 403);
    }
  }
  const allowed = await fetch(`${server.base}/api/wechat/qrcode/unknown`, { headers: { authorization } });
  assert.equal(allowed.status, 404);
  assert.equal(allowed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await allowed.json(), { status: 'unavailable' });
  const inbox = await fetch(`${server.base}/api/wechat-inbox/bindings`, { headers: { authorization } });
  assert.equal(inbox.status, 200);
  assert.deepEqual(await inbox.json(), []);
  const saved = await fetch(`${server.base}/api/wechat/qrcode/unknown`, {
    method: 'DELETE', headers: { authorization, origin: server.base },
  });
  assert.equal(saved.status, 404);
  assert.deepEqual(await saved.json(), { status: 'unavailable' });
});

test('inbox restart recovers active owners and interrupted sends but preserves persisted pause and unlink history', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-inbox-recovery-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const sessionPath = join(dataDir, 'wechat', basename(WECHAT_DB_PATH));
  const inboxPath = join(dataDir, 'wechat', 'inbox.db');
  const sessions = new WechatSessionStore(sessionPath);
  const inbox = new WechatInboxStore(inboxPath);
  const time = Date.now();
  for (const owner of ['active', 'unlink', 'other']) {
    const binding = { ownerIlinkUserId: owner, botId: `bot-${owner}`, botToken: `synthetic-${owner}`, baseUrl: 'https://api.test' };
    sessions.saveBinding(binding, time);
    inbox.saveBinding(binding, new Date(time).toISOString());
    inbox.saveBatch(owner, { nextCursor: `cursor-${owner}`, messages: [{
      remoteMessageId: null, clientId: `pending-${owner}`,
      direction: 'outbound', messageType: 2, kind: 'text', state: 'sending',
      createdAt: new Date(time).toISOString(), runId: null, items: [{ kind: 'text', text: 'retained' }],
    }] });
  }
  inbox.saveBatch('other', { nextCursor: 'cursor-other', messages: [{
    remoteMessageId: 'own-inbound', clientId: null, direction: 'inbound', messageType: 1, kind: 'text', state: 'received',
    contextToken: 'synthetic-own-context', createdAt: new Date(time).toISOString(), runId: null,
    items: [{ kind: 'text', text: 'own inbound history' }],
  }] });
  sessions.close();
  inbox.close();
  const first = await serveOn(dataDir);
  try {
    const bindings = await (await fetch(`${first.base}/api/wechat-inbox/bindings`)).json();
    assert.equal(bindings.length, 3);
    assert.ok(bindings.every((binding: { connectionState: string }) => binding.connectionState !== 'stopped'));
    const verifiedContext = bindings.find((binding: { ownerIlinkUserId: string }) => binding.ownerIlinkUserId === 'other');
    assert.equal(verifiedContext?.replyContextState, 'ready');
    assert.equal(Object.hasOwn(verifiedContext ?? {}, 'messagingReadiness'), false);
    for (const [suffix, body] of [['messages', { kind: 'text', text: 'blocked' }], ['typing', { status: 'typing' }]] as const) {
      const denied = await fetch(`${first.base}/api/wechat-inbox/bindings/active/${suffix}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(denied.status, 409);
      assert.deepEqual(await denied.json(), { error: 'wechat_inbox_context_required' });
    }
    assert.equal((await fetch(`${first.base}/api/wechat/bindings/unlink`, {
      method: 'DELETE',
    })).status, 200);
    for (const [suffix, body] of [['messages', { kind: 'text', text: 'blocked' }], ['typing', { status: 1 }]] as const) {
      const denied = await fetch(`${first.base}/api/wechat-inbox/bindings/unlink/${suffix}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(denied.status, 409);
      assert.deepEqual(await denied.json(), { error: 'wechat_inbox_binding_read_only' });
    }
    const other = await (await fetch(`${first.base}/api/wechat-inbox/bindings`)).json();
    assert.notEqual(other.find((binding: { ownerIlinkUserId: string }) => binding.ownerIlinkUserId === 'other')?.connectionState, 'stopped');
  } finally { await first.kill(); }
  const paused = new WechatSessionStore(sessionPath);
  paused.pauseBinding('active');
  paused.close();
  const restarted = await serveOn(dataDir);
  try {
    const bindings: { ownerIlinkUserId: string; connectionState: string; canSend: boolean }[] =
      await (await fetch(`${restarted.base}/api/wechat-inbox/bindings`)).json();
    assert.equal(bindings.find((binding) => binding.ownerIlinkUserId === 'active')?.connectionState, 'stopped');
    assert.equal(bindings.find((binding) => binding.ownerIlinkUserId === 'active')?.canSend, false);
    assert.equal(bindings.find((binding) => binding.ownerIlinkUserId === 'unlink')?.connectionState, 'unlinked');
    assert.notEqual(bindings.find((binding) => binding.ownerIlinkUserId === 'other')?.connectionState, 'stopped');
  } finally { await restarted.kill('SIGINT'); }
  const recovered = new WechatInboxStore(inboxPath);
  const persisted = new WechatSessionStore(sessionPath);
  try {
    for (const owner of ['active', 'unlink', 'other']) {
      assert.equal(recovered.listMessages(owner).items[0]?.state, 'unknown');
      assert.equal(recovered.getCursor(owner), `cursor-${owner}`);
    }
    assert.equal(persisted.isBindingPaused('active'), true);
    assert.ok(persisted.getBinding('active'));
    assert.equal(persisted.getBinding('unlink'), null);
    assert.ok(recovered.getBinding('unlink')?.unlinkedAt);
    assert.doesNotMatch(`${first.output()}${restarted.output()}`, /database is closed|SQLITE_MISUSE|synthetic-/i);
  } finally { recovered.close(); persisted.close(); }
});

test('legacy browser session rows remain inert and unchanged across real server restarts', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-wechat-legacy-session-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(join(dataDir, 'wechat'), { recursive: true });
  const path = join(dataDir, 'wechat', basename(WECHAT_DB_PATH));
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE wechat_sessions (token_hash TEXT PRIMARY KEY, owner_ilink_user_id TEXT,
    created_at TEXT, expires_at TEXT);`);
  const token = 'legacy-browser-token';
  db.prepare('INSERT INTO wechat_sessions VALUES (?, ?, ?, ?)').run(
    createHash('sha256').update(token).digest('hex'), 'legacy-owner', new Date().toISOString(), '9999-01-01T00:00:00.000Z');
  const rows = db.prepare('SELECT * FROM wechat_sessions').all();
  db.close();

  for (let restart = 0; restart < 2; restart++) {
    const server = await serveOn(dataDir);
    try {
      for (const [path, method] of [['session', 'GET'], ['session', 'DELETE'], ['binding', 'GET'],
        ['binding', 'DELETE'], ['binding/check', 'POST']] as const) {
        const response = await fetch(`${server.base}/api/wechat/${path}`, {
          method, headers: { cookie: `quotahot_wechat=${token}` },
        });
        assert.equal(response.status, 404);
        assert.equal(response.headers.get('set-cookie'), null);
      }
    } finally { await server.kill(); }
    const persisted = new DatabaseSync(path);
    assert.deepEqual(persisted.prepare('SELECT * FROM wechat_sessions').all(), rows);
    persisted.close();
  }
});

test('WeChat QR reaches upstream without private system configuration', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-wechat-local-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const server = await serveOn(dataDir);
  context.after(() => server.kill());
  const response = await fetch(`${server.base}/api/wechat/qrcode`, { method: 'POST' });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'wechat_upstream_unavailable' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  await server.kill();
  assert.ok(server.output().includes('TEST_OUTBOUND_BLOCKED'), 'QR creation must reach the network barrier without config');
  assert.doesNotMatch(server.output(), /TEST_LEGACY_CONFIG_READ/);
});

test('WeChat QR ignores existing legacy credentials with outbound networking blocked', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-wechat-signed-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const secretKey = crypto.randomUUID();
  const configPath = join(dataDir, 'wechat', 'system-config.json');
  await mkdir(join(dataDir, 'wechat'), { recursive: true });
  const contents = JSON.stringify({ appId: 'legacy-app', secretKey });
  await writeFile(configPath, contents);
  const server = await serveOn(dataDir);
  context.after(() => server.kill());
  const response = await fetch(`${server.base}/api/wechat/qrcode`, { method: 'POST' });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'wechat_upstream_unavailable' });
  await server.kill();
  assert.ok(server.output().includes('TEST_OUTBOUND_BLOCKED'), 'configured transport must reach the network barrier');
  assert.ok(!server.output().includes(secretKey), 'transport failure logs must remain private');
  assert.doesNotMatch(server.output(), /TEST_LEGACY_CONFIG_READ/);
  assert.equal(await readFile(configPath, 'utf8'), contents);
});

test('production binding management uses Web Basic Auth without cookies and keeps /v1 outside it', async (context) => {
  // Given: the real server runs with isolated data and Web Basic Auth enabled.
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-wechat-auth-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const server = await serveOn(dataDir, {
    QUOTAHOT_AUTH_USERNAME: 'wechat-test',
    QUOTAHOT_AUTH_PASSWORD: 'local-test-password',
  });
  context.after(() => server.kill());

  // When: a caller requests unlink without auth and then with valid Basic Auth.
  const unauthenticated = await fetch(`${server.base}/api/wechat/bindings/missing`, { method: 'DELETE' });
  const authenticated = await fetch(`${server.base}/api/wechat/bindings/missing`, {
    method: 'DELETE',
    headers: { authorization: `Basic ${Buffer.from('wechat-test:local-test-password').toString('base64')}` },
  });
  const gateway = await fetch(`${server.base}/v1/models`);

  // Then: the route requires Basic Auth, returns the missing binding error once authenticated,
  // and the gateway route never gets a Basic Auth challenge.
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get('www-authenticate') ?? '', /^Basic /);
  assert.equal(authenticated.status, 404);
  assert.deepEqual(await authenticated.json(), { error: 'wechat_binding_not_found' });
  assert.equal(gateway.headers.get('www-authenticate'), null);
  assert.notEqual(gateway.status, 401);
});

/**
 * 同 startsServer，但一直读到 `marker` 出现为止。
 *
 * startsServer 见到「已启动」就收工，而自动启动那几行是在它之后才打出来的，
 * 拿它去断言只会读到半截输出。
 */
async function outputUntil(dataDir: string, marker: RegExp, graceMs = 0): Promise<string> {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: { ...process.env, PORT: '0', QUOTAHOT_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  let markerFound = false;
  const closed = new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
  let termination: Promise<void> | undefined;
  const terminate = (): Promise<void> => termination ??= terminateChild(child, closed);
  let timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await new Promise<string>((resolveOutput, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        void terminate().then(
          () => reject(new Error('未能在期限内启动服务')),
          () => reject(new Error('未能在期限内启动服务')),
        );
      }, 10_000);
      const collect = (chunk: string): void => {
        text += chunk;
        if (markerFound || !marker.test(text)) return;
        markerFound = true;
        void (async () => {
          await new Promise<void>((resolveGrace) => setTimeout(resolveGrace, graceMs));
          await terminate();
          resolveOutput(text);
        })().catch(reject);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('error', () => reject(new Error('child process failed')));
      child.once('close', () => {
        if (!markerFound && !timedOut) reject(new Error('process closed before expected startup marker'));
      });
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    await terminate();
  }
}

/**
 * 进程起来之后按上次的意图把调度恢复起来。
 *
 * 少了这一步，`Restart=always` 只保证 Web 服务活着：崩溃或重启之后保活循环停在那儿，
 * 要等有人打开界面点一次启动，而界面上每个账户的「下次发送」倒计时照走不误，
 * 所以这件事没人看得出来。
 */
test('autoStart 为真时，进程起来就自动恢复调度', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-autostart-on-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(
    join(dataDir, 'config.json'),
    JSON.stringify({ autoStart: true, autoStartIds: [] }),
    'utf8',
  );

  const output = await outputUntil(dataDir, /自动启动调度:/);
  assert.match(output, /自动启动: 开/);
  assert.match(output, /自动启动调度: 全部可保活账户/);
});

test('只跑过选中账户的，重启之后也只恢复那几个', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-autostart-ids-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(
    join(dataDir, 'config.json'),
    JSON.stringify({ autoStart: true, autoStartIds: ['codex:a@x.com'] }),
    'utf8',
  );

  const output = await outputUntil(dataDir, /自动启动调度:/);
  // 悄悄扩成全部，等于替用户给他没打算保活的账户也发了
  assert.match(output, /自动启动调度: codex:a@x\.com/);
});

test('没点过启动的全新安装不自动跑', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-autostart-off-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));

  // 「自动启动: 关」是启动横幅的最后一行，等到它再多给一会儿，足以看出后面没有动作
  const output = await outputUntil(dataDir, /自动启动: 关/, 500);
  assert.doesNotMatch(output, /自动启动调度:/);
});

/** 起一个服务并让它一直跑着，返回它的地址；调用方负责在 context.after 里收掉。 */
async function serveOn(
  dataDir: string,
  extraEnv: Readonly<Record<string, string>> = {},
  args: readonly string[] = [],
): Promise<{ base: string; output: () => string; kill: (signal?: 'SIGINT' | 'SIGTERM') => Promise<void> }> {
  let output = '';
  const child = spawn(process.execPath, ['--import', networkBarrier, '--import', 'tsx', entry, ...args], {
    env: {
      ...process.env, PORT: '0', QUOTAHOT_HOST: '127.0.0.1', QUOTAHOT_DATA_DIR: dataDir,
      HOME: dataDir, CODEX_HOME: join(dataDir, '.codex'),
      XDG_CONFIG_HOME: join(dataDir, '.config'), XDG_DATA_HOME: join(dataDir, '.local', 'share'),
      QUOTAHOT_AUTH_USERNAME: '', QUOTAHOT_AUTH_PASSWORD: '', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
  let termination: Promise<void> | undefined;
  const terminate = (signal: 'SIGINT' | 'SIGTERM' = 'SIGTERM'): Promise<void> => termination ??= terminateChild(child, closed, 2000, signal);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let text = '';
  const collect = (chunk: string): void => {
    output += chunk;
    text += chunk;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let base: string;
  try {
    base = await new Promise<string>((resolveBase, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        if (timeout) clearTimeout(timeout);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        child.off('error', onError);
        child.off('close', onClose);
      };
      const settle = (error?: Error, value?: string): void => {
        cleanup();
        if (error) reject(error);
        else if (value) resolveBase(value);
      };
      const onData = (): void => {
        const hit = /QuotaHot 已启动: (http:\/\/\S+)/.exec(text);
        if (hit) settle(undefined, hit[1]);
      };
      const onError = (): void => settle(new Error('child process failed before readiness'));
      const onClose = (): void => settle(new Error('child process closed before readiness'));
      timeout = setTimeout(() => settle(new Error('child process readiness timed out')), 10_000);
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', onError);
      child.once('close', onClose);
      onData();
    });
  } catch {
    await terminate().catch(() => undefined);
    throw new Error('child process failed before readiness');
  }
  return {
    base,
    output: () => output,
    kill: async (signal) => {
      await terminate(signal);
      assert.equal(child.exitCode, 0, 'server must finish graceful shutdown without signal escalation');
    },
  };
}

/**
 * 一个能被调度纳入、但这次用例里不会真去碰网络的账户目录。
 *
 * 下一拍预先排到明天：调度一起来就走「重启续跑」那条路直接进等待，
 * 不会去查额度也不会发送，用例因此不依赖任何外部服务。
 */
async function dataDirWithIdleAccount(dataDir: string): Promise<void> {
  await mkdir(join(dataDir, 'accounts'), { recursive: true });
  await writeFile(
    join(dataDir, 'accounts', 'codex-a.json'),
    JSON.stringify({
      type: 'codex',
      email: 'a@example.com',
      account_id: 'acct-1',
      access_token: 'not-a-real-token',
      refresh_token: 'not-a-real-token',
      expired: new Date(Date.now() + 86_400_000).toISOString(),
    }),
    'utf8',
  );
  const store = new Store(join(dataDir, 'state.db'));
  const tomorrow = Date.now() + 86_400_000;
  store.setNextDue('codex:a@example.com', tomorrow, tomorrow);
  store.close();
}

const readConfig = async (dataDir: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;

/**
 * 走一遍用户真正会做的那串操作：点启动 -> 存一次设置 -> 进程重启。
 *
 * 三处各自都可能把 autoStart 弄丢，而弄丢之后界面上什么都看不出来——倒计时照走，
 * 只是没有任何一条真的会发出去。
 */
test('点过启动之后，存设置不会弄丢它，重启进程调度自己回来', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-autostart-trip-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await dataDirWithIdleAccount(dataDir);

  const first = await serveOn(dataDir);
  try {
    const started = await fetch(`${first.base}/api/scheduler/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    });
    assert.equal((await started.json()).running, true, '前提：这个账户确实被纳入了调度');
    assert.equal((await readConfig(dataDir)).autoStart, true, '点过启动就该记下来');

    // 界面上存一次设置。请求体里压根没有 autoStart，服务端不该因此把它清掉
    const saved = await fetch(`${first.base}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', dailyStart: '06:00', dailyEnd: '23:00' }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).text, 'hello', '前提：这次保存确实生效了');
    assert.equal((await readConfig(dataDir)).autoStart, true, '存设置不该把自动启动一起关掉');
  } finally {
    // SIGTERM 里那次 stop() 是进程在收尾，不是用户按的停止，不该改 autoStart
    await first.kill();
  }
  assert.equal((await readConfig(dataDir)).autoStart, true, 'SIGTERM 不该关掉自动启动');

  // 换个进程再来一遍，就是 systemd 把它拉起来时的样子
  const output = await outputUntil(dataDir, /自动启动调度:/);
  assert.match(output, /自动启动调度: 全部可保活账户/);
});

test('用户自己按的停止会记下来，重启之后不再自动跑', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-autostart-stop-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await dataDirWithIdleAccount(dataDir);

  const server = await serveOn(dataDir);
  try {
    await fetch(`${server.base}/api/scheduler/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    });
    assert.equal((await readConfig(dataDir)).autoStart, true, '前提：先得是跑着的');

    await fetch(`${server.base}/api/scheduler/stop`, { method: 'POST' });
    assert.equal((await readConfig(dataDir)).autoStart, false, '按了停止就不该再自己跑起来');
  } finally {
    await server.kill();
  }

  const output = await outputUntil(dataDir, /自动启动: 关/, 500);
  assert.doesNotMatch(output, /自动启动调度:/);
});

test('账户排序更新会持久化并保留其他配置字段', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-account-order-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const server = await serveOn(dataDir);

  try {
    const response = await fetch(`${server.base}/api/account-order`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude', ids: ['account-c', 'account-a', 'account-c'] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).accountOrder, {
      claude: ['account-c', 'account-a'],
    });

    const saved = await readConfig(dataDir);
    assert.deepEqual(saved.accountOrder, { claude: ['account-c', 'account-a'] });
    assert.equal(saved.text, 'hi');
    assert.equal(saved.dailyStart, '06:00');
    assert.equal(saved.gateway !== undefined, true);

    const malformed = await fetch(`${server.base}/api/account-order`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude', ids: 'account-a' }),
    });
    assert.equal(malformed.status, 400);
  } finally {
    await server.kill();
  }
});

test('Qoder 混合请求日志分别用 PAT 和 OAuth 回放', async (context) => {
  // Given: a Qoder catalog request masked with its gateway PAT and an account OAuth token.
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-qoder-request-log-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const accountId = 'qoder:catalog@example.test';
  const gatewayPat = 'synthetic-current-qoder-gateway-pat';
  const oauthToken = 'synthetic-qoder-account-oauth-token';
  await mkdir(join(dataDir, 'accounts'), { recursive: true });
  await writeFile(
    join(dataDir, 'accounts', 'qoder-catalog.json'),
    JSON.stringify({
      type: 'qoder',
      email: 'catalog@example.test',
      account_id: 'qoder-user',
      user_id: 'qoder-user',
      access_token: oauthToken,
      refresh_token: '',
      expired: new Date(Date.now() + 86_400_000).toISOString(),
    }),
    'utf8',
  );
  const store = new Store(join(dataDir, 'state.db'));
  store.setGatewayAccount(accountId, { pat: gatewayPat });
  store.recordRequest(
    accountId,
    Date.now(),
    maskSecrets(
      {
        method: 'GET',
        url: 'https://api.qoder.com/api/v1/cloud/models',
        headers: { authorization: `Bearer ${gatewayPat}` },
        body: '',
      },
      { accessToken: gatewayPat, accessTokenPlaceholder: '$QUOTAHOT_GATEWAY_TOKEN' },
    ),
    200,
    1,
    '',
  );
  for (const path of ['/api/v2/quota/usage', '/api/v2/user/plan']) {
    store.recordRequest(accountId, Date.now(), maskSecrets({
      method: 'GET', url: `https://openapi.qoder.sh${path}`,
      headers: { authorization: `Bearer ${oauthToken}` }, body: '',
    }, { accessToken: oauthToken }), 200, 1, '');
  }
  store.close();
  const server = await serveOn(dataDir);
  context.after(() => server.kill());

  // When: the user requests the log page and copies its first curl.
  const response = await fetch(`${server.base}/api/accounts/${encodeURIComponent(accountId)}/requests`);
  const page = (await response.json()) as RequestLogPage;
  const row = page.rows.find((entry) => entry.url.includes('/cloud/models'));
  assert.ok(row, '前提：目录请求应留在请求日志中');
  const copiedCurl = buildCurl(fillSecrets(row, page.secrets));

  // Then: the copied request restores the gateway PAT, never the account OAuth token.
  assert.equal(response.status, 200);
  assert.ok(copiedCurl.includes(gatewayPat));
  assert.ok(!copiedCurl.includes(oauthToken));
  const oauthRows = page.rows.filter((entry) => entry.url.startsWith('https://openapi.qoder.sh/'));
  assert.equal(oauthRows.length, 2);
  for (const oauthRow of oauthRows) {
    const oauthCurl = buildCurl(fillSecrets(oauthRow, page.secrets));
    assert.ok(oauthCurl.includes(oauthToken));
    assert.ok(!oauthCurl.includes(gatewayPat));
  }
});

/**
 * 导入弹窗里那一行路径是可以改的：装在非默认位置的人，在看见「本机没有这个路径」的地方
 * 就能把位置填对。这条用例盯的是三件事——填错当场退回、填对立刻按新位置扫、留空回到默认，
 * 并且每一次都得落到 config.json 里：只在内存里生效的话，重启之后又要再填一遍。
 *
 * HOME 指到临时目录，默认位置因此也在临时目录下，跑测试不会碰到真实的登录状态。
 */
test('导入来源的位置可以当场改，留空回到默认', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-srcpath-'));
  const home = await mkdtemp(join(tmpdir(), 'quotahot-srcpath-home-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  context.after(() => rm(home, { recursive: true, force: true }));

  // 一份放在别处的 cli-proxy-api 账户目录：默认位置上什么都没有
  const alt = join(home, 'elsewhere');
  await mkdir(alt, { recursive: true });
  await writeFile(
    join(alt, 'one.json'),
    JSON.stringify({
      type: 'claude',
      email: 'a@example.com',
      access_token: 'not-a-real-token',
      refresh_token: 'not-a-real-token',
      expired: new Date(Date.now() + 86_400_000).toISOString(),
    }),
    'utf8',
  );

  type Source = { source: string; path: string; defaultPath: string; available: boolean; accounts: { email: string }[] };
  type PathResult = { sources: Source[]; config: { clientPaths: Record<string, string> } };
  const server = await serveOn(dataDir, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
  });
  const put = (id: string, path: string): Promise<Response> =>
    fetch(`${server.base}/api/accounts/sources/${id}/path`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  const proxySource = async (): Promise<Source> => {
    const listed = (await (await fetch(`${server.base}/api/accounts/sources`)).json()) as Source[];
    const found = listed.find((s) => s.source === 'cli-proxy-api');
    assert.ok(found, '来源列表里应当有 cli-proxy-api');
    return found;
  };

  try {
    // 填错：相对路径在终端和 systemd 下指向两个地方，不能收下
    const bad = await put('cli-proxy-api', 'elsewhere');
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /绝对路径/);
    const unknown = await put('not-a-client', '/tmp/x');
    assert.equal(unknown.status, 400);
    assert.equal((await proxySource()).path, join(home, '.cli-proxy-api'), '退回之后位置不该变');

    // 填对：`~` 展开成主目录，不用逼着人手敲一遍
    const ok = await put('cli-proxy-api', '~/elsewhere');
    assert.equal(ok.status, 200);
    const saved = (await ok.json()) as PathResult;
    const found = saved.sources.find((s) => s.source === 'cli-proxy-api');
    assert.equal(found?.path, alt);
    assert.equal(found?.available, true);
    assert.deepEqual(found?.accounts.map((a) => a.email), ['a@example.com'], '改完就该看见那边的账户');
    assert.equal(saved.config.clientPaths['cli-proxy-api'], alt, '配置要一起回给前端，否则下次保存会顶掉');
    assert.equal(
      ((await readConfig(dataDir)).clientPaths as Record<string, string>)['cli-proxy-api'],
      alt,
      '得落盘，重启之后不该要求再填一遍',
    );
    // 对整个进程生效，不只是这一次响应
    assert.equal((await proxySource()).path, alt);

    // 留空：回到默认位置，配置里那一项整个删掉
    const back = await put('cli-proxy-api', '   ');
    assert.equal(back.status, 200);
    const restored = (await back.json()) as PathResult;
    const atDefault = restored.sources.find((s) => s.source === 'cli-proxy-api');
    assert.equal(atDefault?.path, join(home, '.cli-proxy-api'));
    assert.equal(atDefault?.path, atDefault?.defaultPath, 'placeholder 上写的就是这个位置');
    assert.deepEqual(restored.config.clientPaths, {});
    assert.deepEqual((await readConfig(dataDir)).clientPaths, {});
  } finally {
    await server.kill();
  }
});
