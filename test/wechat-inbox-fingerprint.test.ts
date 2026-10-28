import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fingerprintJson, parseLosslessJson } from '../src/server/wechat-inbox/fingerprint.js';

test('fingerprint is SHA-256 of JSON with recursively sorted keys and insignificant whitespace removed', () => {
  const value = parseLosslessJson(' { "z": [ {"b":2,"a":1} ], "a":true } ');
  const actual = fingerprintJson(value);
  assert.equal(actual, createHash('sha256').update('{"a":true,"z":[{"a":1,"b":2}]}').digest('hex'));
});

for (const [left, right] of [
  ['{"b":2,"a":1}', '{"a":1,"b":2}'],
  ['{"2":0,"10":1}', '{"10":1,"2":0}'],
  ['{"__proto__":{"x":1},"constructor":2}', '{"constructor":2,"__proto__":{"x":1}}'],
  ['{"a":"\\u0061"}', '{"a":"a"}'],
]) {
  test(`fingerprint ignores object key order and equivalent string escapes: ${left}`, () => {
    assert.equal(fingerprintJson(parseLosslessJson(left)), fingerprintJson(parseLosslessJson(right)));
  });
}

for (const [left, right] of [
  ['[1,2]', '[2,1]'], ['1', '"1"'],
  ['9007199254740992', '9007199254740993'],
  ['18446744073709551614', '18446744073709551615'],
  ['18446744073709551615', '"18446744073709551615"'],
  ['1e3', '1000'], ['1.0', '1'], ['-0', '0'], ['1e999', '"1e999"'],
  ['1', '{"source":"1"}'], ['1', '["number","1"]'],
]) {
  test(`fingerprint distinguishes lossless values ${left} and ${right}`, () => {
    assert.notEqual(fingerprintJson(parseLosslessJson(left)), fingerprintJson(parseLosslessJson(right)));
  });
}

test('hashes the exact large numeric lexeme without quoting or rounding', () => {
  const source = '{"id":18446744073709551615,"nested":[-1.2300e+42,1e999]}';
  assert.equal(fingerprintJson(parseLosslessJson(source)), createHash('sha256').update(source).digest('hex'));
});

test('JSON syntax errors discard source payload and parser diagnostics', () => {
  assert.throws(() => parseLosslessJson('{"raw-secret":'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes('raw-secret'), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});
