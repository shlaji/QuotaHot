import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import type { AppendMessageResult, DingtalkMessage, DingtalkSubscription, DingtalkTarget, MessagePage, SendState,
  StoredMessage, SubscriptionUpdate, TargetIdentity, TargetPage } from '../shared/types.js';
import { StoreError, messageFromRow, subscriptionFromRow, targetFromRow } from './store-codec.js';
import { storeSchema } from './store-schema.js';

export function defaultDatabasePath(dataDirectory = process.env.DINGTALK_INBOX_DATA_DIR ?? join(process.env.HOME ?? '.', '.dingtalk-inbox')): string {
  return join(dataDirectory, 'inbox.db');
}

function secureDatabasePath(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  closeSync(openSync(path, 'a', 0o600));
  chmodSync(path, 0o600);
}

export class InboxStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(path = defaultDatabasePath(), private readonly clock: () => Date = () => new Date()) {
    secureDatabasePath(path);
    this.database = new DatabaseSync(path);
    try {
      this.database.exec(storeSchema);
      chmodSync(`${path}-wal`, 0o600);
      chmodSync(`${path}-shm`, 0o600);
      this.transaction(() => {
        this.database.prepare("UPDATE subscriptions SET state = 'interrupted', ended_at = ? WHERE state IN ('starting','ready','stopping')")
          .run(this.clock().toISOString());
        this.database.exec("UPDATE messages SET send_state = 'unknown' WHERE direction = 'outbound' AND send_state = 'pending'");
        this.pruneMessages();
      });
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private transaction<Result>(operation: () => Result): Result {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  upsertTarget(target: Omit<DingtalkTarget, 'listeningDesired'>): DingtalkTarget {
    const row = this.database.prepare(`INSERT INTO targets
      (profile_key,target_type,target_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(profile_key,target_type,target_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at
      RETURNING *`).get(target.profileKey, target.targetType, target.targetId, target.displayName,
      new Date(target.createdAt).toISOString(), new Date(target.updatedAt).toISOString());
    if (!row) throw new StoreError('missing_target');
    return targetFromRow(row);
  }

  listTargets(profileKey: string, page: TargetPage = {}): readonly DingtalkTarget[] {
    return this.database.prepare(`SELECT * FROM targets WHERE profile_key = ? ORDER BY target_type,target_id LIMIT ? OFFSET ?`)
      .all(profileKey, page.limit ?? 100, page.offset ?? 0).map(targetFromRow);
  }

  setActiveTarget(target: TargetIdentity | null, listeningDesired = true): void {
    this.transaction(() => {
      this.database.exec('UPDATE targets SET is_active = 0, listening_desired = 0 WHERE is_active = 1');
      if (target === null) return;
      const result = this.database.prepare(`UPDATE targets SET is_active = 1, listening_desired = ?
        WHERE profile_key = ? AND target_type = ? AND target_id = ?`).run(Number(listeningDesired), target.profileKey, target.targetType, target.targetId);
      if (result.changes !== 1) throw new StoreError('missing_target');
    });
  }

  getActiveTarget(): DingtalkTarget | null {
    const row = this.database.prepare('SELECT * FROM targets WHERE is_active = 1').get();
    return row ? targetFromRow(row) : null;
  }

  setListeningDesired(desired: boolean): void {
    const result = this.database.prepare('UPDATE targets SET listening_desired = ? WHERE is_active = 1').run(Number(desired));
    if (result.changes !== 1) throw new StoreError('missing_target');
  }

  createSubscription(subscription: DingtalkSubscription): void {
    this.database.prepare(`INSERT INTO subscriptions
      (subscription_id,profile_key,target_type,target_id,event_key,state,started_at,ended_at,failure_code,failure_message)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(subscription.subscriptionId, subscription.profileKey, subscription.targetType,
      subscription.targetId, subscription.eventKey, subscription.state, normalizeTime(subscription.startedAt),
      normalizeTime(subscription.endedAt), subscription.failureCode, subscription.failureMessage);
  }

  getSubscription(subscriptionId: string): DingtalkSubscription | null {
    const row = this.database.prepare('SELECT * FROM subscriptions WHERE subscription_id = ?').get(subscriptionId);
    return row ? subscriptionFromRow(row) : null;
  }

  updateSubscription(subscriptionId: string, update: SubscriptionUpdate): void {
    const result = this.database.prepare(`UPDATE subscriptions SET state = ?,
      ended_at = CASE WHEN ? THEN ? ELSE ended_at END,
      failure_code = CASE WHEN ? THEN ? ELSE failure_code END,
      failure_message = CASE WHEN ? THEN ? ELSE failure_message END WHERE subscription_id = ?`)
      .run(update.state, Number(update.endedAt !== undefined), normalizeTime(update.endedAt ?? null),
        Number(update.failureCode !== undefined), update.failureCode ?? null,
        Number(update.failureMessage !== undefined), update.failureMessage ?? null, subscriptionId);
    if (result.changes !== 1) throw new StoreError('missing_record');
  }

  appendMessage(message: DingtalkMessage): AppendMessageResult {
    return this.transaction(() => {
      this.pruneMessages();
      const deduplication = message.messageId !== null && message.conversationId !== null ? 'message'
        : message.messageId === null && message.eventId !== null ? 'event' : 'unavailable';
      const inserted = this.database.prepare(`INSERT INTO messages
        (local_id,profile_key,target_type,target_id,conversation_id,event_id,message_id,sender_id,sender_name,
         direction,content_type,content,source_time,received_at,stored_at,send_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(profile_key,conversation_id,message_id) WHERE message_id IS NOT NULL DO NOTHING
        ON CONFLICT(profile_key,event_id) WHERE message_id IS NULL AND event_id IS NOT NULL DO NOTHING RETURNING *`)
        .get(message.localId, message.profileKey, message.targetType, message.targetId, message.conversationId,
          message.eventId, message.messageId, message.senderId, message.senderName, message.direction, message.contentType,
          message.content, normalizeTime(message.sourceTime), normalizeTime(message.receivedAt),
          new Date(message.storedAt).toISOString(), message.sendState);
      if (inserted) return { inserted: true, message: messageFromRow(inserted), deduplication };
      const existing = this.database.prepare(`SELECT * FROM messages WHERE profile_key = ? AND
        ((conversation_id = ? AND message_id = ?) OR (message_id IS NULL AND ? IS NULL AND event_id = ?))`)
        .get(message.profileKey, message.conversationId, message.messageId, message.messageId, message.eventId);
      if (!existing) throw new StoreError('missing_record');
      return { inserted: false, message: messageFromRow(existing), deduplication };
    });
  }

  listMessages(target: TargetIdentity, page: MessagePage = {}): readonly StoredMessage[] {
    this.pruneMessages();
    const before = page.before;
    return this.database.prepare(`SELECT * FROM messages WHERE profile_key = ? AND target_type = ? AND target_id = ?
      AND (? IS NULL OR stored_at < ? OR (stored_at = ? AND sequence < ?)) ORDER BY stored_at DESC,sequence DESC LIMIT ?`)
      .all(target.profileKey, target.targetType, target.targetId, before?.storedAt ?? null,
        before ? new Date(before.storedAt).toISOString() : null, before ? new Date(before.storedAt).toISOString() : null,
        before?.sequence ?? null, page.limit ?? 100).map(messageFromRow);
  }

  updateSendState(localId: string, state: Exclude<SendState, 'not_applicable' | 'pending'>): void {
    const result = this.database.prepare(`UPDATE messages SET send_state = ? WHERE local_id = ? AND direction = 'outbound'
      AND send_state IN ('pending','unknown')`).run(state, localId);
    if (result.changes !== 1) throw new StoreError('missing_record');
  }

  pruneMessages(now = this.clock()): number {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    return Number(this.database.prepare('DELETE FROM messages WHERE stored_at <= ?').run(cutoff).changes);
  }

  writeBootstrapMarker(name: string): void {
    this.database.prepare('INSERT INTO bootstrap_marker (name) VALUES (?)').run(name);
  }

  readBootstrapMarker(): string | null {
    const row = this.database.prepare('SELECT name FROM bootstrap_marker LIMIT 1').get();
    return row ? String(row.name) : null;
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}

function normalizeTime(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
