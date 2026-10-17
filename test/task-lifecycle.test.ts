import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskStore } from '../src/server/task-store.js';
import type { TaskListResponse, ManagedTask } from '../src/shared/tasks.js';

const liveBytes = Buffer.concat([Buffer.from('{"sessionID":"root"}\nlive output\n'), Buffer.alloc(100000, 120), Buffer.from([255, 0, 226])]);
const finalBytes = Buffer.concat([Buffer.alloc(70000, 121), Buffer.from([128, 0, 255]), Buffer.from('\nfinal output\n')]);

function readArchive(store: TaskStore, taskId: string) {
  const [run] = store.listRuns(taskId);
  assert.ok(run);
  const page = store.readLogPage(taskId, run.id, { maxBytes: 262144 });
  assert.ok(page);
  assert.equal(page.hasMore, false);
  return {
    run, bytes: Buffer.concat(page.chunks.map((chunk) => chunk.data)),
    stdout: Buffer.concat(page.chunks.filter((chunk) => chunk.stream === 'stdout').map((chunk) => chunk.data)),
    stderr: Buffer.concat(page.chunks.filter((chunk) => chunk.stream === 'stderr').map((chunk) => chunk.data)),
  };
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'condition completed before deadline');
    await delay(50);
  }
}

async function serve(t: TestContext, directory: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', 'serve'], {
    env: { ...process.env, PORT: '0', QUOTAHOT_HOST: '127.0.0.1', QUOTAHOT_DATA_DIR: directory,
      HOME: directory, XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory, CODEX_HOME: directory,
      QUOTAHOT_AUTH_USERNAME: '', QUOTAHOT_AUTH_PASSWORD: '', PATH: `${directory}:${process.env.PATH ?? ''}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  let stopping = false;
  const stop = async () => {
    if (!stopping && child.exitCode === null) { stopping = true; child.kill('SIGTERM'); }
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { assert.equal(await exited, 0); } finally { clearTimeout(timeout); }
  };
  t.after(stop);
  const base = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Startup timeout: ${output}`)), 10000);
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      const url = /QuotaHot 已启动: (http:\/\/\S+)/.exec(output)?.[1];
      if (url) { clearTimeout(timeout); resolve(url); }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
  const list = async (): Promise<TaskListResponse> => {
    const response = await fetch(`${base}/api/tasks`);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { base, stop, list };
}

function sandbox(t: TestContext, proxy = ''): string {
  const directory = mkdtempSync(join(tmpdir(), 'task-lifecycle-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'config.json'), JSON.stringify({
    autoStart: false, usageRefreshMinutes: 0, clientCheckMinutes: 0, proxy, noProxy: ['localhost'],
  }));
  writeFileSync(join(directory, 'live.bin'), liveBytes);
  writeFileSync(join(directory, 'final.bin'), finalBytes);
  writeFileSync(join(directory, 'opencode'), `#!${process.execPath}
    const fs = require('node:fs');
    const http = require('node:http');
    if (process.argv[2] === 'serve') {
      process.stdout.write('serve stdout must not be archived\\n');
      process.stderr.write('serve stderr must not be archived\\n');
      const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        response.setHeader('content-type', 'application/json');
        if (url.pathname === '/global/health') { response.end('{}'); return; }
        if (url.pathname === '/session/status') { response.end(JSON.stringify({ root: { type: 'idle' } })); return; }
        if (url.pathname.endsWith('/children')) { response.end('[]'); return; }
        if (url.pathname.endsWith('/message')) {
          const done = process.cwd() + '/terminated';
          response.end(fs.existsSync(done) || !fs.existsSync(process.cwd() + '/ready') ? JSON.stringify([{ info: { role: 'assistant', time: { completed: Date.now() }, finish: 'stop' } }]) : '[]'); return;
        }
        if (request.method === 'POST' && url.pathname.endsWith('/abort')) { response.end('{}'); return; }
        response.statusCode = 404; response.end('{}');
      });
      server.listen(Number(process.argv.at(-1)), '127.0.0.1');
    } else if (process.argv.at(-1) === 'hold') {
      process.on('SIGTERM', () => {
        fs.writeFileSync('terminated', 'yes');
        process.stderr.write(fs.readFileSync(process.env.HOME + '/final.bin'), () => process.exit(0));
      });
      process.stdout.write(fs.readFileSync(process.env.HOME + '/live.bin'), () => fs.writeFileSync('ready', 'yes'));
      setInterval(() => {}, 1000);
    } else if (process.argv.at(-1) === 'archive') {
      process.stdout.write(fs.readFileSync(process.env.HOME + '/live.bin'));
    } else if (process.argv.at(-1) === 'inspect') {
      process.stdout.write(JSON.stringify({sessionID:'root'}) + '\\n');
      process.stdout.write(JSON.stringify({cwd:process.cwd(),pwd:process.env.PWD,http:process.env.HTTP_PROXY,https:process.env.HTTPS_PROXY,httpLower:process.env.http_proxy,httpsLower:process.env.https_proxy,noProxy:process.env.NO_PROXY,noProxyLower:process.env.no_proxy,allProxy:process.env.ALL_PROXY,allProxyLower:process.env.all_proxy}) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({sessionID:'root'}) + '\\n');
      process.stdout.write(JSON.stringify({type:'text',part:{text:process.argv.at(-1)}}) + '\\n');
    }
  `, { mode: 0o755 });
  return directory;
}

