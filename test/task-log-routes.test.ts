import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { get } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { accessGuard } from '../src/server/access.js';
import { taskLogRoutes } from '../src/server/task-log-routes.js';
import { TaskStore } from '../src/server/task-store.js';
import type { TaskLogExportRecord, TaskLogPageRequest, TaskLogPageResponse } from '../src/shared/tasks.js';

const authorization = `Basic ${Buffer.from('tester:secret').toString('base64')}`;
const headers = { authorization };
const pageBytes = 64 * 1024;

async function fixture(t: TestContext) {
  const store = new TaskStore(':memory:');
  const task = store.create({ description: 'unsafe " filename\n', model: 'test', directory: '/tmp', trigger: { type: 'quota' } }, 1000);
  const run = store.claim(task.id, 1001);
  assert.ok(run);
  const app = new Hono();
  app.use('*', accessGuard({ username: 'tester', password: 'secret' }));
  app.route('/api', taskLogRoutes(store));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const root = `http://127.0.0.1:${address.port}/api/tasks`;
  return { store, task, runId: run.currentRunId, root, base: `${root}/${task.id}` };
}

test('lists run metadata without reading archive chunks', async (t) => {
  const { store, task, runId, base } = await fixture(t);
  store.appendOutput(task.id, runId, randomBytes(100), 'stdout');
  const expected = store.listRuns(task.id);
  t.mock.method(store, 'readLogPage', () => assert.fail('metadata must not read BLOBs'));

  const response = await fetch(`${base}/runs`, { headers });

  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { taskId: task.id, runs: expected });
});

