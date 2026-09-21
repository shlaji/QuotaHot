import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../src/web/api.js';

test('imports token files as repeated multipart fields', async () => {
  const first = new File(['first'], 'first.json', { type: 'application/json' });
  const second = new File(['second'], 'second.json', { type: 'application/json' });
  const originalFetch = globalThis.fetch;
  let request: Request | undefined;
  let suppliedHeaders: HeadersInit | undefined;

  globalThis.fetch = async (input, init) => {
    suppliedHeaders = init?.headers;
    request = new Request(new URL(String(input), 'http://localhost'), init);
    return new Response(JSON.stringify({ imported: ['first'], skipped: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await api.importTokenFiles([first, second]);

    assert.deepEqual(result, { imported: ['first'], skipped: [] });
    assert.equal(request?.url, 'http://localhost/api/accounts/import-files');
    assert.equal(request?.method, 'POST');
    assert.equal(suppliedHeaders, undefined);
    assert.match(request?.headers.get('content-type') ?? '', /^multipart\/form-data; boundary=/);
    assert.deepEqual(
      [...(await request?.formData() ?? new FormData())].map(([name, value]) => [
        name,
        value instanceof File ? value.name : value,
      ]),
      [
        ['files', 'first.json'],
        ['files', 'second.json'],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reports upload errors using the API error message', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: 'invalid upload' }), { status: 400 });

  try {
    await assert.rejects(() => api.importTokenFiles([]), { message: 'invalid upload' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
