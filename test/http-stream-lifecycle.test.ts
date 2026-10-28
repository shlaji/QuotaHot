import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { HttpResponse, request } from '../src/server/http.js';
import { IlinkMediaError } from '../src/server/wechat-inbox/media.js';
import { prepareMediaUpload } from '../src/server/wechat-inbox/media-upload-source.js';
import { uploadPreparedMedia } from '../src/server/wechat-inbox/media-upload.js';

const endpoint = { url: 'https://cdn.test/upload?secret-url', key: Buffer.alloc(16, 7), timeoutMs: 2000 };
function deferred<Value>() {
  let resolve: (value: Value) => void = () => assert.fail('uninitialized resolver');
  const promise = new Promise<Value>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function serve(context: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/`;
}
function safeFailure(error: unknown): boolean {
  assert.ok(error instanceof IlinkMediaError);
  assert.equal(error.code, 'upload_failed');
  assert.equal(error.cause, undefined);
  assert.equal(JSON.stringify(error).includes('secret'), false);
  return true;
}

test('stream requests retain status and decode compressed responses', async (context) => {
  const url = await serve(context, (req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(409, { 'content-encoding': 'gzip' }); res.end(gzipSync('decoded')); });
  });
  const response = await request(url, { method: 'POST', followRedirects: false, bodyStream: Readable.from(['input']) });
  assert.equal(response.status, 409);
  assert.equal(await response.text(), 'decoded');
});

test('stream requests never redirect or replay to a second host', async (context) => {
  let requests = 0;
  const target = await serve(context, (req, res) => { requests++; req.resume(); res.end(); });
  const url = await serve(context, (req, res) => { req.resume(); res.writeHead(307, { location: target }); res.end(); });
  const response = await request(url, { method: 'POST', followRedirects: false, bodyStream: Readable.from(['private']) });
  assert.equal(response.status, 307);
  await response.text();
  assert.equal(requests, 0);
});

for (const cancellation of ['caller', 'deadline'] as const) {
  test(`stream requests stop on ${cancellation} cancellation`, async (context) => {
    const started = deferred<void>();
    const url = await serve(context, (req) => { req.on('data', () => started.resolve()); });
    const bodyStream = new PassThrough();
    const controller = new AbortController();
    const response = request(url, { method: 'POST', followRedirects: false, bodyStream,
      timeoutMs: cancellation === 'deadline' ? 100 : 2000, signal: controller.signal });
    const rejection = assert.rejects(response);
    bodyStream.write(Buffer.alloc(16));
    await started.promise;
    if (cancellation === 'caller') controller.abort();
    await rejection;
    assert.equal(bodyStream.destroyed, true);
  });
}

test('source failure after partial bytes rejects and does not replay HTTP request', async (context) => {
  const started = deferred<void>();
  let requests = 0;
  const url = await serve(context, (req) => { requests++; req.on('data', () => started.resolve()); });
  const source = new PassThrough();
  const pending = request(url, { method: 'POST', followRedirects: false, bodyStream: source });
  const rejection = assert.rejects(pending);
  source.write(Buffer.alloc(16));
  await started.promise;
  source.destroy(new Error('source failure'));
  await rejection;
  assert.equal(requests, 1);
});

test('early 200 cannot hide a late plaintext producer error', async (context) => {
  const prepared = await prepareMediaUpload((async function* () { yield Buffer.alloc(32); })());
  context.after(() => prepared.dispose());
  const plaintext = new PassThrough({ highWaterMark: 65536 });
  const headers = deferred<void>();
  let settled = false;
  const transport: typeof request = async (_url, options = {}) => {
    options.bodyStream?.resume();
    headers.resolve();
    return new HttpResponse(200, new Headers({ 'x-encrypted-param': 'reference' }), Readable.from([]));
  };
  const pending = uploadPreparedMedia({ ...prepared, openPlaintext: () => plaintext }, endpoint, transport);
  const rejection = assert.rejects(pending, safeFailure).then(() => { settled = true; });
  plaintext.write(Buffer.alloc(16));
  await headers.promise;
  assert.equal(settled, false);
  plaintext.destroy(new Error('secret-source-key'));
  await rejection;
  assert.equal(plaintext.destroyed, true);
});

test('early 403 cancels an unfinished producer without waiting for more source bytes', async (context) => {
  const prepared = await prepareMediaUpload((async function* () {})());
  context.after(() => prepared.dispose());
  const plaintext = new PassThrough();
  const responseBody = Readable.from(['secret-response']);
  const transport: typeof request = async () => new HttpResponse(403, new Headers(), responseBody);
  await assert.rejects(uploadPreparedMedia({ ...prepared, openPlaintext: () => plaintext }, endpoint, transport), safeFailure);
  assert.equal(plaintext.destroyed, true);
  assert.equal(responseBody.destroyed, true);
});

test('real early response headers cannot hide producer failure after partial ciphertext', async (context) => {
  const prepared = await prepareMediaUpload((async function* () { yield Buffer.alloc(131072); })());
  context.after(() => prepared.dispose());
  const plaintext = new PassThrough();
  const url = await serve(context, (req, res) => {
    req.on('data', () => {
      if (!res.headersSent) { res.writeHead(200, { 'x-encrypted-param': 'reference' }); res.flushHeaders(); }
    });
  });
  const transport: typeof request = async (_url, options) => {
    const response = await request(url, options);
    plaintext.destroy(new Error('secret-source'));
    return response;
  };
  const pending = uploadPreparedMedia({ ...prepared, openPlaintext: () => plaintext }, endpoint, transport);
  const rejection = assert.rejects(pending, safeFailure);
  plaintext.write(Buffer.alloc(65536));
  await rejection;
});

test('late response reset after early 200 rejects upload', async (context) => {
  const prepared = await prepareMediaUpload((async function* () { yield Buffer.alloc(65536); })());
  context.after(() => prepared.dispose());
  const url = await serve(context, (req, res) => {
    res.writeHead(200, { 'x-encrypted-param': 'reference', 'content-length': '100' });
    res.flushHeaders();
    req.resume();
    req.on('end', () => res.destroy());
  });
  const transport: typeof request = (_url, options) => request(url, options);
  await assert.rejects(uploadPreparedMedia(prepared, endpoint, transport), safeFailure);
});

for (const failure of ['reset', 'abort', 'early-403', 'early-200', 'redirect'] as const) {
  test(`file-backed upload uses real HTTP and joins producer on ${failure}`, async (context) => {
    const prepared = await prepareMediaUpload((async function* () { yield Buffer.alloc(2 * 1024 * 1024, 3); })());
    context.after(() => prepared.dispose());
    const controller = new AbortController();
    let targetCalls = 0;
    const target = await serve(context, (req, res) => { targetCalls++; req.resume(); res.end(); });
    const url = await serve(context, (req, res) => {
      if (failure === 'reset') { req.socket.destroy(); return; }
      if (failure === 'abort') { req.on('data', () => controller.abort('secret-reason')); return; }
      if (failure === 'redirect') { res.writeHead(307, { location: target }); res.end(); return; }
      res.writeHead(failure === 'early-403' ? 403 : 200, { 'x-encrypted-param': 'reference' });
      if (failure === 'early-200') {
        res.flushHeaders();
        req.resume();
        req.on('end', () => res.end());
      } else { res.end(); }
    });
    let requests = 0;
    const transport: typeof request = (_url, options) => { requests++; return request(url, options); };
    const pending = uploadPreparedMedia(prepared, { ...endpoint, signal: controller.signal }, transport);
    if (failure === 'early-200') assert.equal(await pending, 'reference');
    else if (failure === 'abort') await assert.rejects(pending, { code: 'aborted' });
    else await assert.rejects(pending, safeFailure);
    assert.equal(requests, 1);
    assert.equal(targetCalls, 0);
  });
}
