import type { DatabaseSync } from 'node:sqlite';

export const TASK_LOG_CHUNK_BYTES = 64 * 1024;

export function taskTransaction<Result>(db: DatabaseSync, action: () => Result, mode: 'IMMEDIATE' | 'DEFERRED' = 'IMMEDIATE'): Result {
  db.exec(`BEGIN ${mode}`);
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export function initializeTaskLogSchema(db: DatabaseSync): void {
  taskTransaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, description TEXT NOT NULL, model TEXT NOT NULL,
        directory TEXT NOT NULL, trigger_type TEXT NOT NULL CHECK(trigger_type IN ('quota','time','task')),
        trigger_at TEXT, status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled')),
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        output TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
        session_id TEXT, session_title TEXT,
        trigger_task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
        current_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
        CHECK((trigger_type = 'task' AND trigger_task_id IS NOT NULL AND trigger_task_id != id)
          OR (trigger_type != 'task' AND trigger_task_id IS NULL))
      );
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS tasks_dependency ON tasks(trigger_task_id);
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal > 0),
        kind TEXT NOT NULL CHECK(kind IN ('initial','continuation','legacy_unknown')),
        status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled')),
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, closed_at TEXT,
        error TEXT NOT NULL DEFAULT '',
        archive_state TEXT NOT NULL CHECK(archive_state IN ('capturing','complete','incomplete','legacy_unknown')),
        total_bytes INTEGER NOT NULL DEFAULT 0 CHECK(total_bytes >= 0),
        total_chunks INTEGER NOT NULL DEFAULT 0 CHECK(total_chunks >= 0),
        UNIQUE(task_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS task_log_chunks (
        run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence >= 0), byte_offset INTEGER NOT NULL CHECK(byte_offset >= 0),
        stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr','legacy')),
        data BLOB NOT NULL CHECK(typeof(data) = 'blob' AND length(data) BETWEEN 1 AND ${TASK_LOG_CHUNK_BYTES}),
        PRIMARY KEY(run_id, sequence), UNIQUE(run_id, byte_offset)
      ) WITHOUT ROWID;
    `);
  });
}
