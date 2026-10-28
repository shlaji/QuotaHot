import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DwsSendResponseSchema,
  DwsSendStatusResponseSchema,
  DwsToolValidationErrorResponseSchema,
  NotificationChunkResultSchema,
  NotificationCompletionLedgerSchema,
  NotificationConfigSchema,
  OpenCodeSessionMessagesResponseSchema,
} from '../src/notification-schema.js';

test('disabled notification config accepts the no-target default', () => {
  const result = NotificationConfigSchema.safeParse({
    version: 1,
    enabled: false,
    target: null,
    authorizedAt: null,
  });

  assert.equal(result.success, true);
});

test('enabled notification config requires a verified target and authorization timestamp', () => {
  const valid = NotificationConfigSchema.safeParse({
    version: 1,
    enabled: true,
    target: { openConversationId: 'conversation-1', displayName: 'Test group' },
    authorizedAt: '2026-10-22T10:00:00.000Z',
  });
  const missingTarget = NotificationConfigSchema.safeParse({
    version: 1,
    enabled: true,
    target: null,
    authorizedAt: null,
  });

  assert.equal(valid.success, true);
  assert.equal(missingTarget.success, false);
});

test('DWS send receipt parses openTaskId while tolerating additional envelope fields', () => {
  const result = DwsSendResponseSchema.safeParse({
    success: true,
    result: { openTaskId: 'task-1' },
    errorCode: null,
    errorMsg: null,
    arguments: [],
  });

  assert.equal(result.success, true);
});

test('DWS send status preserves a non-success status for conservative handling', () => {
  const result = DwsSendStatusResponseSchema.safeParse({
    success: true,
    openTaskId: 'task-1',
    result: {
      openConversationId: 'conversation-1',
      openMessageId: 'message-1',
      sendStatus: 'PENDING',
    },
  });

  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.result.sendStatus, 'PENDING');
});

test('DWS pre-send validation errors are distinguishable from unknown API outcomes', () => {
  const result = DwsToolValidationErrorResponseSchema.safeParse({
    error: {
      category: 'api',
      code: 1,
      message: 'invalid request',
      reason: 'invalid_request',
      stage: 'tool_validation',
    },
  });

  assert.equal(result.success, true);
});

test('notification ledger rejects delivery states outside its state model', () => {
  const result = NotificationCompletionLedgerSchema.safeParse({
    sessionId: 'session-1',
    assistantMessageId: 'message-1',
    completionKey: 'session-1:message-1',
    messageDigest: 'digest-1',
    ownerPid: process.pid,
    partCount: 1,
    state: 'delivered',
    sentParts: [],
    updatedAt: '2026-10-22T10:00:00.000Z',
  });

  assert.equal(result.success, false);
});

test('notification result schema distinguishes successful and unknown outcomes', () => {
  const sent = NotificationChunkResultSchema.safeParse({ state: 'sent', sentParts: [1, 2] });
  const unknown = NotificationChunkResultSchema.safeParse({ state: 'unknown', sentParts: [1], reason: 'timeout' });

  assert.equal(sent.success, true);
  assert.equal(unknown.success, true);
});

test('OpenCode session message schema preserves completed assistant text parts', () => {
  const result = OpenCodeSessionMessagesResponseSchema.safeParse([
    {
      info: {
        id: 'message-1',
        sessionID: 'session-1',
        role: 'assistant',
        time: { created: 1, completed: 2 },
      },
      parts: [{ type: 'text', text: 'completed answer' }],
    },
  ]);

  assert.equal(result.success, true);
  if (result.success && Array.isArray(result.data)) {
    assert.equal(result.data[0]?.parts[0]?.text, 'completed answer');
  }
});
