import assert from 'node:assert/strict';
import test from 'node:test';
import { generateApiKey } from '../src/web/api-key.js';

test('uses the native randomUUID when it is available', () => {
  const cryptoApi = {
    getRandomValues: <T extends ArrayBufferView>(bytes: T): T => bytes,
    randomUUID: () => '00112233-4455-6677-8899-aabbccddeeff' as const,
  };

  assert.equal(generateApiKey(cryptoApi), 'qh-00112233445566778899aabbccddeeff');
});

test('generates a UUID-shaped key when randomUUID is unavailable', () => {
  const cryptoApi = {
    getRandomValues: <T extends ArrayBufferView>(bytes: T): T => {
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).set([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
      ]);
      return bytes;
    },
  };

  assert.equal(generateApiKey(cryptoApi), 'qh-000102030405460788090a0b0c0d0e0f');
});
