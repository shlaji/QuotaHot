import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

type CatalogRequest = {
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly audit: {
    readonly accountId: string;
    readonly secrets: Readonly<Record<string, string>>;
  };
};

type CatalogResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly text: () => Promise<string>;
};

const requests: Array<{ readonly url: string; readonly options: CatalogRequest }> = [];
let responseStatus = 200;
let responseBody = JSON.stringify({ models: [] });

mock.module('../src/server/http.js', {
  exports: {
    noteError: () => undefined,
    recordOutbound: () => undefined,
    request: async (url: string, options: CatalogRequest): Promise<CatalogResponse> => {
      requests.push({ url, options });
      return {
        status: responseStatus,
        headers: new Headers(),
        text: async () => responseBody,
      };
    },
  },
});

const { catalogFor, clearCatalogCache, parseQoderModels } = await import('../src/server/catalog.js');

const ACCOUNT = {
  id: 'qoder:catalog@example.test',
  provider: 'qoder',
  email: 'catalog@example.test',
  path: '/tmp/qoder-catalog.json',
  accountId: 'qoder-user',
  accessToken: '',
  refreshToken: '',
  expiresAt: 0,
  disabled: false,
  plan: '',
  subscriptionEndsAt: 0,
  userId: 'qoder-user',
  loginMethod: '',
  source: 'test',
  autoRefresh: false,
  syncPath: '',
  syncSource: '',
  idToken: '',
} as const;

function resetResponse(status: number, body: string): void {
  requests.length = 0;
  responseStatus = status;
  responseBody = body;
  clearCatalogCache();
}

test('Qoder 目录：保留启用模型，跳过禁用与畸形记录', () => {
  // Given: Cloud Mode mixes usable, disabled, and malformed model records.
  const payload = {
    models: [
      { id: 'qoder/efficient', display_name: 'Qoder Efficient', is_enabled: true },
      { id: 'qoder/default-label', is_enabled: true },
      { id: 'qoder/disabled', display_name: 'Disabled', is_enabled: false },
      { id: '', display_name: 'Missing ID', is_enabled: true },
      null,
      'not-a-model',
    ],
  };

  // When: the Qoder catalog payload is parsed.
  const options = parseQoderModels(payload);

  // Then: only enabled records with IDs become model options.
  assert.deepEqual(options, [
    { id: 'qoder/efficient', label: 'Qoder Efficient' },
    { id: 'qoder/default-label', label: 'qoder/default-label' },
  ]);
});

test('Qoder 目录：支持文档中的 data 数组响应形状', () => {
  const options = parseQoderModels({
    data: [{ id: 'qoder/efficient', display_name: 'Qoder Efficient', is_enabled: true }],
  });

  assert.deepEqual(options, [{ id: 'qoder/efficient', label: 'Qoder Efficient' }]);
});

test('Qoder 目录：畸形或空响应给空列表', () => {
  // Given: malformed and empty Cloud Mode payloads.
  const payloads: readonly unknown[] = [null, {}, { models: 'not-an-array' }, { models: [] }];

  // When: each payload is parsed.
  const options = payloads.map((payload) => parseQoderModels(payload));

  // Then: the parser returns empty options instead of throwing.
  assert.deepEqual(options, [[], [], [], []]);
});

test('Qoder 目录适配器：使用 Cloud URL、Bearer PAT、超时和 PAT 审计脱敏', async () => {
  // Given: an enabled Qoder account and a gateway-only credential.
  const credential = 'synthetic-qoder-catalog-credential';
  resetResponse(200, JSON.stringify({ models: [{ id: 'qoder/efficient', display_name: 'Qoder Efficient' }] }));

  // When: its catalog is loaded.
  const catalog = await catalogFor('qoder', ACCOUNT, credential, 1);

  // Then: the adapter makes the Cloud Mode request with the gateway credential and audit secret.
  assert.deepEqual(catalog, {
    options: [{ id: 'qoder/efficient', label: 'Qoder Efficient' }],
    fromUpstream: true,
    error: '',
  });
  assert.deepEqual(requests, [
    {
      url: 'https://api.qoder.com/api/v1/cloud/models',
      options: {
        headers: { authorization: `Bearer ${credential}`, accept: 'application/json' },
        timeoutMs: 15_000,
        audit: { accountId: ACCOUNT.id, secrets: { accessToken: credential, accessTokenPlaceholder: '$QUOTAHOT_GATEWAY_TOKEN' } },
      },
    },
  ]);
});

test('Qoder 目录适配器：缺失 PAT、失败响应、坏 JSON 和空模型都返回空选项', async () => {
  // Given: each expected Qoder catalog failure mode.
  const credential = 'synthetic-qoder-catalog-credential';
  const cases: readonly { readonly status: number; readonly body: string; readonly credential: string }[] = [
    { status: 200, body: JSON.stringify({ models: [{ id: 'qoder/efficient' }] }), credential: '' },
    { status: 503, body: '{}', credential },
    { status: 200, body: '{', credential },
    { status: 200, body: JSON.stringify({ models: [] }), credential },
  ];

  // When: catalog loading encounters each failure mode.
  const catalogs = [];
  const requestCounts: number[] = [];
  for (const item of cases) {
    resetResponse(item.status, item.body);
    catalogs.push(await catalogFor('qoder', ACCOUNT, item.credential, 1));
    requestCounts.push(requests.length);
  }

  // Then: every failure is contained as an empty Qoder catalog.
  assert.deepEqual(
    catalogs.map((catalog) => catalog.options),
    [[], [], [], []],
  );
  assert.ok(catalogs.every((catalog) => !catalog.fromUpstream));
  assert.deepEqual(requestCounts, [0, 1, 1, 1]);
});
