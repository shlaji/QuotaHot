import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runTask } from '../src/server/task-runner.js';
import { TaskStore } from '../src/server/task-store.js';
import { TaskScheduler } from '../src/server/task-scheduler.js';
import type { CreateTaskInput, TaskOutputChunk } from '../src/shared/tasks.js';

function fixture(t: TestContext, mode: string) {
  const directory = mkdtempSync(join(tmpdir(), 'task-runtime-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = join(directory, 'state.json');
  writeFileSync(state, JSON.stringify({ started: Date.now(), aborted: [] }));
  const executable = join(directory, 'fake-opencode');
  writeFileSync(executable, `#!${process.execPath}
    const http = require('node:http');
    const fs = require('node:fs');
    const stateFile = process.env.FAKE_STATE;
    const mode = process.env.FAKE_MODE;
    const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const write = (value) => fs.writeFileSync(stateFile, JSON.stringify(value));
    if (process.argv[2] === 'serve') {
      fs.writeFileSync(stateFile + '.server-pid', String(process.pid));
      const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        const state = read();
        response.setHeader('content-type', 'application/json');
        if (url.pathname === '/global/health') { response.end('{}'); return; }
        if (url.pathname === '/session/status') {
          const elapsed = Date.now() - state.started;
          const nestedBusy = mode === 'nested' && elapsed < 1000;
          const siblingBusy = mode === 'sibling-error' && elapsed < 1200;
          const lateBusy = (mode === 'late-child' && elapsed < 1400) || (mode === 'cancel-late-child' && !state.aborted.includes('late-child'));
          const abortStuck = mode === 'abort-stuck';
          const cancelled = state.aborted.length > 0;
          response.end(JSON.stringify({ root: { type: 'idle' }, child: { type: abortStuck || (nestedBusy && !cancelled) ? 'busy' : 'idle' }, sibling: { type: siblingBusy && !cancelled ? 'busy' : 'idle' }, nested: { type: nestedBusy && !cancelled ? 'busy' : 'idle' }, 'late-child': { type: lateBusy && !cancelled ? 'busy' : 'idle' } }));
          return;
        }
        if (url.pathname.endsWith('/children')) {
          const parent = url.pathname.split('/')[2];
          const elapsed = Date.now() - state.started;
          const children = parent === 'root'
            ? [
              { id: 'child', parentID: 'root', directory: url.searchParams.get('directory') },
              ...(mode === 'sibling-error' ? [{ id: 'sibling', parentID: 'root', directory: url.searchParams.get('directory') }] : []),
              ...(mode === 'late-child' && elapsed >= 500 ? [{ id: 'late-child', parentID: 'root', directory: url.searchParams.get('directory') }] : []),
              ...(mode === 'cancel-late-child' && state.aborted.includes('root') ? [{ id: 'late-child', parentID: 'root', directory: url.searchParams.get('directory') }] : []),
            ]
            : mode === 'nested' && parent === 'child' ? [{ id: 'nested', parentID: 'child', directory: url.searchParams.get('directory') }] : [];
          response.end(JSON.stringify(children));
          return;
        }
        if (url.pathname.endsWith('/message')) {
          const id = url.pathname.split('/')[2];
          const elapsed = Date.now() - state.started;
          if ((mode === 'no-message' && id === 'child') || (mode === 'root-signaled' && id === 'root')) { response.end('[]'); return; }
          if (mode === 'error' && id === 'child') { response.end(JSON.stringify([{ info: { role: 'assistant', time: { completed: Date.now() }, error: { message: 'child failed' }, finish: 'error' } }])); return; }
          if (mode === 'structured-error' && id === 'child') { response.end(JSON.stringify([{ info: { role: 'assistant', time: { completed: Date.now() }, error: { name: 'MessageAbortedError', data: { message: 'child aborted' } } } }])); return; }
          if (mode === 'sibling-error' && id === 'child') { response.end(JSON.stringify([{ info: { role: 'assistant', time: { completed: Date.now() }, error: { message: 'child failed' }, finish: 'error' } }])); return; }
          if (mode === 'sibling-error' && id === 'sibling' && elapsed < 1200) { response.end('[]'); return; }
          if (mode === 'late-child' && id === 'late-child' && elapsed < 1400) { response.end('[]'); return; }
          if (mode === 'nested' && id === 'nested' && elapsed < 1000) { response.end('[]'); return; }
          response.end(JSON.stringify([{ info: { role: 'assistant', time: { completed: Date.now() }, finish: 'stop' } }]));
          return;
        }
        if (request.method === 'POST' && url.pathname.endsWith('/abort')) {
          const id = url.pathname.split('/')[2];
          const next = read(); next.aborted.push(id); write(next); response.end('{}'); return;
        }
        response.statusCode = 404; response.end('{}');
      });
      server.listen(Number(process.argv.at(-1)), '127.0.0.1');
    } else {
      if (mode === 'resume') {
        const assert = require('node:assert/strict');
        assert.deepEqual(process.argv.slice(5), ['--format', 'json', '--model', 'openai/test', '--dir', process.cwd(), '--session', 'root', '--', 'follow up']);
        assert.equal(process.env.PWD, process.cwd());
      }
      if (mode === 'oversized-line') process.stdout.write(JSON.stringify({ sessionID: 'wrong', padding: 'x'.repeat(200000) }) + '\\n');
      process.stdout.write(JSON.stringify({ sessionID: 'root' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'text', part: { text: process.argv.at(-1) } }) + '\\n');
      if (mode === 'raw-output') process.stderr.write(Buffer.from([0, 255, 254, 13, 10]));
      if (mode === 'sink-failure') {
        process.on('SIGTERM', () => process.stdout.write('drained after failure\\n', () => process.exit(0)));
        setInterval(() => {}, 1000);
      }
      if (mode === 'root-failed') process.exitCode = 7;
      if (mode === 'root-signaled') process.kill(process.pid, 'SIGTERM');
    }
  `, { mode: 0o755 });
  const input: CreateTaskInput = { description: mode, model: 'openai/test', directory, trigger: { type: 'time', at: Date.now() } };
  return { directory, executable, state, input };
}

for (const scenario of ['title', 'placeholder', 'blank', 'wrong-id', 'child', 'malformed', 'http-error', 'network-error', 'callback-error']) {
  test(`root title metadata is best effort: ${scenario}`, { timeout: 5000 }, async (t) => {
    const mode = scenario === 'title' ? 'success' : 'resume';
    const data = fixture(t, mode);
    const titles: string[] = [];
    let requests = 0;
    let treeRead = false;
    const result = await runTask(data.input, new AbortController().signal, {
      executable: data.executable, env: { FAKE_STATE: data.state, FAKE_MODE: mode },
      ...(mode === 'resume' ? { sessionId: 'root', prompt: 'follow up' } : {}),
      fetch: async (url, init) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/message')) treeRead = true;
        if (parsed.pathname !== '/session/root') return fetch(url, init);
        requests++;
        assert.equal(treeRead, true);
        assert.equal(parsed.searchParams.get('directory'), data.directory);
        assert.equal(init?.method ?? 'GET', 'GET');
        const serverPid = Number(readFileSync(data.state + '.server-pid', 'utf8'));
        process.kill(serverPid, 0);
        if (scenario === 'network-error') throw new TypeError('offline');
        if (scenario === 'http-error') return new Response('{}', { status: 503 });
        if (scenario === 'malformed') return new Response('not json');
        return Response.json({
          id: scenario === 'wrong-id' ? 'different' : 'root',
          ...(scenario === 'child' ? { parentID: 'parent' } : {}),
          title: scenario === 'placeholder' ? 'New session - 2026-10-18T00:00:00.000Z'
            : scenario === 'blank' ? '  ' : '  Generated root title  ',
        });
      },
      onSessionTitle: (id, title) => {
        assert.equal(id, 'root');
        if (scenario === 'callback-error') throw new Error('metadata storage unavailable');
        titles.push(title);
      },
    });
    assert.equal(result.status, 'succeeded', result.error);
    assert.equal(requests, 1);
    assert.deepEqual(titles, scenario === 'title' ? ['Generated root title'] : []);
  });
}

test('keeps an idle child without a terminal assistant message running', { timeout: 5000 }, async (t) => {
  const fixtureData = fixture(t, 'no-message');
  const controller = new AbortController();
  let settled = false;
  const running = runTask(fixtureData.input, controller.signal, { executable: fixtureData.executable, env: { FAKE_STATE: fixtureData.state, FAKE_MODE: 'no-message' } }).then((result) => { settled = true; return result; });
  await delay(700);
  assert.equal(settled, false);
  controller.abort();
  assert.equal((await running).status, 'failed');
});

test('waits for a nested busy child and succeeds after every terminal message', { timeout: 5000 }, async (t) => {
  const fixtureData = fixture(t, 'nested');
  const result = await runTask(fixtureData.input, new AbortController().signal, { executable: fixtureData.executable, env: { FAKE_STATE: fixtureData.state, FAKE_MODE: 'nested' } });
  assert.equal(result.status, 'succeeded', result.error);
  assert.match(result.output, /nested/);
});

test('fails when a recursive child reports an assistant error', { timeout: 5000 }, async (t) => {
  const fixtureData = fixture(t, 'error');
  const result = await runTask(fixtureData.input, new AbortController().signal, { executable: fixtureData.executable, env: { FAKE_STATE: fixtureData.state, FAKE_MODE: 'error' } });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /child failed/);
  assert.equal(result.archiveState, 'complete');
});

