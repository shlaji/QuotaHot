import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { InboxStore } from '../src/inbox/store.js';
import type { DingtalkMessage, DingtalkSubscription, DingtalkTarget } from '../src/shared/types.js';

const now = '2026-10-22T12:00:00.000Z';
const target: DingtalkTarget = {
  profileKey: 'dedicated', targetType: 'person', targetId: 'same-id', displayName: 'Person',
  listeningDesired: false, createdAt: now, updatedAt: now,
};
const subscription: DingtalkSubscription = {
  ...target, subscriptionId: 'generation-1', eventKey: 'user_im_message_receive_o2o',
  state: 'starting', startedAt: now, endedAt: null, failureCode: null, failureMessage: null,
};
const message: DingtalkMessage = {
  ...target, localId: 'local-1', conversationId: 'conversation-1', eventId: 'event-1',
  messageId: 'message-1', senderId: null, senderName: null, direction: 'inbound',
  contentType: 'text', content: 'hello', sourceTime: null, receivedAt: now,
  storedAt: now, sendState: 'not_applicable',
};

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'inbox-store-'));
  const path = join(directory, 'inbox.db');
  const store = new InboxStore(path, () => new Date(now));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, path, directory };
}

function supports(store: InboxStore, method: keyof InboxStore): void {
  assert.equal(typeof store[method], 'function', `missing persistence method: ${method}`);
}

