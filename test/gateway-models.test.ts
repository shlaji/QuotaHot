import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { Store } from '../src/server/store.js';
import { DEFAULT_CONFIG } from '../src/server/config.js';
import { GatewayPool } from '../src/server/gateway/pool.js';
import type { Account } from '../src/server/creds.js';
import type { GatewayDeps } from '../src/server/gateway/service.js';

type CatalogRequest = {
  readonly headers: Readonly<Record<string, string>>;
  readonly audit?: { readonly accountId: string };
};

type CatalogResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly text: () => Promise<string>;
};

const requests: Array<{ readonly url: string; readonly options: CatalogRequest }> = [];
let qoderStatus = 200;

mock.module('../src/server/http.js', {
  exports: {
    noteError: () => undefined,
    recordOutbound: () => undefined,
    request: async (url: string, options: CatalogRequest): Promise<CatalogResponse> => {
      requests.push({ url, options });
      if (url.startsWith('https://api.anthropic.com/')) {
        return {
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify({ data: [{ id: 'claude-route-model', display_name: 'Claude Route' }] }),
        };
      }
      if (url.startsWith('https://chatgpt.com/')) {
        return {
          status: 200,
          headers: new Headers(),
          text: async () =>
            JSON.stringify({ models: [{ slug: 'codex-route-model', display_name: 'Codex Route', supported_in_api: true }] }),
        };
      }
      return {
        status: qoderStatus,
        headers: new Headers(),
        text: async () => JSON.stringify({ models: [{ id: 'qoder/route-model', display_name: 'Qoder Route' }] }),
      };
    },
  },
});

const { clearCatalogCache } = await import('../src/server/catalog.js');
const { gatewayRoutes } = await import('../src/server/gateway/routes.js');

function account(id: string, provider: Account['provider']): Account {
  return {
    id,
    provider,
    email: `${id}@example.test`,
    path: `/tmp/${id}.json`,
    accountId: id,
    accessToken: `${id}-access-token`,
    refreshToken: '',
    expiresAt: 0,
    disabled: false,
    plan: '',
    subscriptionEndsAt: 0,
    userId: id,
    loginMethod: '',
    source: 'test',
    autoRefresh: false,
    syncPath: '',
    syncSource: '',
    idToken: '',
  };
}

function routeFor(
  accounts: readonly Account[],
  qoderAccountId: string,
  qoderPat: string,
): { readonly app: ReturnType<typeof gatewayRoutes>; readonly close: () => void } {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'quotahot-gateway-models-')), 'state.db'));
  const qoder = accounts.find((item) => item.provider === 'qoder' && item.id === qoderAccountId);
  if (qoder && qoderPat !== '') store.setGatewayAccount(qoder.id, { pat: qoderPat });
  const deps: GatewayDeps = {
    store,
    pool: new GatewayPool(store),
    accounts: async () => [...accounts],
    states: () => new Map(),
    config: () => ({ ...DEFAULT_CONFIG, gateway: { ...DEFAULT_CONFIG.gateway, enabled: true, apiKeys: ['test-key'] } }),
    log: () => undefined,
    changed: () => undefined,
  };
  return { app: gatewayRoutes(deps), close: () => store.close() };
}

type GatewayModel = {
  readonly id: string;
  readonly object: string;
  readonly type: string;
  readonly created: number;
  readonly owned_by: string;
  readonly display_name: string;
};

async function listModels(app: ReturnType<typeof gatewayRoutes>): Promise<{ readonly status: number; readonly body: { readonly object: string; readonly data: readonly GatewayModel[] } }> {
  const response = await app.request('/v1/models', { headers: { authorization: 'Bearer test-key' } });
  return { status: response.status, body: await response.json() };
}

test('GET /v1/models 在混合账户中使用已设置 PAT 的 Qoder 账户并返回三家目录', async (context) => {
  // Given: Claude, Codex, and two Qoder accounts, only one of which has a gateway PAT.
  clearCatalogCache();
  requests.length = 0;
  qoderStatus = 200;
  const { app, close } = routeFor(
    [account('claude-route', 'claude'), account('codex-route', 'codex'), account('qoder-no-pat', 'qoder'), account('qoder-with-pat', 'qoder')],
    'qoder-with-pat',
    'synthetic-qoder-pat',
  );
  context.after(close);

  // When: a client lists models with a valid gateway key.
  const response = await listModels(app);

  // Then: all available providers are represented and Qoder uses the configured gateway credential.
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    object: 'list',
    data: [
      { id: 'claude-route-model', object: 'model', type: 'model', created: 0, owned_by: 'claude', display_name: 'Claude Route' },
      { id: 'codex-route-model', object: 'model', type: 'model', created: 0, owned_by: 'codex', display_name: 'Codex Route' },
      { id: 'qoder/route-model', object: 'model', type: 'model', created: 0, owned_by: 'qoder', display_name: 'Qoder Route' },
    ],
  });
  assert.deepEqual(
    requests.find((request) => request.url.startsWith('https://api.qoder.com/'))?.options.headers,
    { authorization: 'Bearer synthetic-qoder-pat', accept: 'application/json' },
  );
  assert.equal(
    requests.find((request) => request.url.startsWith('https://api.qoder.com/'))?.options.audit?.accountId,
    'qoder-with-pat',
  );
});

test('GET /v1/models 在 Qoder 目录查询失败时保留 Claude 和 Codex 模型', async (context) => {
  // Given: a mixed account pool whose configured Qoder catalog lookup is unavailable.
  clearCatalogCache();
  requests.length = 0;
  qoderStatus = 503;
  const { app, close } = routeFor(
    [account('claude-route', 'claude'), account('codex-route', 'codex'), account('qoder-with-pat', 'qoder')],
    'qoder-with-pat',
    'synthetic-qoder-pat',
  );
  context.after(close);

  // When: a client lists models with a valid gateway key.
  const response = await listModels(app);

  // Then: the failed Qoder catalog is omitted without masking the other providers.
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    object: 'list',
    data: [
      { id: 'claude-route-model', object: 'model', type: 'model', created: 0, owned_by: 'claude', display_name: 'Claude Route' },
      { id: 'codex-route-model', object: 'model', type: 'model', created: 0, owned_by: 'codex', display_name: 'Codex Route' },
    ],
  });
});
