import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

const calls: Array<{ readonly url: string; readonly transport: unknown }> = [];

mock.module('../src/server/http.js', {
  exports: {
    noteError: () => {},
    recordOutbound: () => {},
    request: async (url: string, options: { readonly transport?: unknown }) => {
      calls.push({ url, transport: options.transport });
      const body = url.includes('reset-credits')
        ? { available_count: 2 }
        : { rate_limit: { allowed: true, primary_window: { reset_after_seconds: 60 } } };
      return {
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify(body),
        json: async () => body,
      };
    },
  },
});

const { queryUsage } = await import('../src/server/usage.js');

const ACCOUNT = {
  id: 'codex:test@example.com',
  provider: 'codex',
  email: 'test@example.com',
  path: '/tmp/account.json',
  accountId: 'account-id',
  accessToken: 'synthetic-token',
  refreshToken: '',
  expiresAt: Date.now() + 60_000,
  disabled: false,
  plan: '',
  subscriptionEndsAt: 0,
  userId: '',
  loginMethod: '',
  source: 'test',
  autoRefresh: false,
  syncPath: '',
  syncSource: '',
  idToken: '',
} as const;

test('Codex usage and reset-credit requests default to undici', async () => {
  calls.length = 0;
  const result = await queryUsage(ACCOUNT);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.transport, 'undici');
  assert.equal(calls[1]?.transport, 'undici');
});

test('Codex usage and reset-credit requests select fetch when requested', async () => {
  calls.length = 0;
  const result = await queryUsage(ACCOUNT, { usageTransport: 'fetch' });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.transport, 'fetch');
  assert.equal(calls[1]?.transport, 'fetch');
});
