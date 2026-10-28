import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WechatInboxStore, type InboxMessageInput } from '../../src/server/wechat-inbox/store.js';

export const now = '2000-01-01T00:00:00.000Z';
export const later = '2026-10-20T12:00:00.000Z';
export const owner = 'owner-a';
export const other = 'owner-b';
export const remoteId = '18446744073709551615';

export function pathFor(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'wechat-inbox-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'wechat', 'inbox.db');
}

export function setup(t: TestContext) {
  const path = pathFor(t);
  const store = new WechatInboxStore(path);
  t.after(() => store.close());
  store.saveBinding({ ownerIlinkUserId: owner, botId: 'bot-a' }, now);
  store.saveBinding({ ownerIlinkUserId: other, botId: 'bot-b' }, now);
  return { store, path };
}

export function input(id: string | null = remoteId, _legacyIdentity?: string): InboxMessageInput {
  return { remoteMessageId: id, clientId: null, direction: 'inbound',
    messageType: 1, kind: 'text', state: 'received', createdAt: now, runId: null,
    items: [{ kind: 'text', text: '  full text\n' }] };
}

export function localId(_store: WechatInboxStore, bindingOwner = owner, _legacyIdentity?: string): string {
  return bindingOwner;
}

export const fingerprint = 'a'.repeat(64);
export function placeholder(hash = fingerprint): InboxMessageInput {
  return { ...input(null), fingerprint: hash,
    kind: 'protocol_event', items: [{ kind: 'protocol_event', safeSummary: 'invalid_message' }] };
}

export function outbound(id: string | null = remoteId, _legacyIdentity?: string): InboxMessageInput {
  return { ...input(id), direction: 'outbound', messageType: 2, state: 'accepted', clientId: 'client-a' };
}