test('reconstructs binary output across partial chunks with stable bounded page cursors', async (t) => {
  const { store, task, runId, base } = await fixture(t);
  const input = randomBytes(pageBytes * 2 + 37);
  store.appendOutput(task.id, runId, input.subarray(0, pageBytes), 'stdout');
  store.appendOutput(task.id, runId, input.subarray(pageBytes, pageBytes * 2), 'stderr');
  store.appendOutput(task.id, runId, input.subarray(pageBytes * 2), 'stdout');
  const parts: Buffer[] = [];
  let query = 'maxBytes=997&maxChunks=1';

  for (;;) {
    const response = await fetch(`${base}/runs/${runId}/log?${query}`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const page: TaskLogPageResponse = await response.json();
    assert.equal(page.encoding, 'base64');
    assert.equal(page.archiveState, 'capturing');
    assert.equal(page.totalBytes, input.length);
    assert.equal(page.totalChunks, 3);
    assert.ok(page.chunks.length <= 1);
    assert.ok(page.chunks.every((chunk) => chunk.stream === (chunk.sequence === 1 ? 'stderr' : 'stdout')));
    const bytes = page.chunks.map((chunk) => Buffer.from(chunk.data, 'base64'));
    assert.ok(bytes.reduce((total, chunk) => total + chunk.length, 0) <= 997);
    parts.push(...bytes);
    if (!page.hasMore) break;
    query = `maxBytes=997&maxChunks=1&sequence=${page.nextCursor.sequence}&byteOffset=${page.nextCursor.byteOffset}`;
  }

  assert.deepEqual(Buffer.concat(parts), input);
});

test('defaults to at most 64 KiB and 128 chunks per page', async (t) => {
  const { store, task, runId, base } = await fixture(t);
  for (let index = 0; index < 140; index++) store.appendOutput(task.id, runId, randomBytes(1024), 'stdout');

  const response = await fetch(`${base}/runs/${runId}/log`, { headers });
  const page: TaskLogPageResponse = await response.json();

  assert.equal(page.chunks.reduce((total, chunk) => total + Buffer.from(chunk.data, 'base64').length, 0), pageBytes);
  assert.ok(page.chunks.length <= 128);
  assert.equal(page.hasMore, true);
});

test('caps small-chunk pages at 128 chunks', async (t) => {
  const { store, task, runId, base } = await fixture(t);
  for (let index = 0; index < 140; index++) store.appendOutput(task.id, runId, Buffer.from([index]), 'stdout');

  const response = await fetch(`${base}/runs/${runId}/log`, { headers });
  const page: TaskLogPageResponse = await response.json();

  assert.equal(page.chunks.length, 128);
  assert.equal(page.nextCursor.byteOffset, 128);
});

test('returns the latest output page without requiring the client to scan earlier pages', async (t) => {
  const { store, task, runId, base } = await fixture(t);
  const output = randomBytes(pageBytes * 2 + 19);
  store.appendOutput(task.id, runId, output, 'stderr');

  const response = await fetch(`${base}/runs/${runId}/log?tail=true&maxBytes=997`, { headers });
  const page: TaskLogPageResponse = await response.json();

  assert.equal(response.status, 200);
  assert.equal(page.hasEarlier, true);
  assert.equal(page.hasMore, false);
  assert.deepEqual(Buffer.concat(page.chunks.map((chunk) => Buffer.from(chunk.data, 'base64'))), output.subarray(-997));
});

test('rejects malformed, oversized, duplicate and uncommitted page positions', async (t) => {
  const { base, runId } = await fixture(t);
  const queries = ['maxBytes=65537', 'maxChunks=129', 'maxBytes=0', 'maxChunks=-1', 'maxBytes=1.5',
    'sequence=1e2&byteOffset=0', 'sequence=9007199254740992&byteOffset=0', 'byteOffset=0',
    'sequence=0&byteOffset=1', 'sequence=0&byteOffset=-1', 'maxBytes=', 'maxBytes=1&maxBytes=2'];

  for (const query of queries) {
    const response = await fetch(`${base}/runs/${runId}/log?${query}`, { headers });
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    await response.text();
  }
});

test('returns 404 for missing tasks, rounds and a round belonging to another task', async (t) => {
  const { root, base, runId, store } = await fixture(t);
  const other = store.create({ description: 'other', model: 'test', directory: '/tmp', trigger: { type: 'quota' } }, 2000);
  const paths = [`${root}/missing/runs`, `${root}/missing/logs/download`, `${base}/runs/missing/log`,
    `${root}/missing/runs/${runId}/messages/download`, `${base}/runs/missing/messages/download`,
    `${root}/${other.id}/runs/${runId}/messages/download`,
    `${base}/runs/missing/download`, `${root}/${other.id}/runs/${runId}/log`, `${root}/${other.id}/runs/${runId}/download`];

  for (const path of paths) {
    const response = await fetch(path, { headers });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    await response.text();
  }
});

test('inherits Basic Auth and cross-site rejection on every archive endpoint', async (t) => {
  const { base, runId } = await fixture(t);
  for (const path of ['/runs', `/runs/${runId}/log`, `/runs/${runId}/download`, `/runs/${runId}/messages/download`, '/logs/download']) {
    for (const request of [{ headers: new Headers(), status: 401 }, { headers: new Headers({ authorization, 'sec-fetch-site': 'cross-site' }), status: 403 },
      { headers: new Headers({ authorization, origin: 'https://evil.example' }), status: 403 }]) {
      const response = await fetch(base + path, { headers: request.headers });
      assert.equal(response.status, request.status);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      await response.text();
    }
  }
});

for (const bundle of [false, true]) {
  test(`streams ${bundle ? 'JSONL' : 'raw'} snapshot bytes while concurrent appends continue`, async (t) => {
    const { store, task, runId, base } = await fixture(t);
    const input = randomBytes(pageBytes * 3 + 19);
    store.appendOutput(task.id, runId, input.subarray(0, pageBytes), 'stdout');
    store.appendOutput(task.id, runId, input.subarray(pageBytes, pageBytes * 2), 'stderr');
    store.appendOutput(task.id, runId, input.subarray(pageBytes * 2), 'stdout');
    const snapshot = store.listRuns(task.id);
    const read = store.readLogPage.bind(store);
    t.mock.method(store, 'readLogPage', (id: string, round: string, request: TaskLogPageRequest) => {
      assert.ok((request.maxBytes ?? Infinity) <= pageBytes);
      assert.ok((request.maxChunks ?? Infinity) <= 128);
      store.appendOutput(task.id, runId, randomBytes(777), 'stderr');
      return read(id, round, request);
    });

    const response = await fetch(base + (bundle ? '/logs/download' : `/runs/${runId}/download`), { headers });
    const downloaded = Buffer.from(await response.arrayBuffer());

    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-disposition'), bundle
      ? `attachment; filename="task-${task.id}-logs.jsonl"`
      : `attachment; filename="task-${task.id}-run-${runId}.log"`);
    let raw = downloaded;
    if (bundle) {
      const records: TaskLogExportRecord[] = downloaded.toString().trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(records[0], { type: 'run', run: snapshot[0] });
      assert.deepEqual(records.at(-1), { type: 'complete', taskId: task.id, totalRuns: 1, totalBytes: input.length });
      const chunks = records.filter((record) => record.type === 'chunk');
      assert.deepEqual(chunks.map((record) => record.chunk.stream), ['stdout', 'stderr', 'stdout', 'stdout']);
      assert.ok(chunks.every((record) => record.encoding === 'utf8'));
    } else assert.equal(response.headers.get('content-length'), String(input.length));
    if (!bundle) assert.equal(createHash('sha256').update(raw).digest('hex'), createHash('sha256').update(input).digest('hex'));
  });
}

