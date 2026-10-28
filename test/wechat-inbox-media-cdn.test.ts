import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { HttpResponse, request } from '../src/server/http.js';
import {
  IlinkMediaError, parseMediaMetadata, encryptMedia, uploadMedia, downloadMedia, downloadPlainMedia,
} from '../src/server/wechat-inbox/media.js';
import { WechatInboxStore } from '../src/server/wechat-inbox/store.js';

const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const endpoint = { url: 'https://cdn.example.test/media?signature=secret-url', key };
const metadata = { kind: 'file', fileName: 'report.bin', mediaType: 'application/octet-stream', sizeBytes: 0 };
function safeError(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof IlinkMediaError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    for (const secret of ['secret-url', 'secret-body', 'secret-param', key.toString('hex')]) {
      assert.equal(`${inspect(error)} ${JSON.stringify(error)}`.includes(secret), false);
    }
    return true;
  };
}
async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) {
    assert.ok(chunk.byteLength > 0 && chunk.byteLength <= 65536);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

test('uploads encrypted octet-stream POST without audit, redirects or plaintext', async () => {
  const plain = Buffer.from('non-aligned plaintext');
  const signal = new AbortController().signal;
  const response = new HttpResponse(200, new Headers({ 'X-Encrypted-Param': 'opaque+reference/==' }), Readable.from([]));
  const transport: typeof request = async (url, options = {}) => {
    assert.equal(url, endpoint.url);
    assert.equal(options.method, 'POST');
    assert.equal(new Headers(options.headers).get('content-type'), 'application/octet-stream');
    assert.deepEqual(options.bodyBytes, encryptMedia(plain, key));
    assert.equal(options.body, undefined);
    assert.equal(options.audit, undefined);
    assert.equal(options.followRedirects, false);
    assert.equal(options.signal, signal);
    assert.equal(options.timeoutMs, 1234);
    return response;
  };
  assert.equal(await uploadMedia(plain, { ...endpoint, signal, timeoutMs: 1234 }, transport), 'opaque+reference/==');
  assert.equal(response.body.destroyed, true);
});

for (const param of [null, '', 'a, secret-param', 'https://cdn.example.test/?secret-param', 'bad param']) {
  test('rejects absent, duplicate or unsafe encrypted parameter headers', async () => {
    const headers = param === null ? new Headers() : new Headers({ 'x-encrypted-param': param });
    const transport: typeof request = async () => new HttpResponse(200, headers, Readable.from(['secret-body']));
    await assert.rejects(uploadMedia(Buffer.alloc(0), endpoint, transport), safeError('invalid_response'));
  });
}

test('decrypts arbitrarily split download chunks and persists store-compatible plaintext', async () => {
  const plain = Buffer.alloc(131075, 37);
  const encrypted = encryptMedia(plain, key);
  const body = Readable.from([encrypted.subarray(0, 3), encrypted.subarray(3, 65539), encrypted.subarray(65539)]);
  const transport: typeof request = async (_url, options = {}) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.followRedirects, false);
    assert.equal(options.audit, undefined);
    return new HttpResponse(200, new Headers(), body);
  };
  const bytes = await collect(downloadMedia(endpoint, transport));
  assert.deepEqual(bytes, plain);
  const store = new WechatInboxStore(':memory:');
  try {
    store.saveBinding({ ownerIlinkUserId: 'owner', botId: 'bot' }, '2026-10-20T00:00:00Z');
    store.saveBatch('owner', { nextCursor: 'next', messages: [{ remoteMessageId: '1',
      clientId: null, direction: 'inbound', messageType: 1, kind: 'file', state: 'received',
      createdAt: '2026-10-20T00:00:00Z', runId: null, items: [{ kind: 'file', attachment: {
        ...parseMediaMetadata({ ...metadata, sizeBytes: bytes.length }), bytes,
      } }] }] });
    const id = store.listMessages('owner').items[0]?.items[0]?.attachmentId;
    assert.ok(id);
    assert.deepEqual(Buffer.concat([...store.readAttachmentChunks('owner', id)]), plain);
    assert.equal(store.getAttachment('owner', id)?.chunkCount, 3);
  } finally { store.close(); }
});

test('CDN helpers sanitize transport, HTTP and response-stream failures', async () => {
  for (const transport of [
    async () => { throw new Error(`${endpoint.url} secret-body secret-param ${key.toString('hex')}`); },
    async () => new HttpResponse(403, new Headers(), Readable.from(['secret-body'])),
  ]) {
    await assert.rejects(uploadMedia(Buffer.alloc(0), endpoint, transport), safeError('upload_failed'));
    await assert.rejects(collect(downloadMedia(endpoint, transport)), safeError('download_failed'));
  }
  const transport: typeof request = async () => new HttpResponse(200, new Headers(), Readable.from((async function* () {
    yield Buffer.alloc(5);
    throw new Error('secret-body secret-param');
  })()));
  await assert.rejects(collect(downloadMedia(endpoint, transport)), safeError('download_failed'));
});

test('invalid endpoint, key and timeout never call transport', async () => {
  const transport: typeof request = async () => { assert.fail('transport must not run'); };
  for (const options of [{ ...endpoint, url: 'http://cdn.example.test/?secret-param' },
    { ...endpoint, url: 'https://user:secret-param@cdn.example.test/' }, { ...endpoint, timeoutMs: 0 },
    { ...endpoint, timeoutMs: 2147483648 }, { ...endpoint, key: Buffer.alloc(15) }]) {
    const code = options.key.length === 15 ? 'invalid_key' : 'invalid_request';
    await assert.rejects(uploadMedia(Buffer.alloc(0), options, transport), safeError(code));
    await assert.rejects(collect(downloadMedia(options, transport)), safeError(code));
  }
});

