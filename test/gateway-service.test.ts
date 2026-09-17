import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accounted, type GatewayDeps } from '../src/server/gateway/service.js';
import { event, type EventStream } from '../src/server/gateway/anthropic.js';
import { DEFAULT_GATEWAY_CONFIG } from '../src/shared/gateway.js';
import type { Account } from '../src/server/creds.js';

const account: Account = {
  id: 'qoder-user-a', provider: 'qoder', email: 'a@example.com', path: '/tmp/a', accountId: 'qoder-user-a',
  accessToken: '', refreshToken: '', expiresAt: 0, disabled: false, plan: '', subscriptionEndsAt: 0,
  userId: 'qoder-user-a', loginMethod: '', source: 'oauth', autoRefresh: false, syncPath: '', syncSource: '',
  idToken: '',
};

function deps(calls: string[]): GatewayDeps {
  return {
    pool: {
      succeed: () => calls.push('succeed'),
      fail: () => calls.push('fail'),
    },
    changed: () => undefined,
    log: () => undefined,
  } as unknown as GatewayDeps;
}

test('流正常结束后才记为成功', async () => {
  const calls: string[] = [];
  const source = (async function* (): EventStream {
    yield event('message_start', { message: { usage: { input_tokens: 2, output_tokens: 0 } } });
    yield event('message_delta', { usage: { output_tokens: 3 } });
  })();

  const received: string[] = [];
  for await (const frame of accounted(deps(calls), account, source, DEFAULT_GATEWAY_CONFIG)) {
    received.push(frame.event);
  }

  assert.deepEqual(received, ['message_start', 'message_delta']);
  assert.deepEqual(calls, ['succeed']);
});

test('流式上游异常时不记为成功而记为失败', async () => {
  const calls: string[] = [];
  const source = (async function* (): EventStream {
    yield event('message_start', { message: { usage: { input_tokens: 2 } } });
    throw new Error('upstream disconnected');
  })();

  await assert.rejects(
    (async () => {
      for await (const _frame of accounted(deps(calls), account, source, DEFAULT_GATEWAY_CONFIG)) {
      }
    })(),
    /upstream disconnected/,
  );
  assert.deepEqual(calls, ['fail']);
});

test('上游 error 事件后正常结束也不能记为成功', async () => {
  const calls: string[] = [];
  const source = (async function* (): EventStream {
    yield event('error', { error: { message: 'upstream rejected' } });
  })();

  for await (const _frame of accounted(deps(calls), account, source, DEFAULT_GATEWAY_CONFIG)) {
  }

  assert.deepEqual(calls, ['fail']);
});
