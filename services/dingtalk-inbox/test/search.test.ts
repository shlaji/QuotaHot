import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { DwsRunner, DwsProcessError } from '../src/dws/runner.js';
import type { JsonValue } from '../src/dws/runner.js';
import { authorization, fixture } from './http-fixture.js';

async function searchFixture(context: TestContext) {
  const base = await fixture(context);
  let payload: JsonValue = {};
  let unavailable = false;
  let paused = false;
  const pending: (() => void)[] = [];
  const calls: (readonly string[])[] = [];
  const runner = new DwsRunner({ binary: '/fake', profile: 'dedicated', configDir: '/fake' }, (_binary, args) => {
    calls.push(args);
    if (unavailable) throw new DwsProcessError('process_error');
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: () => true,
    });
    const output = JSON.stringify(payload);
    const finish = () => { child.stdout.end(output); child.stderr.end(); child.emit('close', 0, null); };
    if (paused) pending.push(finish);
    else queueMicrotask(finish);
    return child;
  });
  const config = { profileKey: 'dedicated' };
  const service = new base.InboxService(base.store, runner, config);
  const app = base.createApp(service, { bearerToken: 'test-only-inbox-token' });
  return { ...base, service, app, config, calls, setPayload(value: JsonValue) { payload = value; }, fail() { unavailable = true; },
    pause() { paused = true; }, finish(index: number) { const complete = pending[index]; assert.ok(complete); complete(); } };
}

const person = { userId: 'user-1', author: 'Alice', openDingTalkId: 'private', meta: { snippet: 'secret' }, query: 'secret' };
const group = { openConversationId: 'group-1', name: 'Team', snippet: 'secret' };
const selected = { targetType: 'person', targetId: 'user-1', displayName: 'Alice' } as const;

for (const kind of ['people', 'groups'] as const) {
  test(`returns safe ${kind} DTO with literal fixed argv`, async context => {
    const setup = await searchFixture(context);
    setup.setPayload({ result: [kind === 'people' ? person : group], complete: true, partial: false, failedCount: 0 });
    const query = 'Alice; $(not-a-command)';
    const response = await setup.app.request(`/api/v1/${kind}/search?query=${encodeURIComponent(query)}`, { headers: authorization });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { items: [kind === 'people' ? { userId: 'user-1', displayName: 'Alice' } : { openConversationId: 'group-1', displayName: 'Team' }], complete: true });
    assert.deepEqual(setup.calls, [['--profile', 'dedicated', ...(kind === 'people'
      ? ['aisearch', 'person', '--query', query, '--dimension', 'name', '--format', 'json']
      : ['chat', '+chat-search', '--query', query, '--page-all', '--format', 'json'])]]);
    assert.equal(setup.store.getActiveTarget(), null);
  });
}

for (const result of [[], [{ author: 'Alice', openDingTalkId: 'not-user-id' }], [{ userId: ' ', author: 'Alice' }], [{ userId: 'id', query: 'not-a-name' }]]) {
  test('drops candidates without stable identity or actual name', async context => {
    const setup = await searchFixture(context);
    setup.setPayload({ result, complete: true });
    const response = await setup.app.request('/api/v1/people/search?query=Alice', { headers: authorization });
    const body: unknown = await response.json();
    assert.deepEqual(body, { items: [], complete: true });
  });
}

const incompletePeople: readonly JsonValue[] = [
  { result: [person], searchEvidence: { returnedCandidateCount: 1 } },
  { result: [person, { ...person, userId: 'user-2' }] },
  { result: [person], complete: false },
  { result: [person], complete: true, hasMore: true },
  { result: [person], complete: true, partial: 'unknown' },
  { result: [person], complete: true, success: false },
];
for (const payload of incompletePeople) {
  test('retains incomplete person candidates but rejects selection', async context => {
    const setup = await searchFixture(context);
    setup.setPayload(payload);
    const response = await setup.app.request('/api/v1/people/search?query=Alice', { headers: authorization });
    const body: unknown = await response.json();
    assert.ok(typeof body === 'object' && body !== null && 'complete' in body);
    assert.equal(body.complete, false);
    assert.equal(setup.service.selectTarget(selected).code, 'InvalidTarget');
  });
}

const incompleteGroups: readonly { readonly [key: string]: JsonValue }[] = [{}, { complete: false }, { complete: true, partial: true, failedCount: 0 }, { complete: true, partial: false, failedCount: 1 }, { complete: true, partial: false }];
for (const metadata of incompleteGroups) {
  test('rejects incomplete or failed group page evidence', async context => {
    const setup = await searchFixture(context);
    setup.setPayload({ result: [group], ...metadata });
    const response = await setup.app.request('/api/v1/groups/search?query=Team', { headers: authorization });
    assert.deepEqual(await response.json(), { items: [{ openConversationId: 'group-1', displayName: 'Team' }], complete: false });
    assert.equal(setup.service.selectTarget({ targetType: 'group', targetId: 'group-1', displayName: 'Team' }).code, 'InvalidTarget');
  });
}

