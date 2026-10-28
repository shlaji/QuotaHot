import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InboxStore } from '../src/inbox/store.js';
import { authorization, fixture, target } from './http-fixture.js';

test('reports unavailable capability without probing DWS', async (context) => {
  const { app } = await fixture(context);
  const response = await app.request('/api/v1/capability', { headers: authorization });
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null && 'available' in body && 'reason' in body);
  assert.equal(body.available, false);
  assert.equal(typeof body.reason, 'string');
  assert.deepEqual(Object.keys(body).sort(), ['available', 'reason']);
});

for (const kind of ['people', 'groups']) {
  test(`returns safe unavailability instead of invented ${kind} candidates`, async (context) => {
    const { app } = await fixture(context);
    const response = await app.request(`/api/v1/${kind}/search?query=sensitive-query`, { headers: authorization });
    assert.equal(response.status, 503);
    const body: unknown = await response.json();
    assert.ok(typeof body === 'object' && body !== null && 'code' in body);
    assert.equal(body.code, 'RuntimeUnavailable');
    assert.deepEqual(Object.keys(body).sort(), ['code', 'message']);
    assert.equal(JSON.stringify(body).includes('sensitive-query'), false);
  });
}

test('returns nullable active state when there is no persisted target', async (context) => {
  const { app } = await fixture(context);
  const response = await app.request('/api/v1/active-target', { headers: authorization });
  assert.deepEqual(await response.json(), { activeTarget: null, listeningDesired: false, subscriptionState: null });
});

test('reads the persisted identity after reopening storage without claiming ready', async (context) => {
  const { store, path, runner, InboxService, createApp } = await fixture(context);
  store.upsertTarget(target);
  store.setActiveTarget(target);
  store.close();
  const reopened = new InboxStore(path);
  context.after(() => reopened.close());
  const app = createApp(new InboxService(reopened, runner, { profileKey: 'dedicated' }), { bearerToken: 'restored-token' });
  const response = await app.request('/api/v1/active-target', { headers: { Authorization: 'Bearer restored-token' } });
  assert.deepEqual(await response.json(), {
    activeTarget: { targetType: 'person', targetId: 'user-id', displayName: 'Person' },
    listeningDesired: true, subscriptionState: null,
  });
});

test('hides persisted identities from another profile', async (context) => {
  const { app, store } = await fixture(context);
  store.upsertTarget({ ...target, profileKey: 'other' });
  store.setActiveTarget({ ...target, profileKey: 'other' });
  const response = await app.request('/api/v1/active-target', { headers: authorization });
  assert.deepEqual(await response.json(), { activeTarget: null, listeningDesired: false, subscriptionState: null });
});

for (const targetType of ['person', 'group']) {
  test(`rejects arbitrary ${targetType} identity and preserves existing selection`, async (context) => {
    const { app, store } = await fixture(context);
    store.upsertTarget(target);
    store.setActiveTarget(target);
    const before = store.getActiveTarget();
    const response = await app.request('/api/v1/active-target', {
      method: 'PUT', headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType, targetId: 'unverified-id', displayName: 'Untrusted' }),
    });
    assert.equal(response.status, 400);
    const body: unknown = await response.json();
    assert.ok(typeof body === 'object' && body !== null && 'code' in body);
    assert.equal(body.code, 'InvalidTarget');
    assert.deepEqual(store.getActiveTarget(), before);
  });
}

for (const body of ['{', 'null', '{}', '{"targetType":"user","targetId":"id","displayName":"Name"}',
  '{"targetType":"person","targetId":"","displayName":"Name"}',
  '{"targetType":"group","targetId":123,"displayName":"Name"}',
  '{"targetType":"person","targetId":"id"}']) {
  test('rejects malformed target payload before persistence', async (context) => {
    const { app, store } = await fixture(context);
    const response = await app.request('/api/v1/active-target', {
      method: 'PUT', headers: { ...authorization, 'Content-Type': 'application/json' }, body,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { code: 'InvalidTarget', message: 'Invalid target' });
    assert.equal(store.getActiveTarget(), null);
  });
}
