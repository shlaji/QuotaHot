import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotificationTargetSchema } from '../src/notification-schema.js';
import { sendNotificationChunks, splitNotificationContent, type DwsCommandInvoker } from '../src/notification-delivery.js';

const target = NotificationTargetSchema.parse({ openConversationId: 'conversation-1', displayName: 'Test group' });

function sendReceipt(openTaskId: string): string {
  return JSON.stringify({ success: true, result: { openTaskId } });
}

function statusReceipt(openTaskId: string, sendStatus: string, conversationId = 'conversation-1'): string {
  return JSON.stringify({
    success: true,
    openTaskId,
    result: { openConversationId: conversationId, openMessageId: `message-${openTaskId}`, sendStatus },
  });
}

test('splits long Unicode text at code point boundaries within the 1024-byte cap', () => {
  const content = '😀é你'.repeat(500);
  const chunks = splitNotificationContent(content);

  assert.ok(chunks.length > 1);
  assert.equal(chunks.map((chunk) => chunk.slice(chunk.indexOf(' ') + 1)).join(''), content);
  for (const chunk of chunks) assert.ok(Buffer.byteLength(chunk, 'utf8') <= 1024);
});

test('sends each chunk only after the previous chunk status is successful', async () => {
  const calls: (readonly string[])[] = [];
  const receipts = [sendReceipt('task-1'), statusReceipt('task-1', 'SUCCESS'), sendReceipt('task-2'), statusReceipt('task-2', 'SUCCESS')];
  const invokeDws: DwsCommandInvoker = async (args) => {
    calls.push(args);
    const receipt = receipts.shift();
    if (receipt === undefined) throw new Error('Unexpected DWS invocation');
    return receipt;
  };

  const outcome = await sendNotificationChunks({ target, content: 'a'.repeat(1500), invokeDws });

  assert.equal(outcome.state, 'sent');
  assert.deepEqual(outcome.sentParts, [1, 2]);
  assert.deepEqual(calls.map((args) => args[1]), ['+send-to-group', '+messages-query-send-status', '+send-to-group', '+messages-query-send-status']);
  const sentBodies = calls.filter((args) => args[1] === '+send-to-group').map((args) => args[args.indexOf('--content') + 1]);
  assert.deepEqual(sentBodies.map((body) => body?.slice(0, 3)), ['1/2', '2/2']);
  for (const body of sentBodies) assert.ok(typeof body === 'string' && Buffer.byteLength(body, 'utf8') <= 1024);
});

test('stops after an unknown first-part status without retrying or sending later chunks', async () => {
  const calls: (readonly string[])[] = [];
  const receipts = [sendReceipt('task-pending'), statusReceipt('task-pending', 'PENDING')];
  const invokeDws: DwsCommandInvoker = async (args) => {
    calls.push(args);
    const receipt = receipts.shift();
    if (receipt === undefined) throw new Error('Unexpected DWS invocation');
    return receipt;
  };

  const outcome = await sendNotificationChunks({ target, content: 'a'.repeat(1500), invokeDws });

  assert.equal(outcome.state, 'unknown');
  assert.deepEqual(outcome.sentParts, []);
  assert.equal(calls.length, 2);
});

test('does not accept a successful receipt for a different conversation', async () => {
  const invokeDws: DwsCommandInvoker = async (args) => args[1] === '+send-to-group'
    ? sendReceipt('task-wrong-target')
    : statusReceipt('task-wrong-target', 'SUCCESS', 'different-conversation');

  const outcome = await sendNotificationChunks({ target, content: 'single part', invokeDws });

  assert.equal(outcome.state, 'unknown');
  assert.deepEqual(outcome.sentParts, []);
});
