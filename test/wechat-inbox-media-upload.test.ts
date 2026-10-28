import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { HttpResponse, type request } from '../src/server/http.js';
import { encryptMedia, IlinkMediaError } from '../src/server/wechat-inbox/media.js';
import { encryptedMediaSize, prepareMediaUpload } from '../src/server/wechat-inbox/media-upload-source.js';
import { resolveMediaUploadUrl, uploadPreparedMedia } from '../src/server/wechat-inbox/media-upload.js';

const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const endpoint = { url: 'https://cdn.test/upload?secret-url', key };
for (const size of [0, 1, 15, 16, 17, 65536, 131075]) {
  test(`snapshots, hashes and streams exact PKCS#7 ciphertext for ${size} bytes`, async () => {
    const input = Buffer.alloc(size, 43);
    const prepared = await prepareMediaUpload((async function* () { yield input; })());
    try {
      assert.equal(prepared.rawsize, size);
      assert.equal(prepared.rawfilemd5, createHash('md5').update(input).digest('hex'));
      assert.equal(prepared.filesize, 16 * (Math.floor(size / 16) + 1));
      assert.equal((await stat(prepared.stagedFile)).mode & 0o777, 0o600);
      const expected = encryptMedia(input, key);
      input.fill(0);
      const transport: typeof request = async (url, options = {}) => {
        assert.equal(url, endpoint.url);
        assert.equal(options.method, 'POST');
        assert.equal(options.followRedirects, false);
        assert.equal(options.audit, undefined);
        assert.equal(options.body, undefined);
        assert.equal(options.bodyBytes, undefined);
        assert.equal(options.transport, 'undici');
        assert.equal(options.headers?.['Content-Length'], String(expected.length));
        assert.equal(options.headers?.['Content-Type'], 'application/octet-stream');
        assert.ok(options.bodyStream);
        const chunks: Buffer[] = [];
        for await (const chunk of options.bodyStream) {
          assert.ok(chunk.byteLength <= 65536);
          chunks.push(chunk);
        }
        assert.deepEqual(Buffer.concat(chunks), expected);
        return new HttpResponse(200, new Headers({ 'x-encrypted-param': 'opaque+ref/==' }), Readable.from([]));
      };
      assert.equal(await uploadPreparedMedia(prepared, endpoint, transport), 'opaque+ref/==');
    } finally { await prepared.dispose(); }
    await assert.rejects(access(prepared.stagedFile));
    await prepared.dispose();
  });
}

test('rejects unsafe size arithmetic rather than rounding padded lengths', () => {
  assert.equal(encryptedMediaSize(0), 16);
  assert.equal(encryptedMediaSize(Number.MAX_SAFE_INTEGER - 16), Number.MAX_SAFE_INTEGER - 15);
  for (const size of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, -1, 1.5]) {
    assert.throws(() => encryptedMediaSize(size), { code: 'invalid_metadata' });
  }
});

test('staging failure and caller cancellation expose only fixed safe errors', async () => {
  await assert.rejects(prepareMediaUpload((async function* () {
    yield Buffer.from('partial'); throw new Error('secret-url secret-key');
  })()), (error: unknown) => {
    assert.ok(error instanceof IlinkMediaError);
    assert.equal(error.message, 'iLink media: upload_failed');
    assert.equal(error.cause, undefined);
    return true;
  });
  await assert.rejects(prepareMediaUpload((async function* () { yield Buffer.alloc(1); })(),
    AbortSignal.abort('secret-url')), { code: 'aborted' });
});

test('full upload URL wins and fallback matches pinned URL construction only with configured base', () => {
  assert.equal(resolveMediaUploadUrl({ upload_full_url: ' https://cdn.test/full?x=1 ', upload_param: 'unused' },
    { filekey: 'file key', cdnBaseUrl: 'https://other.test' }), 'https://cdn.test/full?x=1');
  assert.equal(resolveMediaUploadUrl({ upload_param: 'a+/=' }, { filekey: 'file key', cdnBaseUrl: 'https://cdn.test/base' }),
    'https://cdn.test/base/upload?encrypted_query_param=a%2B%2F%3D&filekey=file%20key');
  assert.throws(() => resolveMediaUploadUrl({ upload_param: 'secret' }, { filekey: 'file' }), IlinkMediaError);
  assert.throws(() => resolveMediaUploadUrl({ upload_full_url: 'http://unsafe.test' }, { filekey: 'file' }), IlinkMediaError);
});

for (const param of [null, '', 'bad param', 'duplicate, value', 'https://secret-url']) {
  test('rejects unsafe response parameter and destroys the response without reading secrets', async () => {
    const prepared = await prepareMediaUpload((async function* () {})());
    const body = Readable.from(['secret-body']);
    const transport: typeof request = async (_url, options = {}) => {
      options.bodyStream?.resume();
      return new HttpResponse(200, new Headers(param === null ? {} : { 'x-encrypted-param': param }), body);
    };
    try { await assert.rejects(uploadPreparedMedia(prepared, endpoint, transport), { code: 'invalid_response' }); }
    finally { await prepared.dispose(); }
    assert.equal(body.destroyed, true);
  });
}
