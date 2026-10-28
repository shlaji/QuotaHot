import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { test } from 'node:test';
import { inspect } from 'node:util';
import {
  IlinkMediaError, mediaType, messageItemKind, parseMediaMetadata, parseMediaKey,
  encryptMedia, decryptMedia, mediaChunks,
} from '../src/server/wechat-inbox/media.js';

const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
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

test('maps message item kinds separately from upload media types', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 11, 12, 999].map(messageItemKind),
    ['text', 'image', 'voice', 'file', 'video', 'protocol_event', 'protocol_event', 'protocol_event']);
  assert.deepEqual(['image', 'video', 'file', 'voice'].map(mediaType), [1, 2, 3, 4]);
  assert.throws(() => mediaType('text'), safeError('invalid_metadata'));
});

test('parses safe metadata without retaining untrusted fields', () => {
  const parsed = parseMediaMetadata({ ...metadata, fileName: '..\\private/evil\r\n"<name>.bin',
    mediaType: ' Application/Octet-Stream ', key: 'secret-param', width: 2, durationMs: 0 });
  assert.deepEqual(parsed, { ...metadata, fileName: 'evil_name_.bin', width: 2, durationMs: 0 });
  assert.equal(parseMediaMetadata({ ...metadata, fileName: '../..' }).fileName, 'attachment');
});

for (const invalid of [null, { ...metadata, kind: 'text' }, { ...metadata, sizeBytes: -1 },
  { ...metadata, sizeBytes: 0.5 }, { ...metadata, sizeBytes: Number.MAX_SAFE_INTEGER + 1 },
  { ...metadata, fileName: 42 }, { ...metadata, mediaType: 'text/html\r\nx-secret: secret-param' },
  { ...metadata, mediaType: 'image/png;param=secret-param' }, { ...metadata, width: 0 },
  { ...metadata, durationMs: -1 }]) {
  test('rejects invalid media metadata with a fixed safe error', () => {
    assert.throws(() => parseMediaMetadata(invalid), safeError('invalid_metadata'));
  });
}

test('validates exact AES keys with explicit encoding and copies caller bytes', () => {
  assert.deepEqual(parseMediaKey({ encoding: 'hex', value: key.toString('hex') }), key);
  assert.deepEqual(parseMediaKey({ encoding: 'base64', value: key.toString('base64') }), key);
  const bytes = Buffer.from(key);
  const parsed = parseMediaKey(bytes);
  bytes.fill(255);
  assert.deepEqual(parsed, key);
});
for (const invalid of ['', Buffer.alloc(15), Buffer.alloc(17), { encoding: 'hex', value: 'z'.repeat(32) },
  { encoding: 'hex', value: '0'.repeat(31) }, { encoding: 'base64', value: 'a'.repeat(24) },
  { encoding: 'base64', value: `${key.toString('base64')}!` }, { encoding: 'utf8', value: 'a'.repeat(16) }]) {
  test('rejects malformed AES key encoding and size', () => {
    assert.throws(() => parseMediaKey(invalid), safeError('invalid_key'));
  });
}

for (const length of [0, 1, 15, 16, 17, 65536, 131075]) {
  test(`matches AES-128-ECB PKCS#7 and round trips ${length} bytes`, () => {
    const plain = Buffer.alloc(length, 37);
    const reference = createCipheriv('aes-128-ecb', key, null);
    const expected = Buffer.concat([reference.update(plain), reference.final()]);
    const encrypted = encryptMedia(plain, key);
    assert.deepEqual(encrypted, expected);
    assert.equal(encrypted.length, (Math.floor(length / 16) + 1) * 16);
    assert.deepEqual(decryptMedia(encrypted, key), plain);
    assert.deepEqual(Buffer.concat([...mediaChunks(plain)]), plain);
    for (const chunk of mediaChunks(plain)) assert.ok(chunk.length <= 65536 && chunk.length > 0);
  });
}
for (const bytes of [Buffer.alloc(0), Buffer.alloc(15), Buffer.alloc(16, 255)]) {
  test('rejects empty, truncated or invalidly padded ciphertext safely', () => {
    assert.throws(() => decryptMedia(bytes, key), safeError('decrypt_failed'));
  });
}