test('exports all rounds including empty rounds and excludes rounds created after snapshot', async (t) => {
  const { store, task, runId, base } = await fixture(t);
  store.setSession(task.id, 'session');
  store.finishRun(task.id, runId, { status: 'succeeded', output: '', error: '', finishedAt: 2000 });
  const second = store.claimContinuation(task.id, 3000);
  assert.ok(second);
  store.appendOutput(task.id, second.currentRunId, Buffer.from('second'), 'stderr');
  const snapshot = store.listRuns(task.id);
  const read = store.readLogPage.bind(store);
  t.mock.method(store, 'readLogPage', (id: string, round: string, request: TaskLogPageRequest) => {
    if (round === runId) {
      store.finishRun(task.id, second.currentRunId, { status: 'succeeded', output: '', error: '', finishedAt: 4000 });
      store.claimContinuation(task.id, 5000);
    }
    return read(id, round, request);
  });

  const response = await fetch(`${base}/logs/download`, { headers });
  const records: TaskLogExportRecord[] = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));

  assert.deepEqual(records.filter((record) => record.type === 'run').map((record) => record.run), snapshot);
  assert.deepEqual(records.at(-1), { type: 'complete', taskId: task.id, totalRuns: 2, totalBytes: 6 });
  assert.equal(Buffer.concat(records.flatMap((record) => record.type === 'chunk' ? [Buffer.from(record.chunk.data)] : [])).toString(), 'second');
});

test('exports readable Unicode JSONL chunks across UTF-8 chunk boundaries with stream metadata', async (t) => {
  const { store, task, runId, base } = await fixture(t);
  const stdout = Buffer.from('你好🙂');
  const split = stdout.indexOf(Buffer.from('🙂')) + 2;
  store.appendOutput(task.id, runId, stdout.subarray(0, split), 'stdout');
  store.appendOutput(task.id, runId, stdout.subarray(split), 'stdout');
  store.appendOutput(task.id, runId, Buffer.from('stderr ✓'), 'stderr');

  const response = await fetch(`${base}/logs/download`, { headers });
  const records: TaskLogExportRecord[] = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  const chunks = records.filter((record) => record.type === 'chunk');

  assert.deepEqual(chunks.map((record) => record.type === 'chunk' && ({
    runId: record.runId, encoding: record.encoding, sequence: record.chunk.sequence,
    byteOffset: record.chunk.byteOffset, stream: record.chunk.stream, data: record.chunk.data,
  })), [
    { runId, encoding: 'utf8', sequence: 0, byteOffset: 0, stream: 'stdout', data: '你好' },
    { runId, encoding: 'utf8', sequence: 1, byteOffset: split, stream: 'stdout', data: '🙂' },
    { runId, encoding: 'utf8', sequence: 2, byteOffset: stdout.length, stream: 'stderr', data: 'stderr ✓' },
  ]);
});