test('fails on structured OpenCode assistant errors without a string finish reason', { timeout: 5000 }, async (t) => {
  const fixtureData = fixture(t, 'structured-error');
  const result = await runTask(fixtureData.input, new AbortController().signal, {
    executable: fixtureData.executable,
    env: { FAKE_STATE: fixtureData.state, FAKE_MODE: 'structured-error' },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /MessageAbortedError/);
});

test('discovers a descendant created after the first candidate completion snapshot', { timeout: 5000 }, async (t) => {
  const fixtureData = fixture(t, 'late-child');
  const started = Date.now();
  const result = await runTask(fixtureData.input, new AbortController().signal, {
    executable: fixtureData.executable,
    env: { FAKE_STATE: fixtureData.state, FAKE_MODE: 'late-child' },
  });
  assert.equal(result.status, 'succeeded');
  assert.ok(Date.now() - started >= 1400, 'waits for the late descendant terminal message');
});

test('reports a failed root process instead of waiting forever for missing messages', { timeout: 5000 }, async (t) => {
  const fixtureData = fixture(t, 'root-failed');
  const result = await runTask(fixtureData.input, new AbortController().signal, {
    executable: fixtureData.executable,
    env: { FAKE_STATE: fixtureData.state, FAKE_MODE: 'root-failed' },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /exited with 7/);
});

test('reports a signaled root process instead of waiting forever for missing messages', { timeout: 5000 }, async (t) => {
  const fixtureData = fixture(t, 'root-signaled');
  const result = await runTask(fixtureData.input, new AbortController().signal, {
    executable: fixtureData.executable,
    env: { FAKE_STATE: fixtureData.state, FAKE_MODE: 'root-signaled' },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /exited with SIGTERM/);
});

test('waits for running siblings to finish before reporting a child error', { timeout: 5000 }, async (t) => {
  const fixtureData = fixture(t, 'sibling-error');
  const started = Date.now();
  const result = await runTask(fixtureData.input, new AbortController().signal, { executable: fixtureData.executable, env: { FAKE_STATE: fixtureData.state, FAKE_MODE: 'sibling-error' } });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /child failed/);
  assert.ok(Date.now() - started >= 1000, 'task remains active until the sibling session finishes');
  const state = JSON.parse(readFileSync(fixtureData.state, 'utf8')) as { readonly aborted: readonly string[] };
  assert.deepEqual(state.aborted, []);
});

test('aborts descendants deepest-first, keeps the server until abort completes, and preserves directory', { timeout: 5000 }, async (t) => {
  const fixtureData = fixture(t, 'nested');
  const controller = new AbortController();
  const running = runTask(fixtureData.input, controller.signal, { executable: fixtureData.executable, env: { FAKE_STATE: fixtureData.state, FAKE_MODE: 'nested' } });
  await delay(700);
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'failed');
  const state = JSON.parse(readFileSync(fixtureData.state, 'utf8')) as { readonly aborted: readonly string[] };
  assert.deepEqual(state.aborted, ['nested', 'child', 'root']);
  assert.match(result.output, /nested/);
  assert.ok(result.output.length >= 1);
});

test('re-discovers and aborts descendants created during cancellation', { timeout: 5000 }, async (t) => {
  const fixtureData = fixture(t, 'cancel-late-child');
  const controller = new AbortController();
  const running = runTask(fixtureData.input, controller.signal, {
    executable: fixtureData.executable,
    env: { FAKE_STATE: fixtureData.state, FAKE_MODE: 'cancel-late-child' },
  });
  await delay(1200);
  controller.abort();
  const result = await running;
  const state = JSON.parse(readFileSync(fixtureData.state, 'utf8')) as { readonly aborted: readonly string[] };
  assert.equal(result.status, 'failed');
  assert.ok(state.aborted.includes('late-child'), JSON.stringify(state));
});

test('bounds cancellation when OpenCode keeps reporting a session busy', { timeout: 5000 }, async (t) => {
  const fixtureData = fixture(t, 'abort-stuck');
  const controller = new AbortController();
  const running = runTask(fixtureData.input, controller.signal, {
    executable: fixtureData.executable,
    env: { FAKE_STATE: fixtureData.state, FAKE_MODE: 'abort-stuck' },
    abortTreeTimeoutMs: 50,
  });
  await delay(1200);
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Execution cancelled.*Timed out aborting OpenCode session tree/);
});

