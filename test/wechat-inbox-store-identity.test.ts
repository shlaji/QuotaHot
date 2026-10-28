import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WechatInboxStore } from '../src/server/wechat-inbox/store.js';
import { input, owner, other, pathFor, setup } from './helpers/wechat-inbox-store.js';

test('uses independent local IDs and a fresh per-message client ID for outbound records', (t) => {
  const { store } = setup(t);
  store.saveBatch(owner, { nextCursor: '', messages: [
    { ...input(null), direction: 'outbound', messageType: 2, clientId: 'client-one', state: 'sending' },
    { ...input(null), direction: 'outbound', messageType: 2, clientId: 'client-two', state: 'sending' },
  ] });
  const messages = store.listMessages(owner).items;
  assert.equal(messages.length, 2);
  assert.notEqual(messages[0]?.id, messages[1]?.id);
  assert.deepEqual(messages.map((message) => message.clientId), ['client-one', 'client-two']);
});

test('correlates BOT echoes only with the matching owner-scoped client ID', (t) => {
  const { store } = setup(t);
  const pending = { ...input(null), direction: 'outbound' as const, messageType: 2, clientId: 'per-message-id', state: 'sending' as const };
  store.saveBatch(owner, { nextCursor: 'send', messages: [pending] });
  const local = store.listMessages(owner).items[0];
  assert.ok(local);
  store.saveBatch(owner, { nextCursor: 'echo', messages: [{ ...input('remote-1'), direction: 'outbound',
    messageType: 2, clientId: 'per-message-id', state: 'accepted' }] });
  assert.deepEqual(store.listMessages(owner).items, [{ ...local, remoteMessageId: 'remote-1', state: 'accepted' }]);
});

test('isolates identical remote and client IDs across bindings', (t) => {
  const { store } = setup(t);
  for (const bindingOwner of [owner, other]) {
    store.saveBatch(bindingOwner, { nextCursor: `cursor-${bindingOwner}`, messages: [
      { ...input('same-remote'), direction: 'outbound', messageType: 2, clientId: 'same-client', state: 'sending' },
    ] });
  }
  assert.equal(store.listMessages(owner).items.length, 1);
  assert.equal(store.listMessages(other).items.length, 1);
  assert.equal(store.updateOutboundState(owner, store.listMessages(owner).items[0]?.id ?? '', 'accepted'), 'accepted');
  assert.equal(store.listMessages(other).items[0]?.state, 'sending');
});

test('keeps owner-scoped pending messages and attachments across store reopen', (t) => {
  const path = pathFor(t);
  const store = new WechatInboxStore(path);
  store.saveBinding({ ownerIlinkUserId: owner, botId: 'bot' }, new Date(0).toISOString());
  store.saveBatch(owner, { nextCursor: 'sent', messages: [{ ...input(null), direction: 'outbound', messageType: 2,
    clientId: 'fresh-client-id', state: 'accepted', items: [{ kind: 'file', attachment: {
      fileName: 'proof.txt', mediaType: 'text/plain', bytes: Buffer.from('persisted bytes'),
    } }] }] });
  const first = store.listMessages(owner).items[0];
  assert.ok(first?.items[0]?.attachmentId);
  store.close();

  const reopened = new WechatInboxStore(path);
  t.after(() => reopened.close());
  const saved = reopened.listMessages(owner).items[0];
  assert.equal(saved?.clientId, 'fresh-client-id');
  assert.equal(saved?.id, first.id);
  assert.deepEqual(Buffer.concat([...reopened.readAttachmentChunks(owner, saved?.items[0]?.attachmentId ?? '')]), Buffer.from('persisted bytes'));
});