test('marks an empty archive incomplete when the task has an established session', async (t) => {
  const { store, task, runId, base } = await fixture(t);
  store.setSession(task.id, 'root-session');
  store.finishRun(task.id, runId, { status: 'succeeded', output: '', error: '', finishedAt: 2000 });

  const [metadata, download] = await Promise.all([
    fetch(`${base}/runs`, { headers }), fetch(`${base}/runs/${runId}/download`, { headers }),
  ]);

  assert.equal((await metadata.json() as { runs: Array<{ archiveState: string }> }).runs[0]?.archiveState, 'incomplete');
  assert.equal(download.headers.get('x-task-archive-state'), 'incomplete');
  assert.equal(download.headers.get('content-length'), '0');
  assert.equal((await download.arrayBuffer()).byteLength, 0);
});

for (const format of ['raw', 'JSONL', 'messages'] as const) for (const failure of ['delete', 'read'] as const) {
  test(`does not complete ${format} export after mid-stream ${failure}`, async (t) => {
    const { store, task, runId, base } = await fixture(t);
    if (format === 'messages' && failure === 'read') store.appendOutput(task.id, runId, Buffer.from('{"sessionID":"root"}\n'), 'stdout');
    store.appendOutput(task.id, runId, randomBytes(pageBytes * 4), 'stdout');
    store.finishRun(task.id, runId, { status: 'succeeded', output: '', error: '', finishedAt: 2000 });
    const read = store.readLogPage.bind(store);
    let reads = 0;
    t.mock.method(store, 'readLogPage', (id: string, round: string, request: TaskLogPageRequest) => {
      if (++reads === 2) {
        if (failure === 'delete') store.remove(task.id);
        else throw new TypeError('injected read failure');
      }
      return read(id, round, request);
    });

    const result = await new Promise<{ complete: boolean; bytes: Buffer; length: string | undefined }>((resolve, reject) => {
      const path = format === 'JSONL' ? '/logs/download' : `/runs/${runId}/${format === 'messages' ? 'messages/' : ''}download`;
      get(base + path, { headers }, (response) => {
        const parts: Buffer[] = [];
        response.on('data', (part: Buffer) => parts.push(part));
        response.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'ECONNRESET') reject(error); });
        response.on('close', () => resolve({ complete: response.complete, bytes: Buffer.concat(parts), length: response.headers['content-length'] }));
      }).on('error', reject);
    });

    assert.equal(result.complete, false);
    if (format === 'JSONL') assert.equal(result.bytes.toString().includes('"type":"complete"'), false);
    else if (format === 'raw') assert.ok(result.bytes.length < Number(result.length));
    else {
      assert.equal(result.bytes.toString().trimEnd().endsWith(']'), false);
      assert.throws(() => JSON.parse(result.bytes.toString()), SyntaxError);
    }
  });
}

