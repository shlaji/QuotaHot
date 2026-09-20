import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { AddressInfo } from 'node:net';
import {
  noteError,
  recordOutbound,
  request,
  setAuditSink,
  type AuditSink,
} from '../src/server/http.js';
import type { RequestRecord } from '../src/shared/types.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function serve(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const srv: Server = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

interface Row {
  accountId: string;
  req: RequestRecord;
  kind: string;
  status: number;
  error: string;
  response: string;
}

function collector(): { rows: Row[]; sink: AuditSink } {
  const rows: Row[] = [];
  return {
    rows,
    sink: {
      record: (accountId, _sentAt, req, status, _durationMs, error, kind) =>
        rows.push({ accountId, req, kind, status, error, response: '' }),
      update: (rowId, error) => {
        rows[rowId - 1].error = error;
      },
      updateResponse: (rowId, response) => {
        rows[rowId - 1].response = response;
      },
    },
  };
}

test('请求头逐字发出，不夹带浏览器语义的额外头', async () => {
  let seen: string[] = [];
  const s = await serve((req, res) => {
    seen = req.rawHeaders;
    res.end('{}');
  });
  await request(s.url, {
    method: 'POST',
    headers: { 'x-app': 'cli', 'user-agent': 'claude-cli/2.1.220 (external, cli)' },
    body: '{}',
  });
  await s.close();

  const names = seen.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase());
  // fetch 会强行补上这些，真实 CLI 一个都不会发
  assert.ok(!names.includes('sec-fetch-mode'), `不该出现 sec-fetch-mode：${names.join(',')}`);
  assert.ok(!names.includes('accept-language'));
  assert.ok(names.includes('x-app'));
  assert.equal(seen[seen.indexOf('user-agent') + 1], 'claude-cli/2.1.220 (external, cli)');
});

test('gzip 响应会被解开，因为低层 request 不自己解压', async () => {
  const s = await serve((_req, res) => {
    res.setHeader('content-encoding', 'gzip');
    res.end(gzipSync(Buffer.from('{"five_hour":{"utilization":27}}')));
  });
  const resp = await request(s.url);
  const body = await resp.text();
  await s.close();
  assert.equal(body, '{"five_hour":{"utilization":27}}');
  assert.deepEqual(JSON.parse(body).five_hour.utilization, 27);
});

test('带 audit 的请求会落一条日志，令牌换成占位符', async () => {
  const { rows, sink } = collector();
  setAuditSink(sink);
  const s = await serve((_req, res) => res.end('{}'));
  const token = 'sk-ant-oat01-SECRETSECRETSECRET';
  await request(s.url, {
    headers: { authorization: `Bearer ${token}` },
    audit: { accountId: 'a@x.com', secrets: { accessToken: token } },
  });
  await s.close();
  setAuditSink(null);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].accountId, 'a@x.com');
  assert.equal(rows[0].status, 200);
  assert.equal(rows[0].kind, 'persistent');
  assert.equal(rows[0].req.headers.authorization, 'Bearer $QUOTAHOT_TOKEN');
});

test('网关 audit 会标记为临时记录', async () => {
  const { rows, sink } = collector();
  setAuditSink(sink);
  const s = await serve((_req, res) => res.end('{}'));
  await request(s.url, {
    audit: { accountId: 'a@x.com', kind: 'gateway', secrets: { accessToken: 'x' } },
  });
  await s.close();
  setAuditSink(null);

  assert.equal(rows[0].kind, 'gateway');
});

test('额度查询这类只读请求同样留痕，不是只有发送才记', async () => {
  const { rows, sink } = collector();
  setAuditSink(sink);
  const s = await serve((_req, res) => {
    res.statusCode = 403;
    res.end('nope');
  });
  const audit = { accountId: 'a@x.com', secrets: { accessToken: 'x' } };
  const resp = await request(s.url, { audit });
  // 状态码在拿到响应头时就落了行，错误详情要等读完响应体才补上
  noteError(audit, `HTTP ${resp.status}: ${await resp.text()}`);
  await s.close();
  setAuditSink(null);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 403);
  assert.equal(rows[0].error, 'HTTP 403: nope');
});

test('网关错误回填保留临时记录类型', async () => {
  const { rows, sink } = collector();
  setAuditSink(sink);
  const s = await serve((_req, res) => {
    res.statusCode = 502;
    res.end('upstream down');
  });
  const audit = { accountId: 'a@x.com', kind: 'gateway' as const, secrets: { accessToken: 'x' } };
  const resp = await request(s.url, { audit });
  noteError(audit, `HTTP ${resp.status}: ${await resp.text()}`);
  await s.close();
  setAuditSink(null);

  assert.equal(rows[0].kind, 'gateway');
  assert.equal(rows[0].error, 'HTTP 502: upstream down');
});

test('连不上时也落一行，状态码 0', async () => {
  const { rows, sink } = collector();
  setAuditSink(sink);
  // 监听后立刻关掉，端口必定无人应答
  const s = await serve(() => {});
  await s.close();
  await assert.rejects(
    request(s.url, {
      timeoutMs: 2000,
      audit: { accountId: 'a@x.com', secrets: { accessToken: 'x' } },
    }),
  );
  setAuditSink(null);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 0, '连接都没建起来');
  assert.match(rows[0].error, /^network:/);
});

