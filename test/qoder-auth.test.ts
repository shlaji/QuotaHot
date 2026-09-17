import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertQoderIdentity } from '../src/server/gateway/qoder-auth.js';

test('Qoder PAT 身份必须与目标账户一致', () => {
  assert.doesNotThrow(() => assertQoderIdentity('qoder-user-a', 'qoder-user-a'));
  assert.throws(
    () => assertQoderIdentity('qoder-user-a', 'qoder-user-b'),
    /Qoder PAT 身份与账户不一致/,
  );
});

test('缺少任一稳定身份时拒绝绑定 Qoder PAT', () => {
  assert.throws(() => assertQoderIdentity('', 'qoder-user-a'), /Qoder PAT 身份无法确认/);
  assert.throws(() => assertQoderIdentity('qoder-user-a', ''), /Qoder PAT 身份无法确认/);
});
