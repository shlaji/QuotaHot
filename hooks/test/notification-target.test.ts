import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveNotificationTarget, type DwsInvoker } from '../src/notification-target.js';

function conversationInfo(openConversationId: string): string {
  return JSON.stringify({
    success: true,
    errorCode: null,
    errorMsg: null,
    result: {
      conversationInfo: {
        corpId: 'corp-1',
        corpName: 'Test organization',
        createAt: '2026-10-22 10:00:00',
        extension: {},
        memberCount: 2,
        openConversationId,
        ownerNick: 'Test owner',
        singleChat: false,
        title: 'Test group',
      },
    },
  });
}

test('resolves a target only when DWS confirms the exact conversation ID', async () => {
  const calls: (readonly string[])[] = [];
  const invoke: DwsInvoker = async (args) => {
    calls.push(args);
    return conversationInfo('conversation-1');
  };

  const resolution = await resolveNotificationTarget('conversation-1', invoke);

  assert.deepEqual(resolution, {
    kind: 'verified',
    target: { openConversationId: 'conversation-1', displayName: 'Test group' },
  });
  assert.deepEqual(calls, [['chat', '+conversation-info', '--group', 'conversation-1', '--format', 'json']]);
});

test('does not substitute a different conversation returned by DWS', async () => {
  const invoke: DwsInvoker = async () => conversationInfo('different-conversation');

  const resolution = await resolveNotificationTarget('conversation-1', invoke);

  assert.equal(resolution.kind, 'not_verified');
});

test('does not verify malformed DWS group responses', async () => {
  const malformed: DwsInvoker = async () => '{not-json';

  assert.equal((await resolveNotificationTarget('conversation-1', malformed)).kind, 'not_verified');
});

test('does not verify failed DWS group responses', async () => {
  const failed: DwsInvoker = async () => JSON.stringify({ success: false, errorMsg: 'not found' });

  assert.equal((await resolveNotificationTarget('conversation-1', failed)).kind, 'not_verified');
});