test('reports the initial session while the task is still running', { timeout: 5000 }, async (t) => {
  const data = fixture(t, 'no-message');
  const controller = new AbortController();
  const discovered = Promise.withResolvers<string>();
  const running = runTask(data.input, controller.signal, {
    executable: data.executable, env: { FAKE_STATE: data.state, FAKE_MODE: 'no-message' },
    onSession: discovered.resolve,
  });
  assert.equal(await discovered.promise, 'root');
  controller.abort();
  assert.equal((await running).status, 'failed');
});

test('resumes the exact session with the new prompt and original directory and model', { timeout: 5000 }, async (t) => {
  const data = fixture(t, 'resume');
  const result = await runTask(data.input, new AbortController().signal, {
    executable: data.executable, env: { FAKE_STATE: data.state, FAKE_MODE: 'resume' },
    sessionId: 'root', prompt: 'follow up',
  });
  assert.equal(result.status, 'succeeded', result.error);
  assert.deepEqual(JSON.parse(result.output.trim().split('\n').at(-1) ?? ''), { type: 'text', part: { text: 'follow up' } });
  const serverPid = Number(readFileSync(data.state + '.server-pid', 'utf8'));
  assert.throws(() => process.kill(serverPid, 0), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ESRCH');
});

test('fails rather than accepting a different session during continuation', { timeout: 5000 }, async (t) => {
  const data = fixture(t, 'resume-mismatch');
  const result = await runTask(data.input, new AbortController().signal, {
    executable: data.executable, env: { FAKE_STATE: data.state, FAKE_MODE: 'resume-mismatch' },
    sessionId: 'expected-root', prompt: 'follow up',
    onSession: () => assert.fail('must not persist a replacement session'),
    onSessionTitle: () => assert.fail('must not persist a replacement title'),
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /different session/);
});

test('recovers the root session after an oversized JSON line', { timeout: 5000 }, async (t) => {
  const data = fixture(t, 'oversized-line');
  const sessions: string[] = [];
  const chunks: Buffer[] = [];
  const store = new TaskStore(':memory:');
  t.after(() => store.close());
  const task = store.create(data.input, Date.now());
  const claimed = store.claim(task.id, Date.now());
  assert.ok(claimed);

  const result = await runTask(data.input, new AbortController().signal, {
    executable: data.executable, env: { FAKE_STATE: data.state, FAKE_MODE: 'oversized-line' },
    onSession: (id) => {
      assert.ok(Buffer.concat(chunks).includes(Buffer.from(JSON.stringify({ sessionID: 'root' }) + '\n')));
      sessions.push(id);
    },
    onOutputChunk: (chunk, stream) => { chunks.push(chunk); store.appendOutput(task.id, claimed.currentRunId, chunk, stream); },
    onOutput: (preview) => store.updatePreview(task.id, claimed.currentRunId, preview),
  });

  assert.equal(result.status, 'succeeded', result.error);
  assert.deepEqual(sessions, ['root']);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([JSON.stringify({ sessionID: 'wrong', padding: 'x'.repeat(200000) }), JSON.stringify({ sessionID: 'root' }), JSON.stringify({ type: 'text', part: { text: 'oversized-line' } }), ''].join('\n')));
  store.finishRun(task.id, claimed.currentRunId, { ...result, finishedAt: Date.now() });
  const page = store.readLogPage(task.id, claimed.currentRunId, { maxBytes: 256 * 1024 });
  assert.ok(page);
  assert.deepEqual(Buffer.concat(page.chunks.map((chunk) => chunk.data)), Buffer.concat(chunks));
  assert.ok(page.chunks.every((chunk) => chunk.stream === 'stdout'));
  assert.equal(page.hasMore, false);
  assert.equal(store.listRuns(task.id)[0].archiveState, 'complete');
  assert.ok(Buffer.byteLength(result.output) <= 65536);
  assert.ok(result.output.endsWith('"oversized-line"}}\n'));
});

test('captures original stdout and stderr bytes in callback arrival order', { timeout: 5000 }, async (t) => {
  const data = fixture(t, 'raw-output');
  const chunks: TaskOutputChunk[] = [];
  const result = await runTask(data.input, new AbortController().signal, {
    executable: data.executable, env: { FAKE_STATE: data.state, FAKE_MODE: 'raw-output' },
    onOutputChunk: (chunk, stream) => chunks.push({ data: chunk, stream }),
  });
  const raw = Buffer.concat(chunks.map((chunk) => chunk.data));
  assert.deepEqual(Buffer.concat(chunks.filter((chunk) => chunk.stream === 'stdout').map((chunk) => chunk.data)),
    Buffer.from([JSON.stringify({ sessionID: 'root' }), JSON.stringify({ type: 'text', part: { text: 'raw-output' } }), ''].join('\n')));
  assert.deepEqual(Buffer.concat(chunks.filter((chunk) => chunk.stream === 'stderr').map((chunk) => chunk.data)),
    Buffer.from([0, 255, 254, 13, 10]));
  assert.ok(raw.includes(Buffer.from([0, 255, 254, 13, 10])));
  assert.ok(raw.includes(Buffer.from(JSON.stringify({ sessionID: 'root' }) + '\n')));
  assert.equal(result.output, raw.toString('utf8'));
  assert.equal(result.archiveState, 'complete');
});

test('fails and closes an incomplete archive when the raw sink throws during a data event', { timeout: 5000 }, async (t) => {
  const data = fixture(t, 'sink-failure');
  const store = new TaskStore(':memory:');
  const scheduler = new TaskScheduler(store, {
    quota: async () => [],
    run: (task, signal, options) => runTask(task, signal, {
      ...options, executable: data.executable, env: { FAKE_STATE: data.state, FAKE_MODE: 'sink-failure' },
    }),
  });
  t.after(async () => { await scheduler.stop(); store.close(); });
  t.mock.method(store, 'appendOutput', () => { throw new Error('injected disk full'); });
  const task = scheduler.create(data.input);
  scheduler.tick();
  await scheduler.settled();
  assert.equal(store.get(task.id)?.status, 'failed');
  assert.match(store.get(task.id)?.error ?? '', /archive failed: injected disk full/);
  assert.match(store.get(task.id)?.output ?? '', /drained after failure/);
  assert.equal(store.listRuns(task.id)[0].archiveState, 'incomplete');
  assert.ok(store.listRuns(task.id)[0].closedAt);
  assert.deepEqual(JSON.parse(readFileSync(data.state, 'utf8')).aborted, ['child', 'root']);
  const serverPid = Number(readFileSync(data.state + '.server-pid', 'utf8'));
  assert.throws(() => process.kill(serverPid, 0), { code: 'ESRCH' });
});
