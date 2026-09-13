import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let entered = Promise.withResolvers<void>();
let release = Promise.withResolvers<void>();
let profileEntered = Promise.withResolvers<void>();
let profileRelease = Promise.withResolvers<void>();
let profileDone = Promise.withResolvers<void>();
mock.module('../src/server/qoder.js', { exports: {
  QODER_DEVICE_REDIRECT_URI: 'qoder://test',
  buildQoderLoginUrl: () => 'https://example.test/authorize',
  readQoderMachine: async () => null,
  qoderLoginMachineId: async () => '',
  readQoderSnapshot: () => null,
  qoderStateDbPath: () => '',
  profileOf: () => null,
  pollQoderDeviceToken: async () => ({ accessToken: 'test-token', refreshToken: '', userId: 'user', expiresAt: 0 }),
  fetchQoderLoginProfile: async () => {
    profileEntered.resolve();
    await profileRelease.promise;
    setImmediate(() => profileDone.resolve());
    return { email: 'qoder@example.test', userId: 'user', accessToken: 'test-token', plan: '', expiresAt: 0 };
  },
} });
mock.module('../src/server/http.js', { exports: {
  request: async () => {
    entered.resolve();
    await release.promise;
    const token = `x.${Buffer.from(JSON.stringify({ email: 'cancel@example.test' })).toString('base64url')}.x`;
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: token, id_token: token, expires_in: 3600 }) };
  }, noteError: () => {}, recordOutbound: () => {},
} });
const { startLogin, cancelLogin, completeLogin } = await import('../src/server/oauth.js');

test('取消进行中的授权码交换后不保存账户', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-oauth-cancel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  entered = Promise.withResolvers<void>();
  release = Promise.withResolvers<void>();
  const login = await startLogin('codex');
  const state = new URL(login.authorizeUrl).searchParams.get('state');
  const completion = completeLogin(dir, login.loginId, `code#${state}`);
  await entered.promise;
  cancelLogin(login.loginId);
  release.resolve();
  await assert.rejects(completion);
  assert.deepEqual(await readdir(dir), []);
});

test('取消进行中的 Qoder 资料查询后不保存账户或通知完成', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-qoder-cancel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  profileEntered = Promise.withResolvers<void>();
  profileRelease = Promise.withResolvers<void>();
  profileDone = Promise.withResolvers<void>();
  let completed = false;
  const keepAlive = setTimeout(() => {}, 10000);
  t.after(() => clearTimeout(keepAlive));
  const login = await startLogin('qoder', dir, () => { completed = true; });
  await profileEntered.promise;
  cancelLogin(login.loginId);
  profileRelease.resolve();
  await profileDone.promise;
  assert.equal(completed, false);
  assert.deepEqual(await readdir(dir), []);
});