test('selects only verified identity without enabling a listener or trusting request name', async context => {
  const setup = await searchFixture(context);
  setup.setPayload({ result: [person, { userId: 'user-2', name: 'Alice' }], complete: true });
  await setup.app.request('/api/v1/people/search?query=Alice', { headers: authorization });
  const response = await setup.app.request('/api/v1/active-target', { method: 'PUT', headers: authorization, body: JSON.stringify({ ...selected, displayName: 'Forged' }) });
  assert.equal(response.status, 503);
  const active = await setup.app.request('/api/v1/active-target', { headers: authorization });
  assert.deepEqual(await active.json(), { activeTarget: selected, listeningDesired: false, subscriptionState: null });
});

for (const invalidation of ['new-search', 'failed-search', 'profile', 'type'] as const) {
  test(`rejects evidence after ${invalidation}`, async context => {
    const setup = await searchFixture(context);
    setup.setPayload({ result: [person], complete: true });
    await setup.app.request('/api/v1/people/search?query=Alice', { headers: authorization });
    if (invalidation === 'new-search' || invalidation === 'failed-search') {
      setup.setPayload({ result: [], complete: true });
      if (invalidation === 'failed-search') setup.fail();
      await setup.app.request('/api/v1/people/search?query=Bob', { headers: authorization });
    }
    if (invalidation === 'profile') setup.config.profileKey = 'other';
    const error = setup.service.selectTarget({ ...selected, targetType: invalidation === 'type' ? 'group' : 'person' });
    assert.equal(error.code, 'InvalidTarget');
    assert.equal(setup.store.getActiveTarget(), null);
  });
}

test('reports observed command availability without a listening claim', async context => {
  const setup = await searchFixture(context);
  setup.setPayload({ result: [], complete: true });
  await setup.app.request('/api/v1/people/search?query=Alice', { headers: authorization });
  assert.equal(setup.service.getCapability().available, true);
  setup.fail();
  const response = await setup.app.request('/api/v1/people/search?query=secret', { headers: authorization });
  assert.equal(response.status, 503);
  assert.equal(setup.service.getCapability().available, false);
  assert.doesNotMatch(JSON.stringify(await response.json()), /secret|\/fake/);
});

test('drops groups missing openConversationId instead of routing by name or other IDs', async context => {
  const setup = await searchFixture(context);
  setup.setPayload({ items: [{ conversationId: 'unsafe', name: 'Team' }], complete: true, partial: false, failedCount: 0 });
  const response = await setup.app.request('/api/v1/groups/search?query=Team', { headers: authorization });
  assert.deepEqual(await response.json(), { items: [], complete: true });
});

test('selects a complete group without enabling listening', async context => {
  const setup = await searchFixture(context);
  setup.setPayload({ items: [group], complete: true, partial: false, failedCount: 0 });
  await setup.app.request('/api/v1/groups/search?query=Team', { headers: authorization });
  setup.service.selectTarget({ targetType: 'group', targetId: 'group-1', displayName: 'Team' });
  assert.deepEqual(setup.service.getActiveTarget(), {
    activeTarget: { targetType: 'group', targetId: 'group-1', displayName: 'Team' }, listeningDesired: false, subscriptionState: null,
  });
});

const malformedPayloads: readonly JsonValue[] = [null, [], { result: 'secret' }];
for (const payload of malformedPayloads) {
  test('does not authorize selection from malformed or failed search output', async context => {
    const setup = await searchFixture(context);
    setup.setPayload(payload);
    const response = await setup.app.request('/api/v1/people/search?query=Alice', { headers: authorization });
    assert.equal(setup.service.selectTarget(selected).code, 'InvalidTarget');
    assert.equal(response.status, 503);
    assert.equal(setup.store.getActiveTarget(), null);
  });
}

for (const query of ['', '?query=', '?query=%20%20']) {
  test('rejects absent or blank query before invoking DWS', async context => {
    const setup = await searchFixture(context);
    const response = await setup.app.request(`/api/v1/people/search${query}`, { headers: authorization });
    assert.equal(response.status, 400);
    assert.deepEqual(setup.calls, []);
  });
}

test('does not restore stale evidence when an older search finishes last', async context => {
  const setup = await searchFixture(context);
  setup.pause();
  setup.setPayload({ result: [person], complete: true });
  const first = setup.service.search('person', 'Alice');
  setup.setPayload({ result: [{ userId: 'user-2', name: 'Bob' }], complete: true });
  const second = setup.service.search('person', 'Bob');
  setup.finish(1);
  await second;
  setup.finish(0);
  await first;
  assert.equal(setup.service.selectTarget(selected).code, 'InvalidTarget');
});

test('rejects a profile mismatch before starting a search process', async context => {
  const setup = await searchFixture(context);
  setup.config.profileKey = 'other';
  const response = await setup.app.request('/api/v1/groups/search?query=Team', { headers: authorization });
  assert.equal(response.status, 503);
  assert.deepEqual(setup.calls, []);
});
