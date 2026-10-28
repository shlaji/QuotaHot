export const storeSchema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS bootstrap_marker (name TEXT PRIMARY KEY NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS targets (
    profile_key TEXT NOT NULL CHECK(length(profile_key) > 0),
    target_type TEXT NOT NULL CHECK(target_type IN ('person','group')),
    target_id TEXT NOT NULL CHECK(length(target_id) > 0),
    display_name TEXT NOT NULL,
    listening_desired INTEGER NOT NULL DEFAULT 0 CHECK(listening_desired IN (0,1)),
    is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0,1)),
    created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL),
    PRIMARY KEY(profile_key, target_type, target_id),
    CHECK(listening_desired = 0 OR is_active = 1)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS single_active_target ON targets(is_active) WHERE is_active = 1;
  CREATE TABLE IF NOT EXISTS subscriptions (
    subscription_id TEXT PRIMARY KEY NOT NULL CHECK(length(subscription_id) > 0),
    profile_key TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    event_key TEXT NOT NULL CHECK(
      (target_type = 'person' AND event_key = 'user_im_message_receive_o2o') OR
      (target_type = 'group' AND event_key = 'user_im_message_receive_group')),
    state TEXT NOT NULL CHECK(state IN ('starting','ready','stopping','stopped','failed','interrupted')),
    started_at TEXT CHECK(started_at IS NULL OR julianday(started_at) IS NOT NULL),
    ended_at TEXT CHECK(ended_at IS NULL OR julianday(ended_at) IS NOT NULL),
    failure_code TEXT,
    failure_message TEXT,
    FOREIGN KEY(profile_key,target_type,target_id) REFERENCES targets(profile_key,target_type,target_id)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS single_live_subscription ON subscriptions((1))
    WHERE state IN ('starting','ready','stopping');
  CREATE TRIGGER IF NOT EXISTS subscription_initial_state BEFORE INSERT ON subscriptions
    WHEN NEW.state != 'starting' BEGIN SELECT RAISE(ABORT, 'invalid initial subscription state'); END;
  CREATE TRIGGER IF NOT EXISTS subscription_identity BEFORE UPDATE OF profile_key,target_type,target_id,event_key,subscription_id
    ON subscriptions BEGIN SELECT RAISE(ABORT, 'immutable subscription identity'); END;
  CREATE TRIGGER IF NOT EXISTS subscription_transition BEFORE UPDATE OF state ON subscriptions
    WHEN NOT (NEW.state = OLD.state OR
      (OLD.state = 'starting' AND NEW.state IN ('ready','failed','interrupted')) OR
      (OLD.state = 'ready' AND NEW.state IN ('stopping','failed','interrupted')) OR
      (OLD.state = 'stopping' AND NEW.state IN ('stopped','failed','interrupted')))
    BEGIN SELECT RAISE(ABORT, 'invalid subscription transition'); END;
  CREATE TABLE IF NOT EXISTS messages (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    local_id TEXT NOT NULL UNIQUE CHECK(length(local_id) > 0),
    profile_key TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    conversation_id TEXT CHECK(conversation_id IS NULL OR length(conversation_id) > 0),
    event_id TEXT CHECK(event_id IS NULL OR length(event_id) > 0),
    message_id TEXT CHECK(message_id IS NULL OR length(message_id) > 0),
    sender_id TEXT,
    sender_name TEXT,
    direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
    content_type TEXT NOT NULL CHECK(content_type = 'text'),
    content TEXT NOT NULL,
    source_time TEXT CHECK(source_time IS NULL OR julianday(source_time) IS NOT NULL),
    received_at TEXT CHECK(received_at IS NULL OR julianday(received_at) IS NOT NULL),
    stored_at TEXT NOT NULL CHECK(julianday(stored_at) IS NOT NULL),
    send_state TEXT NOT NULL CHECK(send_state IN ('not_applicable','pending','accepted','failed','unknown')),
    CHECK((direction = 'inbound' AND send_state = 'not_applicable' AND conversation_id IS NOT NULL AND received_at IS NOT NULL)
      OR (direction = 'outbound' AND send_state != 'not_applicable')),
    FOREIGN KEY(profile_key,target_type,target_id) REFERENCES targets(profile_key,target_type,target_id)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS message_identity ON messages(profile_key,conversation_id,message_id)
    WHERE message_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS event_identity ON messages(profile_key,event_id)
    WHERE message_id IS NULL AND event_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS target_history ON messages(profile_key,target_type,target_id,stored_at DESC,sequence DESC);
  CREATE INDEX IF NOT EXISTS message_retention ON messages(stored_at);
`;
