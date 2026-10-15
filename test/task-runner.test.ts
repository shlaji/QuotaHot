import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runTask } from '../src/server/task-runner.js';
import type { CreateTaskInput } from '../src/shared/tasks.js';

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
      process.stdout.write(JSON.stringify({ sessionID: 'root' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'text', part: { text: process.argv.at(-1) } }) + '\\n');
      if (mode === 'root-failed') process.exitCode = 7;
      if (mode === 'root-signaled') process.kill(process.pid, 'SIGTERM');
    }
  `, { mode: 0o755 });
  const input: CreateTaskInput = { description: mode, model: 'openai/test', directory, trigger: { type: 'time', at: Date.now() } };
  return { directory, executable, state, input };
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