test('没接 sink 时记账是空操作，测试和 CLI 不必带数据库', async () => {
  setAuditSink(null);
  const s = await serve((_req, res) => res.end('ok'));
  const resp = await request(s.url, {
    audit: { accountId: 'a@x.com', secrets: { accessToken: 'x' } },
  });
  assert.equal(await resp.text(), 'ok');
  await s.close();
});

test('响应体随流留痕，读完就补进那一行日志', async () => {
  const { rows, sink } = collector();
  setAuditSink(sink);
  const s = await serve((_req, res) => {
    res.statusCode = 429;
    res.end('{"error":{"message":"rate limit"}}');
  });
  const resp = await request(s.url, {
    audit: { accountId: 'a@x.com', secrets: { accessToken: 'x' } },
  });
  assert.equal(await resp.text(), '{"error":{"message":"rate limit"}}');
  await s.close();
  setAuditSink(null);

  assert.equal(rows[0].status, 429);
  assert.equal(rows[0].response, '{"error":{"message":"rate limit"}}');
});

test('留下的是解压后的正文，不是压缩字节', async () => {
  const { rows, sink } = collector();
  setAuditSink(sink);
  const s = await serve((_req, res) => {
    res.setHeader('content-encoding', 'gzip');
    res.end(gzipSync(Buffer.from('{"five_hour":{"utilization":27}}')));
  });
  const resp = await request(s.url, {
    audit: { accountId: 'a@x.com', secrets: { accessToken: 'x' } },
  });
  await resp.text();
  await s.close();
  setAuditSink(null);

  assert.equal(rows[0].response, '{"five_hour":{"utilization":27}}');
});

test('流式请求提前掐断时，留下的是已经读到的那一截', async () => {
  const { rows, sink } = collector();
  setAuditSink(sink);
  const s = await serve((_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: {"type":"response.completed"}\n\n');
    // 之后还会有很多事件，但调用方读到需要的就走了，这里不再往下写
  });
  const resp = await request(s.url, {
    audit: { accountId: 'a@x.com', secrets: { accessToken: 'x' } },
  });
  for await (const chunk of resp.body) {
    assert.match(String(chunk), /response\.completed/);
    break;
  }
  resp.body.destroy();
  // destroy 是异步收尾的，等一拍再看落库结果
  await new Promise((r) => setImmediate(r));
  await s.close();
  setAuditSink(null);

  assert.match(rows[0].response, /response\.completed/);
});

test('响应体里的凭证同样不落库：发出去的按值抹，上游新发的按字段抹', async () => {
  const { rows, sink } = collector();
  setAuditSink(sink);
  const token = 'sk-ant-oat01-SECRETSECRETSECRET';
  const s = await serve((_req, res) =>
    res.end(
      JSON.stringify({ echoed: token, access_token: 'brand-new-one', refresh_token: 'rt-new' }),
    ),
  );
  const resp = await request(s.url, {
    audit: { accountId: 'a@x.com', secrets: { accessToken: token } },
  });
  await resp.text();
  await s.close();
  setAuditSink(null);

  assert.doesNotMatch(rows[0].response, /SECRETSECRETSECRET/);
  assert.match(rows[0].response, /\$QUOTAHOT_TOKEN/);
  assert.doesNotMatch(rows[0].response, /brand-new-one|rt-new/);
});

test('超长响应体只留开头一截，并注明被截断了', async () => {
  const { rows, sink } = collector();
  setAuditSink(sink);
  const huge = 'x'.repeat(200_000);
  const s = await serve((_req, res) => res.end(huge));
  const resp = await request(s.url, {
    audit: { accountId: 'a@x.com', secrets: { accessToken: 'x' } },
  });
  // 调用方拿到的仍是完整正文，截断只发生在日志那一侧
  assert.equal((await resp.text()).length, huge.length);
  await s.close();
  setAuditSink(null);

  assert.ok(rows[0].response.length < huge.length);
  assert.match(rows[0].response, /响应体过长/);
});

test('不走 HTTP 的那一发（本机 CLI）记进同一张表，令牌与输出都过一遍脱敏', () => {
  const { rows, sink } = collector();
  setAuditSink(sink);
  const token = 'sk-ant-oat01-SECRETSECRETSECRET';
  recordOutbound(
    { accountId: 'a@x.com', secrets: { accessToken: token } },
    Date.now(),
    {
      method: 'EXEC',
      url: 'cli://claude',
      headers: { CLAUDE_CODE_OAUTH_TOKEN: token },
      body: `claude --print -- 'ping'`,
    },
    401,
    1200,
    'Failed to authenticate',
    `拒绝了 ${token}\n{"access_token":"brand-new-one"}`,
  );
  setAuditSink(null);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].req.headers.CLAUDE_CODE_OAUTH_TOKEN, '$QUOTAHOT_TOKEN');
  assert.equal(rows[0].status, 401);
  // 输出里的令牌同样要抹：日志是拿去截图发给别人的
  assert.match(rows[0].response, /拒绝了 \$QUOTAHOT_TOKEN/);
  assert.doesNotMatch(rows[0].response, /brand-new-one/);
});
