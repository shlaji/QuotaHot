import { randomUUID } from 'node:crypto';
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
        trigger_task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
        CHECK((trigger_type = 'task' AND trigger_task_id IS NOT NULL AND trigger_task_id != id)
          OR (trigger_type != 'task' AND trigger_task_id IS NULL))
      );
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
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
    `);
    const chunkColumns = db.prepare('PRAGMA table_info(task_log_chunks)').all();
    if (chunkColumns.length > 0 && !chunkColumns.some((column) => column.name === 'stream')) {
      db.exec(`UPDATE task_runs SET total_bytes = 0, total_chunks = 0, archive_state = 'incomplete'
        WHERE total_bytes > 0 OR total_chunks > 0 OR id IN (SELECT run_id FROM task_log_chunks);
        DROP TABLE task_log_chunks;`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_log_chunks (
        run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence >= 0), byte_offset INTEGER NOT NULL CHECK(byte_offset >= 0),
        stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr','legacy')),
        data BLOB NOT NULL CHECK(typeof(data) = 'blob' AND length(data) BETWEEN 1 AND ${TASK_LOG_CHUNK_BYTES}),
        PRIMARY KEY(run_id, sequence), UNIQUE(run_id, byte_offset)
      ) WITHOUT ROWID;
    `);
    const columns = db.prepare('PRAGMA table_info(tasks)').all();
    if (!columns.some((column) => column.name === 'session_title')) db.exec('ALTER TABLE tasks ADD COLUMN session_title TEXT');
    if (!columns.some((column) => column.name === 'session_id')) db.exec('ALTER TABLE tasks ADD COLUMN session_id TEXT');
    if (!columns.some((column) => column.name === 'trigger_task_id')) {
      db.exec('ALTER TABLE tasks ADD COLUMN trigger_task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS tasks_dependency ON tasks(trigger_task_id)');
    if (columns.some((column) => column.name === 'current_run_id')) return;
    db.exec('ALTER TABLE tasks ADD COLUMN current_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL');
    const insertRun = db.prepare(`INSERT INTO task_runs
      (id, task_id, ordinal, kind, status, created_at, started_at, finished_at, closed_at, error,
       archive_state, total_bytes, total_chunks)
      SELECT ?, id, 1, 'legacy_unknown', status, created_at, started_at, finished_at,
        CASE WHEN status = 'running' THEN NULL ELSE COALESCE(finished_at, started_at, created_at) END,
        error, 'legacy_unknown', length(CAST(output AS BLOB)),
        (length(CAST(output AS BLOB)) + ${TASK_LOG_CHUNK_BYTES - 1}) / ${TASK_LOG_CHUNK_BYTES}
      FROM tasks WHERE id = ?`);
    const insertChunk = db.prepare(`INSERT INTO task_log_chunks (run_id, sequence, byte_offset, stream, data)
      SELECT ?, ?, ?, 'legacy', substr(CAST(output AS BLOB), ?, ?) FROM tasks WHERE id = ?`);
    for (const row of db.prepare(`SELECT id, length(CAST(output AS BLOB)) AS bytes FROM tasks
      WHERE status != 'pending' OR length(CAST(output AS BLOB)) > 0`).iterate()) {
      if (typeof row.id !== 'string' || typeof row.bytes !== 'number') throw new TypeError('Invalid legacy task output');
      const runId = randomUUID();
      insertRun.run(runId, row.id);
      for (let offset = 0; offset < row.bytes; offset += TASK_LOG_CHUNK_BYTES) {
        insertChunk.run(runId, offset / TASK_LOG_CHUNK_BYTES, offset, offset + 1, TASK_LOG_CHUNK_BYTES, row.id);
      }
      db.prepare('UPDATE tasks SET current_run_id = ? WHERE id = ?').run(runId, row.id);
    }
  });
}
