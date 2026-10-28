import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorization, fixture, token } from './http-fixture.js';

const businessRequests = [
  ['GET', '/api/v1/capability'], ['GET', '/api/v1/active-target'],
  ['PUT', '/api/v1/active-target'], ['GET', '/api/v1/people/search?query=Person'],
  ['GET', '/api/v1/groups/search?query=Group'], ['DELETE', '/api/v1/active-target'],
  ['GET', '/api/v1/messages'], ['POST', '/api/v1/messages'], ['GET', '/api/v1/events'],
  ['GET', '/api/v1/unknown'],
] as const;

for (const [method, path] of businessRequests) {
  test(`rejects unauthenticated ${method} ${path}`, async (context) => {
    const { app } = await fixture(context);
    const response = await app.request(path, { method });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer');
    assert.equal((await response.text()).includes(token), false);
  });
}

for (const supplied of ['Bearer wrong-secret', `Basic ${token}`, `Bearer ${token} extra`]) {
  test(`rejects invalid authorization form ${supplied.split(' ')[0]}`, async (context) => {
    const { app } = await fixture(context);
    const response = await app.request('/api/v1/capability', { headers: { Authorization: supplied } });
    assert.equal(response.status, 401);
    assert.equal((await response.text()).includes(supplied), false);
  });
}

test('keeps health public', async (context) => {
  const { app } = await fixture(context);
  const response = await app.request('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('accepts explicitly configured Bearer token', async (context) => {
  const { app } = await fixture(context);
  const response = await app.request('/api/v1/capability', { headers: authorization });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes(token), false);
});

for (const bearerToken of ['', '   ', 'token with spaces']) {
  test('rejects unusable token configuration without disclosing it', async (context) => {
    const { service, createApp } = await fixture(context);
    assert.throws(() => createApp(service, { bearerToken }), { name: 'InboxAuthConfigError', message: 'Invalid Inbox authentication configuration' });
  });
}
