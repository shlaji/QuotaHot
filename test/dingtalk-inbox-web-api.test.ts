import assert from 'node:assert/strict';
import test from 'node:test';
import { dingtalkInboxApi, DingtalkInboxApiError } from '../src/web/dingtalk-inbox/api.js';

const signal = new AbortController().signal;
const target = { targetType: 'person', targetId: 'user /?#', displayName: '林岚' } as const;
const subscription = { subscriptionId: 'generation-1', targetType: 'person', targetId: target.targetId, state: 'starting' } as const;

test('uses only fixed same-origin proxy paths without a service authorization header', async (context) => {
  const paths: string[] = [];
  context.mock.method(globalThis, 'fetch', async (path: RequestInfo | URL, init?: RequestInit) => {
    paths.push(String(path));
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.signal, signal);
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return Response.json({ available: true, reason: '', serviceToken: 'secret', dwsVersion: '1.0' });
  });
  assert.deepEqual(await dingtalkInboxApi.capability(signal), { available: true, reason: '', dwsVersion: '1.0' });
  assert.deepEqual(paths, ['/api/dingtalk-inbox/capability']);
});

test('projects people and groups to distinct typed IDs and encodes the search query', async (context) => {
  const paths: string[] = [];
  context.mock.method(globalThis, 'fetch', async (path: RequestInfo | URL) => {
    paths.push(String(path));
    return Response.json({ complete: true, items: paths.length === 1
      ? [{ userId: 'same-id', displayName: '林岚', department: '研发', profileKey: 'not-in-contract', token: 'secret' }]
      : [{ openConversationId: 'same-id', displayName: '项目群', token: 'secret' }] });
  });
  assert.deepEqual(await dingtalkInboxApi.search('person', '林 /?&', signal), {
    complete: true, items: [{ targetType: 'person', targetId: 'same-id', displayName: '林岚', department: '研发' }],
  });
  assert.deepEqual(await dingtalkInboxApi.search('group', '项目', signal), {
    complete: true, items: [{ targetType: 'group', targetId: 'same-id', displayName: '项目群' }],
  });
  assert.deepEqual(paths, ['/api/dingtalk-inbox/people/search?query=%E6%9E%97+%2F%3F%26', '/api/dingtalk-inbox/groups/search?query=%E9%A1%B9%E7%9B%AE']);
});

test('reads active target and submits exactly the explicitly selected DTO', async (context) => {
  context.mock.method(globalThis, 'fetch', async (path: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(path, '/api/dingtalk-inbox/active-target');
    if (init?.method === 'PUT') {
      assert.deepEqual(JSON.parse(String(init.body)), target);
      return Response.json({ ...subscription, serviceToken: 'secret' }, { status: 202 });
    }
    return Response.json({ activeTarget: target, listeningDesired: true, subscriptionState: subscription, serviceToken: 'secret' });
  });
  assert.deepEqual(await dingtalkInboxApi.activeTarget(signal), { activeTarget: target, listeningDesired: true, subscriptionState: subscription });
  assert.deepEqual(await dingtalkInboxApi.select(target, signal), subscription);
});

for (const [status, code] of [[401, 'auth'], [403, 'auth'], [404, 'unavailable'], [503, 'unavailable'], [400, 'rejected'], [500, 'unavailable']] as const) {
  test(`maps HTTP ${status} to safe ${code} feedback without exposing upstream text`, async (context) => {
    context.mock.method(globalThis, 'fetch', async () => new Response('Bearer private-service-token', { status }));
    await assert.rejects(dingtalkInboxApi.capability(signal), (error: unknown) =>
      error instanceof DingtalkInboxApiError && error.code === code && !error.message.includes('private'));
  });
}

for (const payload of [{ items: [] }, { complete: 'true', items: [] }, { complete: true, items: [{ displayName: '缺少身份' }] },
  { complete: true, items: [{ userId: '', displayName: '空身份' }] }, { complete: true, items: [{ userId: 'u', displayName: '名字', department: 3 }] }]) {
  test(`rejects malformed person search ${JSON.stringify(payload)}`, async (context) => {
    context.mock.method(globalThis, 'fetch', async () => Response.json(payload));
    await assert.rejects(dingtalkInboxApi.search('person', '名字', signal), (error: unknown) => error instanceof DingtalkInboxApiError && error.code === 'malformed');
  });
}

test('preserves incomplete results without inventing a completion marker', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => Response.json({ complete: false, items: [{ userId: 'u', displayName: '唯一返回候选' }] }));
  assert.equal((await dingtalkInboxApi.search('person', '名字', signal)).complete, false);
});

test('rejects wrong group IDs, invalid capability and mismatched target receipts', async (context) => {
  for (const payload of [{ items: [{ userId: 'u', displayName: '人员' }], complete: true }, { available: true },
    { ...subscription, targetType: 'group' }, { ...subscription, state: 'invented' }]) {
    context.mock.method(globalThis, 'fetch', async () => Response.json(payload));
    const operation = 'items' in payload ? dingtalkInboxApi.search('group', '群', signal)
      : 'available' in payload ? dingtalkInboxApi.capability(signal) : dingtalkInboxApi.select(target, signal);
    await assert.rejects(operation, DingtalkInboxApiError);
  }
});

test('rejects absent proxy HTML, broken JSON and network errors safely', async (context) => {
  for (const response of [new Response('<html>app fallback</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('{bad', { headers: { 'Content-Type': 'application/json' } })]) {
    context.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(dingtalkInboxApi.capability(signal), DingtalkInboxApiError);
  }
  context.mock.method(globalThis, 'fetch', async () => { throw new TypeError('private-network-address'); });
  await assert.rejects(dingtalkInboxApi.capability(signal), (error: unknown) =>
    error instanceof DingtalkInboxApiError && error.code === 'network' && !error.message.includes('private'));
});

test('preserves request cancellation rather than reporting a transport failure', async (context) => {
  const cancellation = new DOMException('Aborted', 'AbortError');
  context.mock.method(globalThis, 'fetch', async () => { throw cancellation; });
  await assert.rejects(dingtalkInboxApi.capability(signal), (error: unknown) => error === cancellation);
});

test('validates every active-target field and target/subscription identity before returning a restored selection', async (context) => {
  for (const payload of [{}, { activeTarget: null, subscriptionState: null },
    { activeTarget: target, listeningDesired: true, subscriptionState: { ...subscription, targetId: 'another-profile-id' } },
    { activeTarget: { ...target, targetType: 'user' }, listeningDesired: true, subscriptionState: null },
    { activeTarget: null, listeningDesired: 'false', subscriptionState: null }]) {
    context.mock.method(globalThis, 'fetch', async () => Response.json(payload));
    await assert.rejects(dingtalkInboxApi.activeTarget(signal), (error: unknown) => error instanceof DingtalkInboxApiError && error.code === 'malformed');
  }
});

test('serializes only contracted target fields even when the selected object carries extra fields', async (context) => {
  context.mock.method(globalThis, 'fetch', async (_path: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(init?.body, JSON.stringify(target));
    return Response.json(subscription, { status: 202 });
  });
  const selected = { ...target, department: '研发', serviceToken: 'private' };
  await dingtalkInboxApi.select(selected, signal);
});
