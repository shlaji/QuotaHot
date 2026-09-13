import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

/**
 * Codex 那条路发完，限额信息可能在响应头里、可能在流里的 rate_limits 事件里，
 * 也可能两处都没有。这里验证的是最后那种：发是发出去了，却读不到窗口——
 * 真实链路上这一步交白卷，调度器就会判定「取不到重置时间」，把账户直接停掉。
 */

let reply: { status: number; headers: Record<string, string>; chunks: string[] } = {
  status: 200,
  headers: {},
  chunks: [],
};

mock.module('../src/server/http.js', {
  exports: {
    request: async () =>
      new FakeResponse(
        reply.status,
        new Headers(reply.headers),
        // 真实链路上流里出来的是 Buffer，不是字符串
        Readable.from(reply.chunks.map((c) => Buffer.from(c))),
      ),
    recordOutbound: () => {},
    noteError: () => {},
  },
});

/** 只需要 sendCodex 真正用到的那几样：状态码、响应头、可迭代且可中断的流。 */
class FakeResponse {
  constructor(
    readonly status: number,
    readonly headers: Headers,
    readonly body: Readable,
  ) {}
  async text(): Promise<string> {
    return '';
  }
}

const { send } = await import('../src/server/providers.js');

const ACCOUNT = {
  id: 'codex:a@x.com',
  provider: 'codex',
  email: 'a@x.com',
  accessToken: 'token',
  accountId: 'aid',
} as never;

const completed = 'data: {"type":"response.completed","response":{"id":"r"}}\n';

test('发出去了却一条窗口都读不到时，按 5 小时估算兜底', async () => {
  reply = { status: 200, headers: {}, chunks: [completed] };

  const before = Date.now();
  const r = await send(ACCOUNT, 'hi', 'gpt-5.6-luna');

  assert.equal(r.ok, true);
  assert.equal(r.windows.length, 1, '不能交白卷——那样这个账户就会失去下一拍');
  assert.equal(r.windows[0].source, 'assumed', '标明这条不是上游说的');
  assert.equal(r.windows[0].name, '5h');
  assert.ok(
    r.windows[0].resetAt >= before + 5 * 3_600_000 && r.windows[0].resetAt <= Date.now() + 5 * 3_600_000,
    '估算的是发送时刻之后 5 小时',
  );
});

test('上游给了限额响应头就用真的，不去估算', async () => {
  const resetAfter = 1234;
  reply = {
    status: 200,
    headers: {
      'x-codex-primary-used-percent': '20',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': String(resetAfter),
    },
    chunks: [completed],
  };

  const r = await send(ACCOUNT, 'hi', 'gpt-5.6-luna');

  assert.equal(r.windows.length, 1);
  assert.equal(r.windows[0].name, 'primary');
  assert.notEqual(r.windows[0].source, 'assumed');
  assert.equal(r.windows[0].usedPercent, 20);
});

test('压根没发出去时不编窗口：网络错误要当成错误报上去', async () => {
  reply = { status: 500, headers: {}, chunks: [] };

  const r = await send(ACCOUNT, 'hi', 'gpt-5.6-luna');

  assert.equal(r.ok, false);
  assert.deepEqual(r.windows, [], '没成功的一发不代表打开了新窗口');
});
