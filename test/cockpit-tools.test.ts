import { createCipheriv, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCockpitRecord } from '../src/server/cockpit-tools.js';

function envelope(value: unknown, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({
    version: 1,
    kind: 'claude',
    algorithm: 'AES-256-GCM',
    key_id: 'local-secure-account-storage-v1',
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    encrypted_at: 1,
  });
}

test('decodes a plaintext cockpit-tools record', () => {
  assert.deepEqual(decodeCockpitRecord('{"email":"user@example.com"}'), { email: 'user@example.com' });
});

test('decodes an AES-GCM cockpit-tools record with its key', () => {
  const key = randomBytes(32);
  assert.deepEqual(decodeCockpitRecord(envelope({ email: 'user@example.com' }, key), key), { email: 'user@example.com' });
});

test('rejects malformed and wrongly keyed records without exposing secrets', () => {
  const key = randomBytes(32);
  const secret = 'private-cockpit-token';
  assert.throws(() => decodeCockpitRecord('{"algorithm":"AES-256-GCM","nonce":"bad","ciphertext":"private-cockpit-token"}', key), (error: unknown) => {
    assert.equal(error instanceof Error, true);
    assert.doesNotMatch(String(error), new RegExp(secret));
    return true;
  });
  assert.throws(() => decodeCockpitRecord(envelope({ secret }, key), randomBytes(32)), (error: unknown) => {
    assert.equal(error instanceof Error, true);
    assert.doesNotMatch(String(error), new RegExp(secret));
    return true;
  });
});
