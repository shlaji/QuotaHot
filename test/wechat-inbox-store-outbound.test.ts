import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WechatInboxStore } from '../src/server/wechat-inbox/store.js';
import { outbound, owner, other, setup } from './helpers/wechat-inbox-store.js';

test('returns requested outbound state after a normal transition', (t) => {
  const { store } = setup(t);
  store.saveBatch(owner, { nextCursor: '', messages: [{ ...outbound(null), state: 'sending' }] });
  const messageId = store.findOutboundMessageId(owner, 'client-a');
  assert.ok(messageId);

  assert.equal(store.updateOutboundState(owner, messageId, 'failed'), 'failed');
});

test('returns accepted when a BOT echo wins before a late failed update', (t) => {
  const { store, path } = setup(t);
  store.saveBatch(owner, { nextCursor: '', messages: [{ ...outbound(null), state: 'sending' }] });
  const messageId = store.findOutboundMessageId(owner, 'client-a');
  assert.ok(messageId);
  const sender = new WechatInboxStore(path);
  t.after(() => sender.close());
  store.saveBatch(owner, { nextCursor: 'echo', messages: [outbound()] });

  assert.equal(sender.updateOutboundState(owner, messageId, 'failed'), 'accepted');
  assert.equal(store.listMessages(owner).items[0]?.state, 'accepted');
});

test('returns null when owner, conversation, or client does not match', (t) => {
  const { store } = setup(t);
  store.saveBatch(owner, { nextCursor: '', messages: [{ ...outbound(null), state: 'sending' }] });
  const messageId = store.findOutboundMessageId(owner, 'client-a');
  assert.ok(messageId);

  assert.equal(store.updateOutboundState(other, messageId, 'failed'), null);
  assert.equal(store.updateOutboundState(owner, 'missing', 'failed'), null);
});
