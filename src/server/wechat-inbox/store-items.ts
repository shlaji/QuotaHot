import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { choice, integer, text } from './store-rows.js';
import { InboxAttachmentSourceError, kinds, type InboxAttachmentInput, type InboxItem, type InboxMessageInput } from './store-types.js';

function filesystem<Result>(operation: () => Result): Result {
  try { return operation(); }
  catch (error) {
    if (error instanceof Error) throw new InboxAttachmentSourceError();
    throw error;
  }
}

function* attachmentChunks(attachment: InboxAttachmentInput): IterableIterator<Uint8Array> {
  if (typeof attachment !== 'object' || attachment === null) throw new InboxAttachmentSourceError();
  if (!('stagedFile' in attachment)) {
    if (!(attachment.bytes instanceof Uint8Array)) throw new TypeError('Invalid inbox attachment bytes');
    for (let offset = 0; offset < attachment.bytes.byteLength; offset += 65536) {
      yield attachment.bytes.subarray(offset, offset + 65536);
    }
    return;
  }
  const path = attachment.stagedFile;
  if ('bytes' in attachment || typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new InboxAttachmentSourceError();
  }
  const descriptor = filesystem(() => fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK));
  try {
    const stat = filesystem(() => fs.fstatSync(descriptor));
    if (!stat.isFile()) throw new InboxAttachmentSourceError();
    const buffer = Buffer.allocUnsafe(65536);
    let total = 0;
    while (true) {
      let length = 0;
      while (length < buffer.byteLength) {
        const count = filesystem(() => fs.readSync(descriptor, buffer, { offset: length, length: buffer.byteLength - length }));
        if (count === 0) break;
        length += count;
      }
      total += length;
      if (length > 0) yield buffer.subarray(0, length);
      if (length < buffer.byteLength) break;
    }
    if (total !== stat.size) throw new InboxAttachmentSourceError();
  } finally { filesystem(() => fs.closeSync(descriptor)); }
}

export function appendItems(db: DatabaseSync, owner: string, id: string, input: InboxMessageInput): void {
  for (const [index, item] of input.items.entries()) {
    const attachmentId = item.attachment ? randomUUID() : null;
    if (item.attachment && attachmentId) {
      const { fileName, mediaType } = item.attachment;
      db.prepare('INSERT INTO inbox_binding_attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(attachmentId, owner, id, input.direction, item.kind, fileName, mediaType, 0,
          createHash('sha256').digest('hex'), 0, input.createdAt);
      const insert = db.prepare('INSERT INTO inbox_binding_chunks VALUES (?, ?, ?, ?)');
      const digest = createHash('sha256');
      let size = 0;
      let chunkCount = 0;
      for (const chunk of attachmentChunks(item.attachment)) {
        insert.run(owner, attachmentId, chunkCount++, chunk);
        digest.update(chunk);
        size += chunk.byteLength;
      }
      db.prepare('UPDATE inbox_binding_attachments SET size_bytes = ?, sha256 = ?, chunk_count = ? WHERE owner = ? AND id = ?')
        .run(size, digest.digest('hex'), chunkCount, owner, attachmentId);
    }
    db.prepare('INSERT INTO inbox_binding_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, index, item.kind, item.text ?? null, attachmentId, item.width ?? null, item.height ?? null,
        item.durationMs ?? null, item.codec ?? null, item.safeSummary ?? null);
  }
}

export function readItems(db: DatabaseSync, messageId: string): readonly InboxItem[] {
  return db.prepare(`SELECT i.*, a.file_name, a.media_type, a.size_bytes FROM inbox_binding_items i
    LEFT JOIN inbox_binding_attachments a ON a.id = i.attachment_id WHERE i.message_id = ? ORDER BY i.item_index`)
    .all(messageId).map((item): InboxItem => ({
      kind: choice(kinds, item.kind), text: item.text === null ? null : text(item.text),
      attachmentId: item.attachment_id === null ? null : text(item.attachment_id),
      fileName: item.file_name === null ? null : text(item.file_name),
      mediaType: item.media_type === null ? null : text(item.media_type),
      sizeBytes: item.size_bytes === null ? null : integer(item.size_bytes),
      width: item.width === null ? null : integer(item.width), height: item.height === null ? null : integer(item.height),
      durationMs: item.duration_ms === null ? null : integer(item.duration_ms),
      codec: item.codec === null ? null : text(item.codec), safeSummary: item.safe_summary === null ? null : text(item.safe_summary),
    }));
}
