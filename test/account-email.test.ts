import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskEmail } from '../src/web/account-email.js';

test('默认隐藏邮箱本地部分并保留域名', () => {
  assert.equal(maskEmail('john@example.com'), 'j***@e***.com');
});

test('短本地部分仍保留首字符', () => {
  assert.equal(maskEmail('a@x.io'), 'a***@x***.io');
});

test('格式不完整的邮箱保持原值', () => {
  assert.equal(maskEmail('account-without-domain'), 'account-without-domain');
});
