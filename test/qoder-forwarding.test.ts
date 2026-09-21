import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { Account } from '../src/server/creds.js';
import type { AnthropicRequest } from '../src/server/gateway/anthropic.js';
import type { signer } from '../src/server/gateway/qoder-signer.js';

type InferParams = Parameters<ReturnType<typeof signer>['prepareInfer']>[0];
const signedRequests: InferParams[] = [];
const sentBodies: string[] = [];
const upstreamChunk = {
  id: 'upstream-message', model: 'upstream-conflicting-model',
  choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }],
};

mock.module('../src/server/gateway/qoder-signer.js', {
  exports: {
    signer: () => ({
      prepareInfer: (params: InferParams) => {
        signedRequests.push(params);
        return { url: 'https://qoder.test/infer', headers: {}, body: Buffer.from('signed-body') };
      },
      decrypt: () => JSON.stringify(upstreamChunk),
    }),
  },
});

mock.module('../src/server/http.js', {
  exports: {
    request: async (url: string, options: { bodyBytes?: Uint8Array }) => {
      if (url === 'https://qoder.test/infer') {
        assert.ok(options.bodyBytes);
        sentBodies.push(Buffer.from(options.bodyBytes).toString());
        return { ok: true, body: Readable.from([Buffer.from('data: encrypted-chunk\n\ndata: [DONE]\n\n')]) };
      }
      if (url.endsWith('/jobToken/exchange')) return { ok: true, json: async () => ({ token: 'test-job-token' }) };
      if (url.endsWith('/userinfo')) return { ok: true, json: async () => ({ uid: 'qoder-user' }) };
      assert.equal(url, 'https://registry.npmjs.org/@qoder-ai/qodercli/latest');
      return { ok: true, json: async () => ({ version: '1.1.36' }) };
    },
    noteError: () => undefined,
    recordOutbound: () => undefined,
  },
});

const { resolveModel, providerFor } = await import('../src/server/gateway/service.js');
const { forwardToQoder } = await import('../src/server/gateway/upstream.js');
const { fromQoderStream } = await import('../src/server/gateway/qoder.js');
const { collect } = await import('../src/server/gateway/anthropic.js');
const { DEFAULT_CONFIG } = await import('../src/server/config.js');

const account: Account = {
  id: 'qoder-user', provider: 'qoder', email: 'test@example.com', path: '/tmp/qoder-test', accountId: 'qoder-user',
  accessToken: '', refreshToken: '', expiresAt: 0, disabled: false, plan: '', subscriptionEndsAt: 0,
  userId: 'qoder-user', loginMethod: '', source: 'oauth', autoRefresh: false, syncPath: '', syncSource: '', idToken: '',
};
const models = ['claude-opus-4-6[1m]', 'Claude-Sonnet-5[200k]', 'anthropic/claude-haiku-4-5',
  'Qoder/Ultimate[1M]', 'qoder/vendor/Custom-Model:Preview', 'qwen3:8b', 'lite'];

for (const model of models) {
  test(`resolveModel preserves exact Qoder model: ${model}`, () => {
    const result = resolveModel(model, 'qoder', DEFAULT_CONFIG);

    assert.equal(result, model);
  });

  test(`Qoder forwarding preserves model at every boundary: ${model}`, async (context) => {
    const request: AnthropicRequest = { model, max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] };

    const events = await forwardToQoder(account, request, {
      model, qoder: { pat: 'test-pat', machineId: 'test-machine', userId: account.userId },
    });
    const response = await collect(events);
    const signed = signedRequests.at(-1);
    assert.ok(signed);
    const body = JSON.parse(signed.bodyJson);

     await context.test('signer modelKey', () => assert.equal(signed.modelKey, model));
     await context.test('body model_config.key', () => assert.equal(body.model_config.key, model));
     await context.test('body model_config.display_name', () => assert.equal(body.model_config.display_name, model));
     await context.test('nested modelConfig.key', () => assert.equal(body.chat_context.extra.modelConfig.key, model));
    await context.test('client-visible model ignores upstream identity', () => assert.equal(response.model, model));
    await context.test('capabilities do not depend on model substrings', () => {
      assert.equal(body.model_config.is_vl, true);
      assert.equal(body.model_config.is_reasoning, false);
      assert.equal(body.model_config.max_input_tokens, 180_000);
      assert.equal(body.parameters.context_length, 180_000);
    });
    assert.equal(sentBodies.at(-1), 'signed-body');
    assert.equal(response.content[0]?.text, 'hello');
  });
}

test('Qoder plaintext SSE preserves the client model when upstream reports another model', async () => {
  const model = 'qoder/Custom-MixedCase[200k]';
  const source = Readable.from([Buffer.from(`data: ${JSON.stringify(upstreamChunk)}\n\n`)]);

  const response = await collect(fromQoderStream(source, () => null, model));

  assert.equal(response.model, model);
});

test('Qoder error stream preserves the client model after an upstream metadata chunk', async () => {
  const model = 'anthropic/Claude-Opus[1m]';
  const source = Readable.from([Buffer.from(
    'data: {"model":"ultimate","choices":[]}\n\ndata: {"error":{"message":"rejected"}}\n\n',
  )]);

  const frames = [];
  for await (const frame of fromQoderStream(source, () => null, model)) frames.push(frame);

  assert.equal(JSON.parse(frames[0].data).message.model, model);
  assert.equal(frames[1].event, 'error');
});

test('provider routing and Claude/Codex model resolution retain existing behavior', () => {
  assert.equal(providerFor('Qoder/Ultimate[1M]'), 'qoder');
  assert.equal(providerFor('claude-opus-4-6[1m]'), 'claude');
  assert.equal(providerFor('openai/gpt-5'), 'codex');
  assert.equal(providerFor('qwen3:8b'), null);
  assert.equal(resolveModel('anthropic/claude-sonnet-5', 'claude', DEFAULT_CONFIG), 'claude-sonnet-5');
  assert.equal(resolveModel('openai/gpt-5', 'codex', DEFAULT_CONFIG), 'gpt-5');
  assert.equal(resolveModel('claude-opus-4-6', 'codex', DEFAULT_CONFIG), DEFAULT_CONFIG.models.codex);
});
