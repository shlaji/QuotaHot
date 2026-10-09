import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { Store } from '../src/server/store.js';
import { DEFAULT_CONFIG } from '../src/server/config.js';
import { GatewayPool } from '../src/server/gateway/pool.js';
import { event, type AnthropicRequest, type EventStream } from '../src/server/gateway/anthropic.js';
import type { Account } from '../src/server/creds.js';
import type { GatewayDeps } from '../src/server/gateway/service.js';

const forwarded: Array<{ provider: Account['provider']; request: AnthropicRequest; model: string }> = [];
let upstreamStatus = 200;
let upstreamTruncation: 'none' | 'before_delta' | 'before_stop' = 'none';

class FakeUpstreamError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

mock.module('../src/server/gateway/upstream.js', {
  exports: {
    UpstreamError: FakeUpstreamError,
    betasFrom: () => [],
    forward: async (account: Account, request: AnthropicRequest, options: { model: string }): Promise<EventStream> => {
      forwarded.push({ provider: account.provider, request, model: options.model });
      if (upstreamStatus !== 200) throw new FakeUpstreamError(upstreamStatus, 'upstream rejected');
      return (async function* (): EventStream {
        yield event('message_start', { message: { id: 'msg_1', model: options.model, usage: { input_tokens: 3 } } });
        yield event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        yield event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hello' } });
        yield event('content_block_stop', { index: 0 });
        if (upstreamTruncation === 'before_delta') return;
        yield event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
        if (upstreamTruncation === 'before_stop') return;
        yield event('message_stop', {});
      })();
    },
  },
});

const { gatewayRoutes } = await import('../src/server/gateway/routes.js');

function account(provider: Account['provider']): Account {
  return {
    id: `${provider}-route`, provider, email: `${provider}@example.test`, path: '/tmp/route.json',
    accountId: `${provider}-route`, accessToken: 'synthetic-token', refreshToken: '',
    expiresAt: Date.now() + 3_600_000, disabled: false, plan: '', subscriptionEndsAt: 0,
    userId: `${provider}-route`, loginMethod: '', source: 'test', autoRefresh: true,
    syncPath: '', syncSource: '', idToken: '',
  };
}

function fixture(providers: readonly Account['provider'][] = ['codex'], enabled = true) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'quotahot-responses-route-')), 'state.db'));
  const accounts = providers.map(account);
  for (const item of accounts) store.setGatewayAccount(item.id, { enabled: true });
  const deps: GatewayDeps = {
    store, pool: new GatewayPool(store), accounts: async () => accounts, states: () => new Map(),
    config: () => ({ ...DEFAULT_CONFIG, gateway: { ...DEFAULT_CONFIG.gateway, enabled, apiKeys: ['test-key'] } }),
    log: () => undefined, changed: () => undefined,
  };
  forwarded.length = 0;
  upstreamStatus = 200;
  upstreamTruncation = 'none';
  return { app: gatewayRoutes(deps), store, close: () => store.close() };
}

async function post(app: ReturnType<typeof gatewayRoutes>, body: unknown, key = 'test-key'): Promise<Response> {
  return await app.request('/v1/responses', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /v1/responses rejects a missing API key before forwarding', async (context) => {
  const { app, close } = fixture();
  context.after(close);
  const response = await post(app, { model: 'gpt-5', input: 'hello' }, 'wrong-key');
  assert.equal(response.status, 401);
  assert.equal(forwarded.length, 0);
});

test('POST /v1/responses rejects requests while the gateway is disabled', async (context) => {
  const { app, close } = fixture(['codex'], false);
  context.after(close);
  const response = await post(app, { model: 'gpt-5', input: 'hello' });
  assert.equal(response.status, 503);
  assert.equal(forwarded.length, 0);
});

test('POST /v1/responses returns typed 400 for unsupported input before forwarding', async (context) => {
  const { app, close } = fixture();
  context.after(close);
  const response = await post(app, { model: 'gpt-5', input: [{ role: 'user', content: [{ type: 'input_audio', input_audio: 'abc' }] }] });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.type, 'invalid_request_error');
  assert.equal(forwarded.length, 0);
});

test('POST /v1/responses returns 503 when no account is available', async (context) => {
  const { app, close } = fixture([]);
  context.after(close);
  const response = await post(app, { model: 'gpt-5', input: 'hello' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.type, 'overloaded_error');
});

test('POST /v1/responses returns a completed response through the Codex pool', async (context) => {
  const { app, close } = fixture();
  context.after(close);
  const response = await post(app, { model: 'gpt-5', input: 'hello', stream: false });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, 'response');
  assert.equal(body.status, 'completed');
  assert.equal(body.output[0].content[0].text, 'hello');
  assert.equal(forwarded[0]?.provider, 'codex');
  assert.deepEqual(forwarded[0]?.request.messages[0]?.content, [{ type: 'text', text: 'hello' }]);
});

test('POST /v1/responses returns 502 when nonstream upstream ends before message_stop', async (context) => {
  const { app, close } = fixture();
  context.after(close);
  upstreamTruncation = 'before_stop';

  const response = await post(app, { model: 'gpt-5', input: 'hello', stream: false });

  assert.equal(response.status, 502);
});

test('POST /v1/responses stream reports failure when upstream ends before message_delta', async (context) => {
  const { app, close } = fixture();
  context.after(close);
  upstreamTruncation = 'before_delta';

  const response = await post(app, { model: 'gpt-5', input: 'hello', stream: true });

  assert.equal(response.status, 200);
  assert.match(await response.text(), /event: response\.failed/);
});

test('POST /v1/responses streams named response events as SSE', async (context) => {
  const { app, close } = fixture();
  context.after(close);
  const response = await post(app, { model: 'gpt-5', input: 'hello', stream: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const frames = await response.text();
  assert.match(frames, /event: response\.output_text\.delta/);
  assert.match(frames, /event: response\.completed/);
  assert.equal(forwarded[0]?.provider, 'codex');
});

test('POST /v1/responses shares model-based routing with other endpoints', async (context) => {
  const { app, close } = fixture(['claude', 'codex']);
  context.after(close);
  const response = await post(app, { model: 'claude-sonnet-5', input: 'hello' });
  assert.equal(response.status, 200);
  assert.equal(forwarded[0]?.provider, 'claude');
});

test('POST /v1/responses forwards qoder/efficient through an enabled Qoder account with PAT', async (context) => {
  const { app, store, close } = fixture(['qoder']);
  context.after(close);
  store.setGatewayAccount('qoder-route', { pat: 'synthetic-pat' });

  const response = await post(app, { model: 'qoder/efficient', input: 'hello' });

  assert.equal(response.status, 200);
  assert.equal(forwarded[0]?.provider, 'qoder');
  assert.equal(forwarded[0]?.model, 'qoder/efficient');
});

test('POST /v1/responses gives distinct response IDs to requests in the same millisecond', async (context) => {
  const { app, close } = fixture();
  context.after(close);
  const clock = mock.method(Date, 'now', () => 1_700_000_000_000);
  context.after(() => clock.mock.restore());

  const first = await post(app, { model: 'gpt-5', input: 'first' });
  const second = await post(app, { model: 'gpt-5', input: 'second' });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual((await first.json()).id, (await second.json()).id);
});

test('POST /v1/responses maps pre-stream upstream failures to HTTP status', async (context) => {
  const { app, close } = fixture();
  context.after(close);
  upstreamStatus = 400;
  const response = await post(app, { model: 'gpt-5', input: 'hello', stream: true });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.type, 'api_error');
});
