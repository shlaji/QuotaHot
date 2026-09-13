import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import * as undici from 'undici';

const direct: Array<undici.Agent.Options | undefined> = [];
const proxies: Array<string | undici.ProxyAgent.Options> = [];
const requests: string[] = [];
let status = 200;
let body = JSON.stringify({ rate_limit: { allowed: true } });
mock.module('undici', {
  exports: {
    ...undici,
    Agent: class extends undici.Agent {
      constructor(options?: undici.Agent.Options) { super(options); direct.push(options); }
    },
    ProxyAgent: class extends undici.ProxyAgent {
      constructor(options: string | undici.ProxyAgent.Options) { super(options); proxies.push(options); }
    },
    fetch: async (url: string) => {
      requests.push(url);
      return new Response(body, { status });
    },
  },
});
  const { queryHookUsage } = await import('../src/usage.js');
  const { exhaustionOf } = await import('../src/switcher.js');
const account = {
  id: 'fixture', provider: 'codex', email: 'fixture@example.invalid', path: '',
  accountId: 'fixture', accessToken: 'fixture-token', refreshToken: '',
  expiresAt: Date.now() + 86400000, disabled: false, plan: '', subscriptionEndsAt: 0,
  userId: '', loginMethod: '', source: '', autoRefresh: false, syncPath: '', syncSource: '', idToken: '',
} as const;

test('hook owns HTTP1 dispatchers and does not call wrapped global fetch', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Headroom rejects this route'); });
  const result = await queryHookUsage(account, { proxy: 'http://127.0.0.1:7897', noProxy: [] });
  assert.equal(result.ok, true);
  assert.equal(result.quotaAvailable, true);
  const options = proxies.at(-1);
  assert.ok(options && typeof options !== 'string');
  assert.equal(options.allowH2, false);
  assert.equal(options.requestTls?.allowH2, false);
});

test('hook respects proxy bypass while direct transport also disables HTTP2', async () => {
  const count = proxies.length;
  await queryHookUsage(account, { proxy: 'http://127.0.0.1:7897', noProxy: ['chatgpt.com'] });
  assert.equal(proxies.length, count);
  assert.equal(direct.at(-1)?.allowH2, false);
});

test('quota endpoint failures and malformed data cannot become eligible accounts', async () => {
  for (const [code, content, error] of [
    [429, '{}', 'usage_http_429'],
    [401, '{}', 'usage_http_401'],
    [200, '{}', 'missing_quota_data'],
    [200, 'not-json', 'invalid_usage_json'],
  ] as const) {
    status = code;
    body = content;
    requests.length = 0;
    const result = await queryHookUsage(account, { proxy: '', noProxy: [] });
    assert.equal(result.ok, false);
    assert.equal(result.error, error);
    assert.equal(requests.length, 1);
  }
});

test('unrouted endpoints use the alternate path, but never profile or reset-credit requests', async () => {
  status = 404;
  body = '{}';
  requests.length = 0;
  const result = await queryHookUsage(account, { proxy: '', noProxy: [] });
  assert.equal(result.ok, false);
  assert.deepEqual(requests.map((url) => new URL(url).pathname), [
    '/backend-api/wham/usage', '/backend-api/api/codex/usage',
  ]);
});

test('invalid preferred reset field falls through to a valid alternate field', async () => {
  // Given: a snapshot where the preferred reset field is malformed but a later field is valid.
  status = 200;
  body = JSON.stringify({ rate_limit: {
    allowed: true,
    primary_window: { reset_after_seconds: 'invalid', resets_at: '2030-01-01T00:00:00Z', used_percent: 12 },
  } });

  // When: the isolated hook parses the quota response.
  const result = await queryHookUsage(account, { proxy: '', noProxy: [] });

  // Then: it preserves the valid fallback window instead of discarding all reset data.
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0]?.resetAt, Date.parse('2030-01-01T00:00:00Z'));
});

test('Claude used_percentage exhaustion makes a candidate unavailable', async () => {
  // Given: Claude reports a future window exhausted through its historical percentage alias.
  status = 200;
  body = JSON.stringify({ five_hour: {
    used_percentage: 100,
    resets_at: '2030-01-01T00:00:00Z',
  } });

  // When: the hook parses and classifies candidate availability.
  const result = await queryHookUsage({ ...account, provider: 'claude' }, { proxy: '', noProxy: [] });
  const availability = exhaustionOf(result.windows, 95, Date.now());

  // Then: the candidate is exhausted rather than eligible through a null percentage.
  assert.equal(result.windows[0]?.usedPercent, 100);
  assert.equal(availability.exhausted, true);
});