test('exports complete stdout event objects including session and control events', async (t) => {
  const { store, task, runId, base } = await fixture(t);
  const events = [{ sessionID: 'root' }, { type: 'step_start', part: { id: 'step', metadata: [1, true] } },
    { type: 'tool_use', part: { tool: 'bash', input: { command: 'pwd' }, output: ['result'] } },
    { type: 'step_finish', tokens: { input: 12, output: 34 } }, { type: 'text', part: { text: 'answer', extra: null } }];
  for (const event of events) {
    store.appendOutput(task.id, runId, Buffer.from(JSON.stringify(event) + '\r\n'), 'stdout');
    store.appendOutput(task.id, runId, Buffer.from('{"type":"stderr","part":{"text":"excluded"}}\n'), 'stderr');
  }

  const response = await fetch(`${base}/runs/${runId}/messages/download`, { headers });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="task-${task.id}-run-${runId}-messages.json"`);
  assert.deepEqual(await response.json(), events);
});

test('skips invalid stdout lines without changing the raw download', async (t) => {
  const { store, task, runId, base } = await fixture(t);
  const input = Buffer.concat([Buffer.from('bad\n{broken}\nnull\n[]\n1\ntrue\n"scalar"\n\n{"bad":"'),
    Buffer.from([0xff]), Buffer.from('"}\n{"valid":"\ufffd"}\n{"last":true}')]);
  store.appendOutput(task.id, runId, input, 'stdout');

  const [events, raw] = await Promise.all([
    fetch(`${base}/runs/${runId}/messages/download`, { headers }), fetch(`${base}/runs/${runId}/download`, { headers }),
  ]);

  assert.deepEqual(await events.json(), [{ valid: '\ufffd' }, { last: true }]);
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), input);
});

test('streams unbounded lines and split UTF-8 across stdout chunks within a snapshot', async (t) => {
  const { store, task, runId, base } = await fixture(t);
  const event = { type: 'text', part: { text: 'x'.repeat(pageBytes * 3) + '\ud83d\ude00', extra: { keep: true } } };
  const input = Buffer.from(JSON.stringify(event));
  const split = input.indexOf(Buffer.from('\ud83d\ude00')) + 1;
  store.appendOutput(task.id, runId, input.subarray(0, split), 'stdout');
  store.appendOutput(task.id, runId, Buffer.from('{"ignored":true}\n'), 'stderr');
  store.appendOutput(task.id, runId, input.subarray(split), 'stdout');
  const read = store.readLogPage.bind(store);
  t.mock.method(store, 'readLogPage', (id: string, round: string, request: TaskLogPageRequest) => {
    assert.ok((request.maxBytes ?? Infinity) <= pageBytes);
    assert.ok((request.maxChunks ?? Infinity) <= 128);
    store.appendOutput(task.id, runId, Buffer.from('\n{"late":true}\n'), 'stdout');
    return read(id, round, request);
  });

  const response = await fetch(`${base}/runs/${runId}/messages/download`, { headers });

  assert.deepEqual(await response.json(), [event]);
});

for (const input of ['', 'null\n[]\n', '{"bad":"\ud83d']) {
  test(`exports an empty array when no complete objects exist: ${JSON.stringify(input)}`, async (t) => {
    const { store, task, runId, base } = await fixture(t);
    store.appendOutput(task.id, runId, Buffer.from(input), 'stdout');

    const response = await fetch(`${base}/runs/${runId}/messages/download`, { headers });

    assert.deepEqual(await response.json(), []);
  });
}

test('rejects invalid split UTF-8 lines and recovers at the next stdout newline', async (t) => {
  const { store, task, runId, base } = await fixture(t);
  store.appendOutput(task.id, runId, Buffer.concat([Buffer.from('{"bad":"'), Buffer.from([0xe2])]), 'stdout');
  store.appendOutput(task.id, runId, Buffer.from('{"ignored":true}\n'), 'stderr');
  store.appendOutput(task.id, runId, Buffer.from('x"}\n{"huge":9007199254740993}\n{"badEOF":"'), 'stdout');
  store.appendOutput(task.id, runId, Buffer.from([0xe2]), 'stdout');

  const response = await fetch(`${base}/runs/${runId}/messages/download`, { headers });
  const body = await response.text();

  assert.deepEqual(JSON.parse(body), [{ huge: JSON.parse('9007199254740993') }]);
  assert.ok(body.includes('{"huge":9007199254740993}'));
});

test('reads bounded pages only on pull and skips legacy chunks', async (t) => {
  const { store, task, runId } = await fixture(t);
  store.appendOutput(task.id, runId, Buffer.from('{"legacy":true}\n'), 'stdout');
  store.appendOutput(task.id, runId, Buffer.from(' '.repeat(pageBytes * 2)), 'stdout');
  const read = store.readLogPage.bind(store);
  let reads = 0;
  t.mock.method(store, 'readLogPage', (id: string, round: string, request: TaskLogPageRequest) => {
    reads++;
    const page = read(id, round, request);
    assert.ok(page);
    return { ...page, chunks: page.chunks.map((chunk) => ({ ...chunk, stream: 'legacy' as const })) };
  });

  const response = await taskLogRoutes(store).request(`/tasks/${task.id}/runs/${runId}/messages/download`);
  assert.ok(response.body);
  const reader = response.body.getReader();
  assert.equal(reads, 0);
  assert.equal(Buffer.from((await reader.read()).value ?? []).toString(), '[');
  assert.equal(reads, 0);
  assert.equal(Buffer.from((await reader.read()).value ?? []).toString(), '\n');
  assert.equal(reads, 1);
  await reader.cancel();
  assert.equal(reads, 1);
});
