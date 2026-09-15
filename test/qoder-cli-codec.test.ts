import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { decodeQoderCli, QoderCliDecodeError } from '../src/server/qoder-cli-codec.js';

const machineId = '01234567-89ab-cdef-0123-456789abcdef';
const vendorCiphertext = 'Mj9put6pxQTIwaYYU3y42bSj/sWKMkC93407ugQ9di9QloV49+jn2LTDeoigqDMTNbfE5Os1jNWm8NQEMRzN4d5Mp93sxkiuVncamTejbml7RdL0JT4uVE11jleYj8OCF84wd/PxWv5wvXX4NLaWKEoOHSaFuzL9M8jHWG97KDSfByHMoD0xXTJC0gKRlu9bmtPNrnW8AvH27Q4WWq45uUx1Wv5pJWhMKXPJlXv1e1mfITNDJjSeNa/AhflqSq9flOTyJGmSMQeHWanwcGAHcGAm5G++fXmhpZCEeaGllms=';

function encryptFixture(plaintext: string): Buffer {
  const key = Buffer.from(machineId.slice(0, 16));
  const cipher = createCipheriv('aes-128-cbc', key, key);
  return Buffer.from(Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64'));
}

test('decodes the shipped WASM synthetic fixture and converts seconds to milliseconds', () => {
  const payload = Buffer.from(vendorCiphertext);
  const profile = decodeQoderCli(payload, machineId);
  assert.deepEqual(profile, {
    userId: 'fixture-user', email: 'fixture@example.invalid', accessToken: 'fixture-security',
    refreshToken: 'fixture-refresh', expiresAt: 2_000_000_000_000, plan: '',
  });
});

test('uses only the trimmed machine identity prefix when the suffix changes', () => {
  const payload = Buffer.from(vendorCiphertext);
  const profile = decodeQoderCli(payload, `  ${machineId.slice(0, 16)}different-suffix\n`);
  assert.equal(profile.userId, 'fixture-user');
});

test('accepts access_token when security_oauth_token is absent and optional metadata is missing', () => {
  const payload = encryptFixture(JSON.stringify({ uid: 'fixture', access_token: 'fallback' }));
  const profile = decodeQoderCli(payload, machineId);
  assert.deepEqual(profile, { userId: 'fixture', accessToken: 'fallback', email: '', refreshToken: '', expiresAt: 0, plan: '' });
});

test('rejects a wrong machine identity without exposing the decrypted input', () => {
  const payload = Buffer.from(vendorCiphertext);
  assert.throws(() => decodeQoderCli(payload, 'ffffffff-ffff-ffff-ffff-ffffffffffff'), QoderCliDecodeError);
});

test('rejects short and multibyte machine prefixes', () => {
  const payload = Buffer.from(vendorCiphertext);
  for (const identity of ['', 'short', '\u00e9'.repeat(16)]) {
    assert.throws(() => decodeQoderCli(payload, identity), QoderCliDecodeError);
  }
});

test('rejects malformed ciphertext rather than accepting Node base64 coercions', () => {
  for (const value of ['', '{}', '!!!!', vendorCiphertext.slice(1), `${vendorCiphertext}\n`, 'AAAA']) {
    assert.throws(() => decodeQoderCli(Buffer.from(value), machineId), QoderCliDecodeError);
  }
});

test('rejects invalid profile fields and JSON without retaining plaintext in errors', () => {
  for (const plaintext of ['secret-plaintext', 'null', '[]', '{}',
    JSON.stringify({ uid: 123, access_token: 'secret' }),
    JSON.stringify({ uid: 'fixture', access_token: '' }),
    JSON.stringify({ uid: 'fixture', access_token: 'secret', expire_time: 'tomorrow' }),
    JSON.stringify({ uid: 'fixture', access_token: 'secret', expire_time: -1 }),
    JSON.stringify({ uid: 'fixture', access_token: 'secret', email: {} }),
  ]) {
    const payload = encryptFixture(plaintext);
    assert.throws(() => decodeQoderCli(payload, machineId), (error: unknown) => {
      assert.ok(error instanceof QoderCliDecodeError);
      assert.equal(error.cause, undefined);
      assert.equal(JSON.stringify(error).includes('secret'), false);
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
  }
});
