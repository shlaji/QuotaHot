import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { getBypass, getProxy, setProxy, validateProxy } from '../src/server/http.js';
import { shouldBypassProxy } from '../src/shared/proxy.js';

test('代理地址校验：接受 http/https，拒绝残缺 URL 和不支持的协议', () => {
  assert.equal(validateProxy(''), null, '留空表示直连');
  assert.equal(validateProxy('   '), null, '纯空白等同留空');
  assert.equal(validateProxy('http://127.0.0.1:7897'), null);
  assert.equal(validateProxy('https://user:pass@proxy.internal:8443'), null);

  assert.ok(validateProxy('127.0.0.1:7897'), '缺协议应被拒绝');
  assert.ok(validateProxy('garbage'), '非 URL 应被拒绝');
  // undici 的 ProxyAgent 只做 HTTP CONNECT，socks5 能构造却会在发请求时才失败
  assert.ok(validateProxy('socks5://127.0.0.1:1080'), 'socks5 应提前拒绝');
});

test('setProxy 拒绝非法值，且不破坏已生效的 dispatcher', async () => {
  setProxy('http://127.0.0.1:7897');
  assert.equal(getProxy(), 'http://127.0.0.1:7897');

  assert.throws(() => setProxy('127.0.0.1:1080'), /完整 URL/);
  assert.equal(getProxy(), 'http://127.0.0.1:7897', '失败后应保留原代理，而不是退化成直连');

  // 旧 dispatcher 没有被提前关闭，出站请求仍然可用
  const { request } = await import('../src/server/http.js');
  await assert.rejects(
    request('http://127.0.0.1:1/nope', { timeoutMs: 500 }),
    (err: Error) => !/closed|destroyed/i.test(String(err)),
    '应是连接失败，而不是 dispatcher 已关闭',
  );

  setProxy('');
  assert.equal(getProxy(), '', '留空应回到直连');
});

test('忽略代理：主机名、子域、端口、通配与不命中', () => {
  const rules = ['localhost', '.internal', 'example.com:8443', '127.0.0.1'];

  assert.equal(shouldBypassProxy('http://localhost:3000/x', rules), true);
  assert.equal(shouldBypassProxy('http://127.0.0.1/x', rules), true);
  assert.equal(shouldBypassProxy('https://svc.internal/x', rules), true, '子域应命中 .internal');
  assert.equal(shouldBypassProxy('https://internal/x', rules), true, '裸域也应命中');

  // 带端口的规则只在端口一致时生效
  assert.equal(shouldBypassProxy('https://example.com:8443/x', rules), true);
  assert.equal(shouldBypassProxy('https://example.com/x', rules), false, '端口不符不应命中');

  assert.equal(shouldBypassProxy('https://api.anthropic.com/v1/messages', rules), false);
  // 后缀相近但不是子域，不能误命中
  assert.equal(shouldBypassProxy('https://notlocalhost/x', rules), false);

  assert.equal(shouldBypassProxy('https://api.anthropic.com/x', ['*']), true);
  assert.equal(shouldBypassProxy('https://api.anthropic.com/x', []), false);
  assert.equal(shouldBypassProxy('不是合法 URL', ['*']), false, '解析失败应走代理，不能漏出直连');
});

test('忽略代理支持 IPv4 CIDR 网段', () => {
  const rules = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'];

  assert.equal(shouldBypassProxy('http://10.23.4.5/x', rules), true);
  assert.equal(shouldBypassProxy('http://172.31.255.254/x', rules), true);
  assert.equal(shouldBypassProxy('http://192.168.1.1/x', rules), true);
  assert.equal(shouldBypassProxy('http://100.127.255.254/x', rules), true);
  assert.equal(shouldBypassProxy('http://11.0.0.1/x', rules), false);
  assert.equal(shouldBypassProxy('http://172.32.0.1/x', rules), false);
});

test('忽略名单可以单独改，不必重设代理地址', () => {
  setProxy('http://127.0.0.1:7897', ['localhost']);
  assert.deepEqual(getBypass(), ['localhost']);

  setProxy('http://127.0.0.1:7897', ['localhost', '.internal']);
  assert.deepEqual(getBypass(), ['localhost', '.internal']);
  assert.equal(getProxy(), 'http://127.0.0.1:7897', '代理地址不受影响');

  setProxy('', []);
  assert.deepEqual(getBypass(), []);
});

test('fetch transport 使用已配置的代理，而不是绕过 dispatcher 直连', async () => {
  let seenTarget = '';
  const target: Server = createServer((_req, res) => res.end('direct'));
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetPort = (target.address() as AddressInfo).port;

  const proxy: Server = createServer((req, res) => {
    seenTarget = req.url ?? '';
    res.end('proxied');
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const { port } = proxy.address() as AddressInfo;

  try {
    setProxy(`http://127.0.0.1:${port}`, []);
    const { request } = await import('../src/server/http.js');
    const targetUrl = `http://127.0.0.1:${targetPort}/path`;
    const response = await request(targetUrl, {
      transport: 'fetch',
      timeoutMs: 2_000,
    });

    assert.equal(await response.text(), 'proxied');
    assert.equal(seenTarget, targetUrl);
  } finally {
    setProxy('');
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});