test('upserts one identity without replacing creation time or listening intent', async (context) => {
  const { store } = await fixture(context);
  supports(store, 'upsertTarget');
  store.upsertTarget(target);
  store.setActiveTarget(target);
  store.upsertTarget({ ...target, displayName: 'Confirmed', createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z' });
  assert.deepEqual(store.listTargets('dedicated'), [{ ...target, displayName: 'Confirmed', listeningDesired: true, updatedAt: '2026-10-23T00:00:00.000Z' }]);
});

test('keeps person, group and profile identity domains distinct with target pagination', async (context) => {
  const { store } = await fixture(context);
  supports(store, 'upsertTarget');
  store.upsertTarget(target);
  store.upsertTarget({ ...target, targetType: 'group' });
  store.upsertTarget({ ...target, profileKey: 'other' });
  assert.equal(store.listTargets('dedicated').length, 2);
  assert.equal(store.listTargets('other').length, 1);
  assert.deepEqual(store.listTargets('dedicated', { limit: 1, offset: 1 }), [target]);
});

test('persists a single active target and clears the old listening intent on switch', async (context) => {
  const { store } = await fixture(context);
  supports(store, 'setActiveTarget');
  store.upsertTarget(target);
  store.upsertTarget({ ...target, targetType: 'group' });
  store.setActiveTarget(target);
  store.setActiveTarget({ ...target, targetType: 'group' });
  assert.equal(store.getActiveTarget()?.targetType, 'group');
  assert.deepEqual(store.listTargets('dedicated').map(item => item.listeningDesired), [true, false]);
});

test('keeps the active identity while explicit stop clears listening intent', async (context) => {
  const { store } = await fixture(context);
  supports(store, 'setListeningDesired');
  store.upsertTarget(target);
  store.setActiveTarget(target);
  store.setListeningDesired(false);
  assert.deepEqual(store.getActiveTarget(), target);
});

test('rolls back active selection when the requested identity does not exist', async (context) => {
  const { store } = await fixture(context);
  supports(store, 'setActiveTarget');
  store.upsertTarget(target);
  store.setActiveTarget(target);
  assert.throws(() => store.setActiveTarget({ ...target, targetId: 'missing' }));
  assert.equal(store.getActiveTarget()?.listeningDesired, true);
});

test('persists subscription lifecycle and sanitized failure fields', async (context) => {
  const { store } = await fixture(context);
  supports(store, 'createSubscription');
  store.upsertTarget(target);
  store.createSubscription(subscription);
  store.updateSubscription(subscription.subscriptionId, { state: 'ready' });
  store.updateSubscription(subscription.subscriptionId, { state: 'stopping' });
  store.updateSubscription(subscription.subscriptionId, { state: 'failed', endedAt: now, failureCode: 'EXIT', failureMessage: 'Consumer exited' });
  assert.deepEqual(store.getSubscription('generation-1'), {
    profileKey: target.profileKey, targetType: target.targetType, targetId: target.targetId,
    subscriptionId: 'generation-1', eventKey: 'user_im_message_receive_o2o', state: 'failed',
    startedAt: now, endedAt: now, failureCode: 'EXIT', failureMessage: 'Consumer exited',
  });
});

test('rejects concurrent live subscription generations and invalid state transitions', async (context) => {
  const { store } = await fixture(context);
  supports(store, 'createSubscription');
  store.upsertTarget(target);
  store.createSubscription(subscription);
  assert.throws(() => store.createSubscription({ ...subscription, subscriptionId: 'generation-2' }));
  assert.throws(() => store.updateSubscription('generation-1', { state: 'stopped' }));
  assert.equal(store.getSubscription('generation-1')?.state, 'starting');
});

test('reopens with interrupted old generations and persisted active listening intent', async (context) => {
  const { store, path } = await fixture(context);
  supports(store, 'createSubscription');
  store.upsertTarget(target);
  store.setActiveTarget(target);
  store.createSubscription(subscription);
  store.updateSubscription('generation-1', { state: 'ready' });
  store.close();
  const reopened = new InboxStore(path, () => new Date(now));
  context.after(() => reopened.close());
  assert.equal(reopened.getSubscription('generation-1')?.state, 'interrupted');
  assert.equal(reopened.getActiveTarget()?.listeningDesired, true);
  reopened.createSubscription({ ...subscription, subscriptionId: 'generation-2' });
  assert.equal(reopened.getSubscription('generation-2')?.state, 'starting');
});

test('deduplicates by message identity before event identity', async (context) => {
  const { store } = await fixture(context);
  supports(store, 'appendMessage');
  store.upsertTarget(target);
  store.appendMessage(message);
  const duplicate = store.appendMessage({ ...message, localId: 'local-2', eventId: 'different' });
  const distinct = store.appendMessage({ ...message, localId: 'local-3', messageId: 'different' });
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.message.localId, 'local-1');
  assert.equal(distinct.inserted, true);
  assert.equal(store.listMessages(target).length, 2);
});

test('deduplicates event fallback within profile but not across profiles', async (context) => {
  const { store } = await fixture(context);
  supports(store, 'appendMessage');
  store.upsertTarget(target);
  store.upsertTarget({ ...target, profileKey: 'other' });
  store.appendMessage({ ...message, messageId: null });
  assert.equal(store.appendMessage({ ...message, localId: 'duplicate', messageId: null }).inserted, false);
  assert.equal(store.appendMessage({ ...message, localId: 'other', profileKey: 'other', messageId: null }).inserted, true);
});

test('keeps distinct conversations and exposes missing dedup identity without guessing', async (context) => {
  const { store } = await fixture(context);
  supports(store, 'appendMessage');
  store.upsertTarget(target);
  store.appendMessage(message);
  assert.equal(store.appendMessage({ ...message, localId: 'conversation-2', conversationId: 'conversation-2' }).inserted, true);
  store.appendMessage({ ...message, localId: 'missing-1', messageId: null, eventId: null });
  const result = store.appendMessage({ ...message, localId: 'missing-2', messageId: null, eventId: null });
  assert.equal(result.inserted, true);
  assert.equal(result.deduplication, 'unavailable');
  assert.equal(store.listMessages(target).length, 4);
});

test('lists by stored time then insertion sequence with stable cursor pagination', async (context) => {
  const { store } = await fixture(context);
  supports(store, 'appendMessage');
  store.upsertTarget(target);
  for (const [localId, storedAt] of [['later', now], ['older', '2026-10-21T12:00:00Z'], ['tie', now]]) {
    store.appendMessage({ ...message, localId, storedAt, messageId: localId, sourceTime: '2000-01-01T00:00:00Z' });
  }
  const first = store.listMessages(target, { limit: 1 });
  assert.equal(first[0]?.localId, 'tie');
  assert.deepEqual(store.listMessages(target, { before: first[0] }).map(item => item.localId), ['later', 'older']);
});

test('isolates message listing by full target identity', async (context) => {
  const { store } = await fixture(context);
  supports(store, 'appendMessage');
  store.upsertTarget(target);
  store.upsertTarget({ ...target, targetType: 'group' });
  store.appendMessage(message);
  store.appendMessage({ ...message, targetType: 'group', localId: 'group', messageId: 'group' });
  assert.deepEqual(store.listMessages(target).map(item => item.localId), ['local-1']);
});

test('deletes at the 30-day boundary using storedAt rather than upstream or received time', async (context) => {
  const { store } = await fixture(context);
  supports(store, 'pruneMessages');
  store.upsertTarget(target);
  store.appendMessage({ ...message, storedAt: '2026-10-01T12:00:00Z' });
  store.appendMessage({ ...message, localId: 'keep', messageId: 'keep', sourceTime: '2000-01-01T00:00:00Z', receivedAt: '2000-01-01T00:00:00Z' });
  assert.equal(store.pruneMessages(new Date('2026-10-31T12:00:00Z')), 1);
  assert.deepEqual(store.listMessages(target).map(item => item.localId), ['keep']);
});

test('reopens pending outbound as unknown without altering confirmed accepted results', async (context) => {
  const { store, path } = await fixture(context);
  supports(store, 'appendMessage');
  store.upsertTarget(target);
  store.appendMessage({ ...message, direction: 'outbound', sendState: 'pending', conversationId: null, receivedAt: null });
  store.appendMessage({ ...message, localId: 'confirmed', messageId: 'confirmed', direction: 'outbound', sendState: 'pending' });
  store.updateSendState('confirmed', 'accepted');
  store.close();
  const reopened = new InboxStore(path, () => new Date(now));
  context.after(() => reopened.close());
  assert.deepEqual(reopened.listMessages(target).map(item => item.sendState), ['accepted', 'unknown']);
});

test('enforces strict schema, enum checks, target references and event domains', async (context) => {
  const { path, store } = await fixture(context);
  const database = new DatabaseSync(path);
  context.after(() => database.close());
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE name = 'targets'").get(), 'missing targets schema');
  assert.deepEqual(database.prepare("SELECT strict FROM pragma_table_list WHERE name IN ('targets','subscriptions','messages')").all().map(row => row.strict), [1, 1, 1]);
  const insert = database.prepare('INSERT INTO targets VALUES (?,?,?,?,?,?,?,?)');
  assert.throws(() => insert.run('p', 'invalid', 'id', 'name', 0, 0, now, now), /target_type/);
  assert.throws(() => insert.run('p', 'person', 'id', 'name', 2, 0, now, now), /listening_desired/);
  assert.throws(() => insert.run('p', 'person', 'id', new Uint8Array([1]), 0, 0, now, now), /BLOB/);
  store.upsertTarget(target);
  assert.throws(() => store.createSubscription({ ...subscription, targetId: 'missing' }));
  assert.throws(() => store.createSubscription({ ...subscription, eventKey: 'user_im_message_receive_group' }));
});

test('keeps database and sidecars private after real message writes', async (context) => {
  const { store, path, directory } = await fixture(context);
  supports(store, 'appendMessage');
  store.upsertTarget(target);
  store.appendMessage(message);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});