test('real server passes configured proxy and selected directory to the task subprocess', { timeout: 20000 }, async (t) => {
  const directory = sandbox(t, 'http://127.0.0.1:7897');
  const server = await serve(t, directory);
  const response = await fetch(`${server.base}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'inspect', model: 'openai/fake', directory, trigger: { type: 'time', at: Date.now() + 200 } }),
  });
  const responseBody = await response.text();
  assert.equal(response.status, 201, responseBody);
  const created: ManagedTask = JSON.parse(responseBody);

  await waitFor(async () => (await server.list()).tasks.find((task) => task.id === created.id)?.status === 'succeeded');
  const outputText = (await server.list()).tasks.find((task) => task.id === created.id)?.output ?? '{}';
  const output = JSON.parse(outputText.trim().split('\n').at(-1) ?? '{}');
  assert.deepEqual(output, {
    cwd: directory, pwd: directory,
    http: 'http://127.0.0.1:7897', https: 'http://127.0.0.1:7897',
    httpLower: 'http://127.0.0.1:7897', httpsLower: 'http://127.0.0.1:7897',
    noProxy: 'localhost', noProxyLower: 'localhost',
  });
  await server.stop();
});

test('real server restores pending work, never reruns interrupted tasks, and executes the HTTP-created task', { timeout: 20000 }, async (t) => {
  const directory = sandbox(t);
  const store = new TaskStore(join(directory, 'tasks.db'));
  const input = { description: 'restored', model: 'openai/fake', directory, trigger: { type: 'time', at: Date.now() - 1000 } } as const;
  const pending = store.create(input, Date.now() - 2000);
  const interrupted = store.create({ ...input, description: 'must not run' }, Date.now() - 2000);
  store.claim(interrupted.id, Date.now() - 1000);
  store.close();
  const server = await serve(t, directory);

  await waitFor(async () => (await server.list()).tasks.find((task) => task.id === pending.id)?.status === 'succeeded');
  assert.equal((await server.list()).tasks.find((task) => task.id === interrupted.id)?.status, 'failed');
  assert.equal((await fetch(`${server.base}/api/tasks`, { method: 'POST', body: '{' })).status, 400);
  const response = await fetch(`${server.base}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, description: 'archive', trigger: { type: 'time', at: Date.now() + 300 } }),
  });
  assert.equal(response.status, 201);
  const created: ManagedTask = await response.json();
  await waitFor(async () => (await server.list()).tasks.find((task) => task.id === created.id)?.status === 'succeeded');
  const finished = (await server.list()).tasks.find((task) => task.id === created.id);
  assert.ok(Buffer.byteLength(finished?.output ?? '') <= 65536);
  await server.stop();
  const archived = new TaskStore(join(directory, 'tasks.db'));
  try {
    assert.deepEqual(readArchive(archived, created.id).bytes, liveBytes);
    assert.equal(readArchive(archived, created.id).run.archiveState, 'complete');
    assert.equal(archived.listRuns(interrupted.id).length, 1);
    assert.equal(readArchive(archived, interrupted.id).run.archiveState, 'incomplete');
  } finally { archived.close(); }
});

