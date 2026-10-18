import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { createServer, type RequestListener } from 'node:http';
import { OpenCodeServer } from '../src/server/opencode-server.js';
import { reserveLoopbackPort } from '../src/server/opencode-runtime-support.js';

async function listener(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port };
}

const options = {
  executable: 'fixture-opencode', cwd: process.cwd(), env: process.env, fetch,
  spawn: () => assert.fail('must not start or replace an existing listener'),
};

test('reuses a healthy external OpenCode listener without spawning', async (t) => {
  const service = await listener(t, (_request, response) => {
    response.end(JSON.stringify({ healthy: true, version: 'fixture' }));
  });
  const server = new OpenCodeServer(service.port);
  const base = await server.ensure(options, new AbortController().signal);
  assert.equal(base, `http://127.0.0.1:${service.port}`);
});

for (const body of ['{}', 'not json', '{"healthy":false,"version":"fixture"}', '{"healthy":true}', 'http-error']) {
  test(`rejects an incompatible listener without spawning or stopping it: ${body}`, async (t) => {
    const service = await listener(t, (_request, response) => {
      if (body === 'http-error') response.statusCode = 503;
      response.end(body);
    });
    await assert.rejects(new OpenCodeServer(service.port).ensure(options, new AbortController().signal), /not a healthy OpenCode service/);
    assert.equal(service.server.listening, true);
  });
}

test('bounds a listener that never returns health headers', { timeout: 2000 }, async (t) => {
  const service = await listener(t, () => {});
  await assert.rejects(new OpenCodeServer(service.port, 50).ensure(options, new AbortController().signal), /Timed out waiting/);
  assert.equal(service.server.listening, true);
});

test('bounds a listener that never completes the health body', { timeout: 2000 }, async (t) => {
  const service = await listener(t, (_request, response) => { response.writeHead(200); response.write('{'); });
  await assert.rejects(new OpenCodeServer(service.port, 50).ensure(options, new AbortController().signal), /Timed out waiting/);
  assert.equal(service.server.listening, true);
});

test('starts detached with ignored stdio and unrefs the shared process', async (t) => {
  const port = await reserveLoopbackPort();
  const child = new ChildProcess();
  const unref = t.mock.method(child, 'unref', () => {});
  let probes = 0;
  const launch = t.mock.fn(() => child);
  const base = await new OpenCodeServer(port).ensure({
    ...options, spawn: launch,
    fetch: async () => {
      if (probes++ === 0) throw new TypeError('offline', { cause: { code: 'ECONNREFUSED' } });
      return Response.json({ healthy: true, version: 'fixture' });
    },
  }, new AbortController().signal);
  assert.equal(base, `http://127.0.0.1:${port}`);
  assert.deepEqual(launch.mock.calls.map((call) => call.arguments), [[
    'fixture-opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: 'ignore' },
  ]]);
  assert.equal(unref.mock.callCount(), 1);
});

test('reprobes and reuses a healthy service after a competing startup wins the port', async () => {
  const port = await reserveLoopbackPort();
  const child = new ChildProcess();
  let probes = 0;
  const base = await new OpenCodeServer(port).ensure({
    ...options,
    spawn: () => { queueMicrotask(() => child.emit('exit', 1, null)); return child; },
    fetch: async () => {
      if (probes++ === 0) throw new TypeError('offline', { cause: { code: 'ECONNREFUSED' } });
      return Response.json({ healthy: true, version: 'winner' });
    },
  }, new AbortController().signal);
  assert.equal(base, `http://127.0.0.1:${port}`);
  assert.equal(probes, 2);
});

test('bounds startup when the launched process never becomes healthy', { timeout: 2000 }, async () => {
  const port = await reserveLoopbackPort();
  const child = new ChildProcess();
  await assert.rejects(new OpenCodeServer(port, 50).ensure({
    ...options, spawn: () => child,
    fetch: async () => { throw new TypeError('offline', { cause: { code: 'ECONNREFUSED' } }); },
  }, new AbortController().signal), /Timed out waiting/);
});

test('reports spawn failure after reprobe instead of waiting indefinitely', async () => {
  const port = await reserveLoopbackPort();
  const child = new ChildProcess();
  await assert.rejects(new OpenCodeServer(port).ensure({
    ...options,
    spawn: () => { queueMicrotask(() => child.emit('error', new Error('ENOENT fixture'))); return child; },
    fetch: async () => { throw new TypeError('offline', { cause: { code: 'ECONNREFUSED' } }); },
  }, new AbortController().signal), /ENOENT fixture.*no healthy OpenCode/);
});