test('rejects pre-aborted transfers without disclosing the abort reason', async () => {
  const signal = AbortSignal.abort(new Error('secret-url secret-param'));
  const transport: typeof request = async () => { assert.fail('transport must not run'); };
  await assert.rejects(uploadMedia(Buffer.alloc(0), { ...endpoint, signal }, transport), safeError('aborted'));
  await assert.rejects(collect(downloadMedia({ ...endpoint, signal }, transport)), safeError('aborted'));
});

test('download validates padding even for empty plaintext and closes failed streams', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(15), Buffer.alloc(16, 255), encryptMedia(Buffer.alloc(0), key)]) {
    const body = Readable.from([bytes]);
    const transport: typeof request = async () => new HttpResponse(200, new Headers(), body);
    if (bytes.equals(encryptMedia(Buffer.alloc(0), key))) {
      assert.deepEqual(await collect(downloadMedia(endpoint, transport)), Buffer.alloc(0));
    } else {
      await assert.rejects(collect(downloadMedia(endpoint, transport)), safeError('decrypt_failed'));
    }
    assert.equal(body.destroyed, true);
  }
});

test('abandoning a download cancels the source without retaining remote details', async () => {
  const encrypted = encryptMedia(Buffer.alloc(131075, 2), key);
  const body = Readable.from([encrypted]);
  const transport: typeof request = async () => new HttpResponse(200, new Headers(), body);
  for await (const chunk of downloadMedia(endpoint, transport)) {
    assert.ok(chunk.length <= 65536);
    break;
  }
  assert.equal(body.destroyed, true);
});

test('rejects textual response chunks instead of treating them as ciphertext', async () => {
  const transport: typeof request = async () => new HttpResponse(200, new Headers(), Readable.from(['secret-body']));
  await assert.rejects(collect(downloadMedia(endpoint, transport)), safeError('download_failed'));
});

test('honors cancellation after response headers even when an injected transport ignores it', async () => {
  const controller = new AbortController();
  const transport: typeof request = async () => {
    controller.abort(new Error('secret-body'));
    return new HttpResponse(200, new Headers({ 'x-encrypted-param': 'secret-param' }), Readable.from([]));
  };
  await assert.rejects(uploadMedia(Buffer.alloc(0), { ...endpoint, signal: controller.signal }, transport), safeError('aborted'));
});

test('honors download cancellation at EOF instead of reporting a padding error', async () => {
  const controller = new AbortController();
  const body = Readable.from((async function* () {
    controller.abort(new Error('secret-param'));
  })());
  const transport: typeof request = async () => new HttpResponse(200, new Headers(), body);
  await assert.rejects(collect(downloadMedia({ ...endpoint, signal: controller.signal }, transport)), safeError('aborted'));
});

test('stops download between 64 KiB output chunks on cancellation', async () => {
  const controller = new AbortController();
  const body = Readable.from([encryptMedia(Buffer.alloc(200000), key)]);
  const transport: typeof request = async () => new HttpResponse(200, new Headers(), body);
  const stream = downloadMedia({ ...endpoint, signal: controller.signal }, transport);
  await stream.next();
  controller.abort(new Error('secret-body'));
  await assert.rejects(stream.next(), safeError('aborted'));
  assert.equal(body.destroyed, true);
});

test('uses real HTTP transport for an isolated CDN upload/download round trip', async (context) => {
  let stored = Buffer.alloc(0);
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      stored = Buffer.concat(chunks);
      outgoing.setHeader('x-encrypted-param', 'local-reference');
      outgoing.end();
    } else { outgoing.end(stored); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const transport: typeof request = (_url, options) => request(`http://127.0.0.1:${address.port}/cdn`, options);
  const plain = Buffer.from('manual-surface CDN round trip');
  assert.equal(await uploadMedia(plain, endpoint, transport), 'local-reference');
  assert.deepEqual(await collect(downloadMedia(endpoint, transport)), plain);
});

test('plain CDN image download uses validated HTTPS and closes the full stream', async () => {
  const plain = Buffer.alloc(131075, 42);
  const body = Readable.from([plain]);
  const transport: typeof request = async (_url, options = {}) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.followRedirects, false);
    assert.equal(options.audit, undefined);
    return new HttpResponse(200, new Headers(), body);
  };
  assert.deepEqual(await collect(downloadPlainMedia({ url: endpoint.url }, transport)), plain);
  assert.equal(body.destroyed, true);
});

test('plain CDN download rejects unsafe URLs, HTTP/stream failure and cancellation safely', async () => {
  await assert.rejects(collect(downloadPlainMedia({ url: 'http://cdn.test/secret-param' })), safeError('invalid_request'));
  for (const transport of [
    async () => new HttpResponse(403, new Headers(), Readable.from(['secret-body'])),
    async () => new HttpResponse(200, new Headers(), Readable.from((async function* () {
      yield Buffer.alloc(16);
      throw new Error('secret-body');
    })())),
  ]) {
    await assert.rejects(collect(downloadPlainMedia({ url: endpoint.url }, transport)), safeError('download_failed'));
  }
  await assert.rejects(collect(downloadPlainMedia({ url: endpoint.url, signal: AbortSignal.abort('secret-param') })), safeError('aborted'));
});

test('typed stream cancellation stays aborted for encrypted and plain downloads', async () => {
  const transport: typeof request = async () => new HttpResponse(200, new Headers(), Readable.from((async function* () {
    yield encryptMedia(Buffer.alloc(32), key);
    throw new IlinkMediaError('aborted');
  })()));
  await assert.rejects(collect(downloadMedia(endpoint, transport)), safeError('aborted'));
  await assert.rejects(collect(downloadPlainMedia({ url: endpoint.url }, transport)), safeError('aborted'));
});
