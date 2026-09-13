import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountIdMismatch, loadAccounts } from '../src/server/creds.js';

/** A JWT with the given claims and a throwaway signature. Nothing here is a real token. */
function fakeJwt(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.signature`;
}

async function authDirWith(file: string, data: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-creds-'));
  await writeFile(join(dir, file), JSON.stringify(data), 'utf8');
  return dir;
}

test('从 codex id_token 的声明里读出套餐、订阅到期、用户 ID 和登录方式', async () => {
  const until = Math.floor(Date.parse('2026-10-02T17:35:00Z') / 1000);
  const dir = await authDirWith('codex-a.json', {
    type: 'codex',
    email: 'a@example.com',
    account_id: 'acct-1',
    access_token: 'not-a-jwt',
    id_token: fakeJwt({
      sub: 'google-oauth2|1234567890',
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'plus',
        chatgpt_subscription_active_until: until,
        user_id: 'user-abc',
      },
    }),
  });

  const [acct] = await loadAccounts(dir);
  assert.equal(acct.plan, 'plus');
  assert.equal(acct.subscriptionEndsAt, until * 1000);
  assert.equal(acct.userId, 'user-abc');
  assert.equal(acct.loginMethod, 'Google');
});

test('没有 id_token 时退回 access_token 的声明', async () => {
  const dir = await authDirWith('codex-b.json', {
    type: 'codex',
    email: 'b@example.com',
    access_token: fakeJwt({ sub: 'auth0|42', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } }),
  });

  const [acct] = await loadAccounts(dir);
  assert.equal(acct.plan, 'pro');
  assert.equal(acct.loginMethod, 'Password');
  assert.equal(acct.subscriptionEndsAt, 0, '没写到期时间就该留 0，而不是猜一个');
});

test('token 不是 JWT 时账户照常加载，只是声明为空', async () => {
  const dir = await authDirWith('claude-c.json', {
    type: 'claude',
    email: 'c@example.com',
    access_token: 'sk-ant-oat01-opaque',
    expired: '2027-01-01T00:00:00Z',
  });

  const [acct] = await loadAccounts(dir);
  assert.equal(acct.email, 'c@example.com');
  assert.equal(acct.plan, '');
  assert.equal(acct.userId, '');
  assert.equal(acct.loginMethod, '');
  assert.equal(acct.expiresAt, Date.parse('2027-01-01T00:00:00Z'));
});

test('id_token 与 access_token 的账户不一致时能被识别出来', () => {
  const a = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-a' } });
  const b = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-b' } });
  assert.match(accountIdMismatch(a, b), /acct-a/);
  assert.match(accountIdMismatch(a, b), /acct-b/);
  assert.equal(accountIdMismatch(a, a), '');
});

test('任一侧没有账户 ID 时不判定为不一致', () => {
  // Claude 的令牌里根本没有这个字段，缺失不能当成冲突，否则刷新会被误拒
  const withId = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-a' } });
  assert.equal(accountIdMismatch(withId, fakeJwt({ sub: 'user' })), '');
  assert.equal(accountIdMismatch('', withId), '');
});
