import type { SQLOutputValue } from 'node:sqlite';
import { eventKeys, sendStates, subscriptionStates, targetTypes } from '../shared/types.js';
import type { DingtalkSubscription, DingtalkTarget, StoredMessage } from '../shared/types.js';

type Row = Record<string, SQLOutputValue>;

export class StoreError extends Error {
  constructor(readonly code: 'invalid_row' | 'missing_target' | 'missing_record') {
    super(code);
    this.name = 'StoreError';
  }
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new StoreError('invalid_row');
  return value;
}

function nullableText(row: Row, key: string): string | null {
  return row[key] === null ? null : text(row, key);
}

function literal<const Values extends readonly string[]>(row: Row, key: string, values: Values): Values[number] {
  const value = text(row, key);
  for (const candidate of values) if (candidate === value) return candidate;
  throw new StoreError('invalid_row');
}

function identity(row: Row) {
  return { profileKey: text(row, 'profile_key'), targetType: literal(row, 'target_type', targetTypes), targetId: text(row, 'target_id') };
}

export function targetFromRow(row: Row): DingtalkTarget {
  return { ...identity(row), displayName: text(row, 'display_name'), listeningDesired: row.listening_desired === 1,
    createdAt: text(row, 'created_at'), updatedAt: text(row, 'updated_at') };
}

export function subscriptionFromRow(row: Row): DingtalkSubscription {
  return { ...identity(row), subscriptionId: text(row, 'subscription_id'), eventKey: literal(row, 'event_key', eventKeys),
    state: literal(row, 'state', subscriptionStates), startedAt: nullableText(row, 'started_at'), endedAt: nullableText(row, 'ended_at'),
    failureCode: nullableText(row, 'failure_code'), failureMessage: nullableText(row, 'failure_message') };
}

export function messageFromRow(row: Row): StoredMessage {
  if (typeof row.sequence !== 'number') throw new StoreError('invalid_row');
  return { ...identity(row), sequence: row.sequence, localId: text(row, 'local_id'),
    conversationId: nullableText(row, 'conversation_id'), eventId: nullableText(row, 'event_id'), messageId: nullableText(row, 'message_id'),
    senderId: nullableText(row, 'sender_id'), senderName: nullableText(row, 'sender_name'),
    direction: literal(row, 'direction', ['inbound', 'outbound']), contentType: literal(row, 'content_type', ['text']),
    content: text(row, 'content'), sourceTime: nullableText(row, 'source_time'), receivedAt: nullableText(row, 'received_at'),
    storedAt: text(row, 'stored_at'), sendState: literal(row, 'send_state', sendStates) };
}
