import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { WECHAT_DB_PATH } from '../config.js';
import { appendItems, readItems } from './store-items.js';
import { migrateWechatInboxData } from './migrate.js';
import { choice, integer, text, type Row } from './store-rows.js';
import { INBOX_SCHEMA, secureInboxPath } from './store-schema.js';
import { kinds, outboundStates, states, type InboxAttachment, type InboxBinding, type InboxBindingInput,
  type InboxMessage, type InboxMessageInput, type InboxMessagePage, type InboxOutboundState } from './store-types.js';

export type { InboxAttachment, InboxBinding, InboxBindingInput, InboxItem, InboxItemInput, InboxMessage,
  InboxMessageInput, InboxMessagePage, InboxOutboundState } from './store-types.js';

export const WECHAT_INBOX_DB_PATH = join(dirname(WECHAT_DB_PATH), 'inbox.db');

function binding(row: Row): InboxBinding {
  return { ownerIlinkUserId: text(row.owner), botId: text(row.bot_id), createdAt: text(row.created_at),
    updatedAt: text(row.updated_at), unlinkedAt: row.unlinked_at === null ? null : text(row.unlinked_at) };
}

export class WechatInboxStore {
  private readonly db: DatabaseSync;
  constructor(path = WECHAT_INBOX_DB_PATH) {
    secureInboxPath(path);
    migrateWechatInboxData(path);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      this.transaction(() => this.db.exec(INBOX_SCHEMA));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<Result>(action: () => Result): Result {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  saveBinding(input: InboxBindingInput, now: string): void {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO inbox_bindings VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(owner) DO UPDATE SET bot_id = excluded.bot_id, updated_at = excluded.updated_at,
        unlinked_at = excluded.unlinked_at`).run(input.ownerIlinkUserId, input.botId, now, now, input.unlinkedAt ?? null);
      this.db.prepare("INSERT INTO inbox_cursors VALUES (?, '') ON CONFLICT(owner) DO NOTHING").run(input.ownerIlinkUserId);
    });
  }

  getBinding(owner: string): InboxBinding | null {
    const row = this.db.prepare('SELECT * FROM inbox_bindings WHERE owner = ?').get(owner);
    return row ? binding(row) : null;
  }
  listBindings(): readonly InboxBinding[] {
    return this.db.prepare('SELECT * FROM inbox_bindings ORDER BY created_at, owner').all().map(binding);
  }
  getCursor(owner: string): string {
    const row = this.db.prepare('SELECT cursor FROM inbox_cursors WHERE owner = ?').get(owner);
    return row ? text(row.cursor) : '';
  }
  getLatestContextToken(owner: string): string | null {
    const row = this.db.prepare('SELECT context_token FROM inbox_binding_contexts WHERE owner = ?').get(owner);
    return row && row.context_token !== null ? text(row.context_token) : null;
  }

  saveBatch(owner: string, batch: { readonly nextCursor: string; readonly messages: readonly InboxMessageInput[] }): void {
    this.transaction(() => {
      if (!this.getBinding(owner)) throw new RangeError('Unknown inbox binding');
      for (const input of batch.messages) this.appendMessage(owner, input);
      if (batch.nextCursor !== '') this.db.prepare('UPDATE inbox_cursors SET cursor = ? WHERE owner = ?').run(batch.nextCursor, owner);
    });
  }

  findOutboundMessageId(owner: string, clientId: string): string | null {
    const row = this.db.prepare(`SELECT id FROM inbox_binding_messages WHERE owner = ? AND client_id = ? AND direction = 'outbound'`)
      .get(owner, clientId);
    return row ? text(row.id) : null;
  }

  updateOutboundState(owner: string, id: string, state: InboxOutboundState): InboxOutboundState | null {
    const nextState = choice(outboundStates, state);
    return this.transaction(() => {
      this.db.prepare(`UPDATE inbox_binding_messages SET state = ?
        WHERE owner = ? AND id = ? AND direction = 'outbound' AND state <> 'accepted'`).run(nextState, owner, id);
      const row = this.db.prepare(`SELECT state FROM inbox_binding_messages
        WHERE owner = ? AND id = ? AND direction = 'outbound'`).get(owner, id);
      return row ? choice(outboundStates, row.state) : null;
    });
  }

  markInterruptedOutboundUnknown(): number {
    return Number(this.db.prepare(`UPDATE inbox_binding_messages SET state = 'unknown'
      WHERE direction = 'outbound' AND state IN ('queued', 'uploading', 'sending')`).run().changes);
  }

  private appendMessage(owner: string, input: InboxMessageInput): void {
    if (input.remoteMessageId !== null && typeof input.remoteMessageId !== 'string') {
      throw new TypeError('Inbox remote message ID must be a string');
    }
    const fingerprint = input.fingerprint ?? null;
    if (fingerprint !== null && (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)
      || input.direction !== 'inbound' || input.remoteMessageId !== null || input.kind !== 'protocol_event')) {
      throw new TypeError('Invalid inbox fingerprint');
    }
    if (input.direction === 'outbound' && input.clientId !== null) {
      const existing = this.db.prepare(`SELECT id, remote_message_id FROM inbox_binding_messages
        WHERE owner = ? AND client_id = ? AND direction = 'outbound'`).get(owner, input.clientId);
      if (existing) {
        if (input.remoteMessageId === null) throw new TypeError('Conflicting inbox outbound identity');
        if (existing.remote_message_id !== null && existing.remote_message_id !== input.remoteMessageId) {
          throw new TypeError('Conflicting inbox outbound identity');
        }
        if (input.remoteMessageId !== null) {
          this.db.prepare(`UPDATE inbox_binding_messages SET remote_message_id = ?, state = 'accepted'
            WHERE owner = ? AND id = ?`).run(input.remoteMessageId, owner, text(existing.id));
        }
        return;
      }
    }
    if (input.remoteMessageId !== null && this.db.prepare(`SELECT id FROM inbox_binding_messages
      WHERE owner = ? AND remote_message_id = ?`).get(owner, input.remoteMessageId)) return;
    if (fingerprint !== null && this.db.prepare(`SELECT id FROM inbox_binding_messages
      WHERE owner = ? AND fingerprint = ?`).get(owner, fingerprint)) return;

    const id = randomUUID();
    const row = this.db.prepare(`INSERT INTO inbox_binding_messages
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?
      FROM inbox_binding_messages WHERE owner = ?
      RETURNING id`).get(id, owner, input.remoteMessageId, input.clientId, input.direction, input.messageType,
      input.kind, input.state, input.createdAt, input.runId, fingerprint, owner);
    if (!row) throw new TypeError('Unable to persist inbox message');
    appendItems(this.db, owner, id, input);
    if (input.direction === 'inbound' && input.contextToken !== undefined) {
      this.db.prepare(`INSERT INTO inbox_binding_contexts VALUES (?, ?)
        ON CONFLICT(owner) DO UPDATE SET context_token = excluded.context_token`).run(owner, input.contextToken);
    }
  }

  listMessages(owner: string, page: { readonly limit?: number; readonly before?: string | null } = {}): InboxMessagePage {
    const limit = page.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid inbox page limit');
    let before = Number.MAX_SAFE_INTEGER;
    if (page.before !== undefined && page.before !== null) {
      const row = this.db.prepare('SELECT sequence FROM inbox_binding_messages WHERE owner = ? AND id = ?')
        .get(owner, page.before);
      if (!row) throw new RangeError('Invalid inbox page cursor');
      before = integer(row.sequence);
    }
    const rows = this.db.prepare(`SELECT * FROM inbox_binding_messages
      WHERE owner = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?`).all(owner, before, limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).reverse().map((row) => this.message(row));
    return { items, hasMore, nextCursor: hasMore ? items[0]?.id ?? null : null };
  }

  private message(row: Row): InboxMessage {
    const items = readItems(this.db, text(row.id));
    return { id: text(row.id), ownerIlinkUserId: text(row.owner), remoteMessageId: row.remote_message_id === null ? null : text(row.remote_message_id),
      clientId: row.client_id === null ? null : text(row.client_id), direction: choice(['inbound', 'outbound'], row.direction),
      messageType: integer(row.message_type), kind: choice(kinds, row.kind), state: choice(states, row.state),
      sequence: integer(row.sequence), createdAt: text(row.created_at), runId: row.run_id === null ? null : text(row.run_id),
      text: items.find((item) => item.kind === 'text')?.text ?? null, items };
  }

  getAttachmentById(id: string) {
    const row = this.db.prepare('SELECT owner FROM inbox_binding_attachments WHERE id = ?').get(id);
    if (!row) return null;
    const owner = text(row.owner);
    const attachment = this.getAttachment(owner, id);
    return attachment ? { attachment, chunks: this.readAttachmentChunks(owner, id) } : null;
  }

  getAttachment(owner: string, id: string): InboxAttachment | null {
    const row = this.db.prepare('SELECT * FROM inbox_binding_attachments WHERE owner = ? AND id = ?').get(owner, id);
    return row ? { id: text(row.id), ownerIlinkUserId: text(row.owner), messageId: text(row.message_id),
      direction: choice(['inbound', 'outbound'], row.direction), kind: choice(kinds, row.kind),
      fileName: text(row.file_name), mediaType: text(row.media_type), sizeBytes: integer(row.size_bytes),
      sha256: text(row.sha256), chunkCount: integer(row.chunk_count), createdAt: text(row.created_at) } : null;
  }

  *readAttachmentChunks(owner: string, id: string): IterableIterator<Uint8Array> {
    if (!this.getAttachment(owner, id)) return;
    for (const row of this.db.prepare(`SELECT data FROM inbox_binding_chunks
      WHERE owner = ? AND attachment_id = ? ORDER BY chunk_index`).iterate(owner, id)) {
      if (!(row.data instanceof Uint8Array)) throw new TypeError('Invalid inbox attachment chunk');
      yield row.data;
    }
  }

  close(): void { this.db.close(); }
}
