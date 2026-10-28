import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

export function secureInboxPath(path: string): void {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (existsSync(`${path}${suffix}`)) chmodSync(`${path}${suffix}`, 0o600);
    }
  }
}

export const INBOX_SCHEMA = `
  CREATE TABLE IF NOT EXISTS inbox_bindings (
    owner TEXT PRIMARY KEY NOT NULL, bot_id TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, unlinked_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS inbox_cursors (
    owner TEXT PRIMARY KEY NOT NULL REFERENCES inbox_bindings(owner), cursor TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS inbox_binding_contexts (
    owner TEXT PRIMARY KEY NOT NULL REFERENCES inbox_bindings(owner), context_token TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS inbox_binding_messages (
    id TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL REFERENCES inbox_bindings(owner),
    remote_message_id TEXT, client_id TEXT, direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
    message_type INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('text','image','voice','file','video','protocol_event')),
    state TEXT NOT NULL CHECK(state IN ('received','queued','uploading','sending','accepted','failed','unknown')),
    sequence INTEGER NOT NULL CHECK(sequence > 0), created_at TEXT NOT NULL, run_id TEXT, fingerprint TEXT,
    CHECK(fingerprint IS NULL OR (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
      AND direction = 'inbound' AND remote_message_id IS NULL AND kind = 'protocol_event')),
    UNIQUE(owner, sequence)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS inbox_binding_remote ON inbox_binding_messages(owner, remote_message_id)
    WHERE remote_message_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS inbox_binding_outbound_client ON inbox_binding_messages(owner, client_id)
    WHERE direction = 'outbound' AND client_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS inbox_binding_fingerprint ON inbox_binding_messages(owner, fingerprint)
    WHERE fingerprint IS NOT NULL;
  CREATE TABLE IF NOT EXISTS inbox_binding_attachments (
    id TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL REFERENCES inbox_bindings(owner),
    message_id TEXT NOT NULL REFERENCES inbox_binding_messages(id),
    direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
    kind TEXT NOT NULL CHECK(kind IN ('image','voice','file','video')),
    file_name TEXT NOT NULL, media_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
    sha256 TEXT NOT NULL, chunk_count INTEGER NOT NULL CHECK(chunk_count >= 0), created_at TEXT NOT NULL,
    UNIQUE(message_id, id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS inbox_binding_items (
    message_id TEXT NOT NULL REFERENCES inbox_binding_messages(id), item_index INTEGER NOT NULL CHECK(item_index >= 0),
    kind TEXT NOT NULL CHECK(kind IN ('text','image','voice','file','video','protocol_event')), text TEXT,
    attachment_id TEXT, width INTEGER, height INTEGER, duration_ms INTEGER, codec TEXT, safe_summary TEXT,
    PRIMARY KEY(message_id, item_index),
    FOREIGN KEY(message_id, attachment_id) REFERENCES inbox_binding_attachments(message_id, id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS inbox_binding_chunks (
    owner TEXT NOT NULL REFERENCES inbox_bindings(owner), attachment_id TEXT NOT NULL REFERENCES inbox_binding_attachments(id),
    chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0), data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 65536),
    PRIMARY KEY(attachment_id, chunk_index)
  ) STRICT;
`;
