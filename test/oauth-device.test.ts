import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEVICE_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const DEVICE_POLL_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';

const jwt = (claims: Record<string, unknown>) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;

/** 还要回几次“没输完”再放行；用来确认 403 是常态而不是失败。 */
let pendingPolls = 1;
/** 每次申请设备码的响应，按需改成缺字段或非 2xx。 */
let codeResponse: { status: number; body: string } = {
  status: 200,
  // interval 取小数是为了让测试跑得快，顺带覆盖字符串形式的间隔
  body: JSON.stringify({ device_auth_id: 'dev-1', user_code: 'ABCD-EFGH', interval: '0.02' }),
};
let pollBodies: Record<string, unknown>[] = [];
let tokenForm: URLSearchParams | null = null;

mock.module('../src/server/http.js', {
  exports: {
    request: async (url: string, init: { body?: string } = {}) => {
      const reply = (status: number, body: string) => ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
      });
      if (url === DEVICE_CODE_URL) return reply(codeResponse.status, codeResponse.body);
      if (url === DEVICE_POLL_URL) {
        pollBodies.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
        if (pendingPolls-- > 0) return reply(403, '');
        return reply(
          200,
          JSON.stringify({ authorization_code: 'auth-code', code_verifier: 'upstream-verifier' }),
        );
      }
      if (url === TOKEN_URL) {
        tokenForm = new URLSearchParams(init.body ?? '');
        const token = jwt({ email: 'device@example.test', chatgpt_account_id: 'acct-1' });
        return reply(
          200,
          JSON.stringify({ access_token: token, id_token: token, refresh_token: 'r', expires_in: 3600 }),
        );
      }
      throw new Error(`意料之外的出站请求: ${url}`);
    },
    noteError: () => {},
    recordOutbound: () => {},
  },
});

const { startLogin, cancelLogin, completeLogin, loginStatus } = await import(
  '../src/server/oauth.js'
);

function reset(): void {
  pendingPolls = 1;
  pollBodies = [];
  tokenForm = null;
  codeResponse = {
    status: 200,
    body: JSON.stringify({ device_auth_id: 'dev-1', user_code: 'ABCD-EFGH', interval: '0.02' }),
  };
}

test('设备码登录交给用户的是验证码和官方输入页，不是回调地址', async () => {
  reset();
  const s = await startLogin('codex', '', () => {}, 'device');
  assert.equal(s.userCode, 'ABCD-EFGH');
  assert.equal(s.authorizeUrl, 'https://auth.openai.com/codex/device');
  assert.equal(s.redirectUri, 'https://auth.openai.com/deviceauth/callback');
  // 没有账户目录就不该起后台轮询，和 Qoder 一样
  assert.equal(s.listening, false);
  // 设备码的有效期比授权链接长
  assert.ok(s.expiresAt > Date.now() + 10 * 60 * 1000);
  assert.ok(!JSON.stringify(s).includes('verifier'));
  cancelLogin(s.loginId);
});

test('轮询到授权码后用上游给的 verifier 换令牌并落盘', async (t) => {
  reset();
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-device-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const done = Promise.withResolvers<void>();
  const s = await startLogin('codex', dir, () => done.resolve(), 'device');
  assert.equal(s.listening, true, '有账户目录时应该起后台轮询');
  await done.promise;

  // 第一次 403 只说明用户还没输完，不该中断轮询
  assert.ok(pollBodies.length >= 2);
  assert.deepEqual(pollBodies[0], { device_auth_id: 'dev-1', user_code: 'ABCD-EFGH' });

  // 兑换时报的必须是设备码那个回调地址，以及上游下发的 verifier——本地 PKCE 那份对不上
  assert.equal(tokenForm?.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
  assert.equal(tokenForm?.get('code_verifier'), 'upstream-verifier');
  assert.equal(tokenForm?.get('code'), 'auth-code');

  const st = loginStatus(s.loginId);
  assert.equal(st.state, 'done');
  assert.equal(st.accountId, 'codex:device@example.test');
  assert.equal((await readdir(dir)).length, 1);
  cancelLogin(s.loginId);
});

test('设备码会话没有可粘贴的授权码', async () => {
  reset();
  const s = await startLogin('codex', '', () => {}, 'device');
  await assert.rejects(
    () => completeLogin('/tmp/quotahot-should-not-be-written', s.loginId, '随便粘一段'),
    /不需要粘贴/,
  );
  cancelLogin(s.loginId);
});

test('申请设备码失败时当场报错，不留下空会话', async () => {
  reset();
  codeResponse = { status: 200, body: JSON.stringify({ device_auth_id: 'dev-1' }) };
  await assert.rejects(() => startLogin('codex', '', () => {}, 'device'), /没有返回设备码/);

  codeResponse = { status: 500, body: 'boom' };
  await assert.rejects(() => startLogin('codex', '', () => {}, 'device'), /HTTP 500/);
});

test('只有 Codex 能走设备码', async () => {
  reset();
  await assert.rejects(() => startLogin('claude', '', () => {}, 'device'), /只有 Codex/);
  await assert.rejects(() => startLogin('qoder', '', () => {}, 'device'), /只有 Codex/);
});
