import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cancelLogin, loginStatus, parseCallbackInput, startLogin } from '../src/server/oauth.js';

test('回调地址、code#state、裸 code 三种粘贴形式都能解析', () => {
  assert.deepEqual(
    parseCallbackInput('http://localhost:1455/auth/callback?code=abc&state=xyz'),
    { code: 'abc', state: 'xyz' },
  );
  assert.deepEqual(parseCallbackInput('  abc#xyz  '), { code: 'abc', state: 'xyz' });
  assert.deepEqual(parseCallbackInput('abc'), { code: 'abc', state: '' });
  assert.deepEqual(parseCallbackInput(''), { code: '', state: '' });
});

test('授权入口链接自带的 code=true 不会被当成授权码', () => {
  const url = 'https://claude.com/cai/oauth/authorize?code=true&state=xyz';
  // 用户很容易误把第一步的链接粘回来；这时应该退回到按裸文本解析，而不是拿 "true" 去换令牌
  assert.notEqual(parseCallbackInput(url).code, 'true');
});

test('授权链接带上 PKCE 挑战和登录态', async () => {
  const claude = await startLogin('claude');
  const url = new URL(claude.authorizeUrl);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.equal(url.searchParams.get('redirect_uri'), claude.redirectUri);
  assert.ok(claude.expiresAt > Date.now());
  // code_verifier 只留在服务端内存里，绝不能出现在给前端的响应中
  assert.ok(!JSON.stringify(claude).includes('code_verifier'));
  cancelLogin(claude.loginId);

  const codex = await startLogin('codex');
  assert.notEqual(codex.loginId, claude.loginId);
  assert.match(codex.authorizeUrl, /^https:\/\/auth\.openai\.com\/oauth\/authorize/);
  cancelLogin(codex.loginId);
});

test('Qoder 走设备码：链接带 nonce 和 PKCE 挑战，回调是自定义协议', async () => {
  const q = await startLogin('qoder');
  const url = new URL(q.authorizeUrl);
  assert.equal(url.origin + url.pathname, 'https://qoder.com/device/selectAccounts');
  assert.equal(url.searchParams.get('challenge_method'), 'S256');
  assert.ok(url.searchParams.get('challenge'));
  // nonce 必须是无分隔符的 uuid，官方授权页按这个格式校验
  assert.match(url.searchParams.get('nonce') ?? '', /^[0-9a-f]{32}$/);
  assert.equal(url.searchParams.get('redirect_uri'), q.redirectUri);
  assert.equal(q.redirectUri, 'qoder://aicoding.aicoding-agent/login-success');
  // verifier 只留在服务端内存里，它就是换令牌的凭据
  assert.ok(!JSON.stringify(q).includes('verifier'));
  // 没有账户目录就不该起后台轮询
  assert.equal(q.listening, false);
  cancelLogin(q.loginId);
});

test('Qoder 登录没有可粘贴的授权码', async () => {
  const { completeLogin } = await import('../src/server/oauth.js');
  const q = await startLogin('qoder');
  await assert.rejects(
    () => completeLogin('/tmp/quotahot-should-not-be-written', q.loginId, '随便粘一段'),
    /不需要粘贴/,
  );
  cancelLogin(q.loginId);
});

test('用错误的 state 完成登录会被拒绝', async () => {
  const { completeLogin } = await import('../src/server/oauth.js');
  const s = await startLogin('codex');
  await assert.rejects(
    () => completeLogin('/tmp/quotahot-should-not-be-written', s.loginId, 'code#wrong-state'),
    /授权状态不匹配/,
  );
  cancelLogin(s.loginId);
});

test('不给账户目录就不起监听，Claude 任何时候都不起', async () => {
  // 没有落盘目标时接住回调也没法收尾，所以不该白占端口
  const anon = await startLogin('codex');
  assert.equal(anon.listening, false);
  cancelLogin(anon.loginId);

  // Claude 的回调落在 platform.claude.com 上，本地监听接不到
  const claude = await startLogin('claude', '/tmp/quotahot-test-accounts');
  assert.equal(claude.listening, false);
  cancelLogin(claude.loginId);
});

test('1455 端口被占用时退回手动粘贴，而不是让登录失败', async () => {
  const blocker = createServer(() => {});
  await new Promise<void>((resolve) => blocker.listen(1455, '127.0.0.1', resolve));
  try {
    const s = await startLogin('codex', '/tmp/quotahot-test-accounts');
    assert.equal(s.listening, false);
    assert.match(s.listenError, /端口/);
    // 授权链接照常可用，用户仍然可以把回调地址粘回来
    assert.ok(s.authorizeUrl.includes('code_challenge='));
    cancelLogin(s.loginId);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test('监听起来之后能被查询状态，取消会立刻把端口还回去', async () => {
  const s = await startLogin('codex', '/tmp/quotahot-test-accounts');
  assert.equal(s.listening, true, '端口空闲时应该起得来监听');
  assert.equal(loginStatus(s.loginId).state, 'pending');

  cancelLogin(s.loginId);
  assert.equal(loginStatus(s.loginId).state, 'expired');

  // 端口已经释放，同一个端口能被立即重新绑定
  const probe = createServer(() => {});
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(1455, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

test('回调带错的 state 会被监听端拒绝，且不会去换令牌', async () => {
  const s = await startLogin('codex', '/tmp/quotahot-test-accounts');
  assert.equal(s.listening, true);
  try {
    const resp = await fetch('http://127.0.0.1:1455/auth/callback?code=x&state=wrong');
    assert.equal(resp.status, 400);
    assert.match(await resp.text(), /授权状态不匹配/);
    assert.equal(loginStatus(s.loginId).state, 'error');
  } finally {
    cancelLogin(s.loginId);
  }
});

test('用户在授权页点拒绝时，监听端把原因报回来', async () => {
  const s = await startLogin('codex', '/tmp/quotahot-test-accounts');
  try {
    const resp = await fetch('http://127.0.0.1:1455/auth/callback?error=access_denied');
    assert.equal(resp.status, 400);
    const st = loginStatus(s.loginId);
    assert.equal(st.state, 'error');
    assert.match(st.error, /access_denied/);
    // 回调路径以外的请求不该被当成授权结果
    assert.equal((await fetch('http://127.0.0.1:1455/favicon.ico')).status, 404);
  } finally {
    cancelLogin(s.loginId);
  }
});