test('real server terminates active processes before closing the task database on shutdown', { timeout: 20000 }, async (t) => {
  const directory = sandbox(t);
  const workspaces = ['first', 'second'].map((name) => join(directory, name));
  for (const workspace of workspaces) mkdirSync(workspace);
  const server = await serve(t, directory);
  const at = Date.now() + 200;
  const tasks = await Promise.all(workspaces.map(async (workspace): Promise<ManagedTask> => {
    const response = await fetch(`${server.base}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'hold', model: 'openai/fake', directory: workspace, trigger: { type: 'time', at } }),
    });
    assert.equal(response.status, 201);
    return response.json();
  }));
  await waitFor(async () => workspaces.every((workspace) => existsSync(join(workspace, 'ready'))));
  for (const task of tasks) {
    assert.equal((await fetch(`${server.base}/api/tasks/${task.id}`, { method: 'DELETE' })).status, 409);
  }

  await server.stop();

  for (const workspace of workspaces) assert.equal(existsSync(join(workspace, 'terminated')), true);
  const store = new TaskStore(join(directory, 'tasks.db'));
  try {
    for (const task of tasks) {
      assert.equal(store.get(task.id)?.status, 'failed');
      assert.match(store.get(task.id)?.output ?? '', /live output/);
      assert.match(store.get(task.id)?.output ?? '', /final output/);
      assert.ok(Buffer.byteLength(store.get(task.id)?.output ?? '') <= 65536);
      const archive = readArchive(store, task.id);
      assert.deepEqual(archive.bytes, Buffer.concat([liveBytes, finalBytes]));
      assert.deepEqual(archive.stdout, liveBytes);
      assert.deepEqual(archive.stderr, finalBytes);
      assert.equal(archive.run.status, 'failed');
      assert.equal(archive.run.archiveState, 'complete');
      assert.notEqual(archive.run.closedAt, null);
    }
  } finally { store.close(); }
});

test('HTTP exposes live output and preserves cancellation output across restart', { timeout: 20000 }, async (t) => {
  const directory = sandbox(t);
  const server = await serve(t, directory);
  const response = await fetch(`${server.base}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'hold', model: 'openai/fake', directory, trigger: { type: 'time', at: Date.now() + 200 } }),
  });
  assert.equal(response.status, 201);
  const created: ManagedTask = await response.json();
  await waitFor(async () => (await server.list()).tasks.find((task) => task.id === created.id)?.output.includes('live output') ?? false);
  assert.equal((await server.list()).tasks.find((task) => task.id === created.id)?.status, 'running');
  const store = new TaskStore(join(directory, 'tasks.db'));
  t.after(() => store.close());
  await waitFor(async () => store.getPreviewMetadata(created.id)?.totalBytes === liveBytes.length);
  const live = readArchive(store, created.id);
  assert.deepEqual(live.bytes, liveBytes);
  assert.deepEqual(live.stdout, liveBytes);
  assert.deepEqual(live.stderr, Buffer.alloc(0));
  assert.equal(live.run.archiveState, 'capturing');
  assert.equal(live.run.closedAt, null);
  assert.ok(Buffer.byteLength(store.get(created.id)?.output ?? '') <= 65536);

  const cancellation = await fetch(`${server.base}/api/tasks/${created.id}/cancel`, { method: 'POST' });

  assert.equal(cancellation.status, 200);
  const cancelled: ManagedTask = await cancellation.json();
  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.output, /live output/);
  assert.match(cancelled.output, /final output/);
  assert.ok(Buffer.byteLength(cancelled.output) <= 65536);
  const terminal = readArchive(store, created.id);
  assert.equal(terminal.run.id, live.run.id);
  assert.equal(terminal.run.status, 'cancelled');
  assert.equal(terminal.run.archiveState, 'complete');
  assert.notEqual(terminal.run.closedAt, null);
  assert.deepEqual(terminal.bytes, Buffer.concat([liveBytes, finalBytes]));
  assert.deepEqual(terminal.stdout, liveBytes);
  assert.deepEqual(terminal.stderr, finalBytes);
  assert.deepEqual((await server.list()).tasks.find((task) => task.id === created.id), cancelled);
  await server.stop();
  const restarted = await serve(t, directory);
  assert.deepEqual((await restarted.list()).tasks.find((task) => task.id === created.id), cancelled);
  assert.deepEqual(readArchive(store, created.id), terminal);
  await restarted.stop();
});
