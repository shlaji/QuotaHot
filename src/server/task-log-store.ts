import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type {
  TaskArchiveState, TaskLogChunk, TaskLogCursor, TaskLogPage, TaskLogPageRequest,
  TaskOutputChunk, TaskPreviewMetadata, TaskRun, TaskRunKind,
} from '../shared/tasks.js';
import { initializeTaskLogSchema, TASK_LOG_CHUNK_BYTES, taskTransaction } from './task-log-schema.js';

export const TASK_LOG_PAGE_BYTES = 256 * 1024;
export const TASK_LOG_PAGE_CHUNKS = 128;

function text(value: SQLOutputValue): string {
  if (typeof value !== 'string') throw new TypeError('Invalid task archive text');
  return value;
}

function integer(value: SQLOutputValue): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError('Invalid task archive integer');
  return value;
}

function timestamp(value: SQLOutputValue): number | null {
  return value === null ? null : Date.parse(text(value));
}

function archiveState(value: SQLOutputValue): TaskArchiveState {
  switch (value) {
    case 'capturing': case 'complete': case 'incomplete': case 'legacy_unknown': return value;
    default: throw new TypeError('Invalid task archive state');
  }
}

function logStream(value: SQLOutputValue): TaskLogChunk['stream'] {
  switch (value) {
    case 'stdout': case 'stderr': case 'legacy': return value;
    default: throw new TypeError('Invalid task archive stream');
  }
}

function decodeRun(row: Record<string, SQLOutputValue>): TaskRun {
  const kind = row.kind;
  const status = row.status;
  if (kind !== 'initial' && kind !== 'continuation' && kind !== 'legacy_unknown') throw new TypeError('Invalid task run kind');
  if (status !== 'pending' && status !== 'running' && status !== 'succeeded'
    && status !== 'failed' && status !== 'cancelled') throw new TypeError('Invalid task run status');
  return {
    id: text(row.id), taskId: text(row.task_id), ordinal: integer(row.ordinal), kind, status,
    createdAt: Date.parse(text(row.created_at)), startedAt: timestamp(row.started_at),
    finishedAt: timestamp(row.finished_at), closedAt: timestamp(row.closed_at), error: text(row.error),
    archiveState: archiveState(row.archive_state), totalBytes: integer(row.total_bytes), totalChunks: integer(row.total_chunks),
  };
}

function pageLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid task log page limit');
  return Math.min(value, maximum);
}

export class TaskRunWriteError extends Error {
  readonly name = 'TaskRunWriteError';
  constructor(readonly taskId: string, readonly runId: string) {
    super(`Task run is not writable: ${taskId}/${runId}`);
  }
}

export class TaskLogStore {
  constructor(private readonly db: DatabaseSync) { initializeTaskLogSchema(db); }

  createRun(taskId: string, kind: Exclude<TaskRunKind, 'legacy_unknown'>, now: number): string {
    const runId = randomUUID();
    const time = new Date(now).toISOString();
    this.db.prepare(`INSERT INTO task_runs (id, task_id, ordinal, kind, status, created_at, started_at, archive_state)
      SELECT ?, ?, COALESCE(MAX(ordinal), 0) + 1, ?, 'running', ?, ?, 'capturing'
      FROM task_runs WHERE task_id = ?`).run(runId, taskId, kind, time, time, taskId);
    this.db.prepare('UPDATE tasks SET current_run_id = ? WHERE id = ?').run(runId, taskId);
    return runId;
  }

  currentRunId(taskId: string): string | null {
    const row = this.db.prepare(`SELECT current_run_id FROM tasks WHERE id = ?
      AND status IN ('running','cancelled') AND EXISTS
      (SELECT 1 FROM task_runs WHERE id = tasks.current_run_id AND closed_at IS NULL)`).get(taskId);
    return row ? text(row.current_run_id) : null;
  }

  writable(taskId: string, runId: string): TaskRun {
    const row = this.db.prepare(`SELECT task_runs.* FROM task_runs JOIN tasks ON tasks.id = task_runs.task_id
      WHERE task_runs.id = ? AND tasks.id = ? AND tasks.current_run_id = task_runs.id
      AND tasks.status IN ('running','cancelled') AND task_runs.closed_at IS NULL`).get(runId, taskId);
    if (!row) throw new TaskRunWriteError(taskId, runId);
    return decodeRun(row);
  }

  append(taskId: string, runId: string, bytes: Uint8Array, stream: TaskOutputChunk['stream']): TaskLogCursor {
    return taskTransaction(this.db, () => {
      const run = this.writable(taskId, runId);
      if (run.kind === 'legacy_unknown') throw new TaskRunWriteError(taskId, runId);
      const insert = this.db.prepare('INSERT INTO task_log_chunks (run_id, sequence, byte_offset, stream, data) VALUES (?, ?, ?, ?, ?)');
      let sequence = run.totalChunks;
      for (let offset = 0; offset < bytes.length; offset += TASK_LOG_CHUNK_BYTES) {
        insert.run(runId, sequence++, run.totalBytes + offset, stream, bytes.subarray(offset, offset + TASK_LOG_CHUNK_BYTES));
      }
      this.db.prepare('UPDATE task_runs SET total_bytes = ?, total_chunks = ? WHERE id = ?')
        .run(run.totalBytes + bytes.length, sequence, runId);
      return { runId, sequence, byteOffset: run.totalBytes + bytes.length };
    });
  }

  listRuns(taskId: string): TaskRun[] {
    return this.db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY ordinal').all(taskId).map(decodeRun);
  }

  previewMetadata(taskId: string): TaskPreviewMetadata | null {
    const row = this.db.prepare(`SELECT tasks.current_run_id, length(CAST(tasks.output AS BLOB)) AS preview_bytes,
      task_runs.total_bytes, task_runs.total_chunks, task_runs.archive_state
      FROM tasks LEFT JOIN task_runs ON task_runs.id = tasks.current_run_id WHERE tasks.id = ?`).get(taskId);
    return row ? {
      taskId, currentRunId: row.current_run_id === null ? null : text(row.current_run_id),
      previewBytes: integer(row.preview_bytes), totalBytes: row.total_bytes === null ? 0 : integer(row.total_bytes),
      totalChunks: row.total_chunks === null ? 0 : integer(row.total_chunks),
      archiveState: row.archive_state === null ? null : archiveState(row.archive_state),
    } : null;
  }

  readPage(taskId: string, runId: string, request: TaskLogPageRequest): TaskLogPage | null {
    const maxBytes = pageLimit(request.maxBytes ?? TASK_LOG_CHUNK_BYTES, TASK_LOG_PAGE_BYTES);
    const maxChunks = pageLimit(request.maxChunks ?? TASK_LOG_PAGE_CHUNKS, TASK_LOG_PAGE_CHUNKS);
    if (request.tail && request.cursor) throw new RangeError('A tail page cannot also have a cursor');
    let cursor = request.cursor ?? { runId, sequence: 0, byteOffset: 0 };
    if (cursor.runId !== runId || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0
      || !Number.isSafeInteger(cursor.byteOffset) || cursor.byteOffset < 0) throw new RangeError('Invalid task log cursor');
    return taskTransaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM task_runs WHERE id = ? AND task_id = ?').get(runId, taskId);
      if (!row) return null;
      const run = decodeRun(row);
      if (request.tail && request.cursor === undefined) cursor = this.tailCursor(run, maxBytes, maxChunks);
      if (cursor.byteOffset !== run.totalBytes || cursor.sequence !== run.totalChunks) {
        const position = this.db.prepare(`SELECT 1 FROM task_log_chunks WHERE run_id = ? AND sequence = ?
          AND byte_offset <= ? AND byte_offset + length(data) > ?`).get(runId, cursor.sequence, cursor.byteOffset, cursor.byteOffset);
        if (!position) throw new RangeError('Task log cursor does not match a committed position');
      }
      const end = cursor.byteOffset + maxBytes;
      const rows = this.db.prepare(`SELECT sequence, byte_offset, stream, length(data) AS stored_length,
        substr(data, max(?, byte_offset) - byte_offset + 1,
          min(byte_offset + length(data), ?) - max(?, byte_offset)) AS data
        FROM task_log_chunks WHERE run_id = ? AND sequence >= ? AND byte_offset < ?
        ORDER BY sequence LIMIT ?`).all(cursor.byteOffset, end, cursor.byteOffset, runId, cursor.sequence, end, maxChunks);
      let nextCursor = cursor;
      const chunks: TaskLogChunk[] = rows.map((chunk) => {
        if (!(chunk.data instanceof Uint8Array)) throw new TypeError('Invalid task archive bytes');
        const sequence = integer(chunk.sequence);
        const storedOffset = integer(chunk.byte_offset);
        const byteOffset = Math.max(cursor.byteOffset, storedOffset);
        const nextOffset = byteOffset + chunk.data.length;
        nextCursor = {
          runId, sequence: sequence + Number(nextOffset === storedOffset + integer(chunk.stored_length)), byteOffset: nextOffset,
        };
        return { sequence, byteOffset, stream: logStream(chunk.stream), data: chunk.data };
      });
      return {
        runId, chunks, nextCursor, totalBytes: run.totalBytes, totalChunks: run.totalChunks,
        hasEarlier: cursor.byteOffset > 0, hasMore: nextCursor.byteOffset < run.totalBytes,
      };
    }, 'DEFERRED');
  }

  private tailCursor(run: TaskRun, maxBytes: number, maxChunks: number): TaskLogCursor {
    if (run.totalBytes === 0) return { runId: run.id, sequence: 0, byteOffset: 0 };
    const rows = this.db.prepare(`SELECT sequence, byte_offset, length(data) AS chunk_bytes
      FROM task_log_chunks WHERE run_id = ? ORDER BY sequence DESC LIMIT ?`).all(run.id, maxChunks);
    let remaining = maxBytes;
    let byteOffset = run.totalBytes;
    let sequence = run.totalChunks;
    for (const row of rows) {
      const chunkSequence = integer(row.sequence);
      const chunkOffset = integer(row.byte_offset);
      const chunkBytes = integer(row.chunk_bytes);
      const chunkEnd = Math.min(byteOffset, chunkOffset + chunkBytes);
      const take = Math.min(remaining, chunkEnd - chunkOffset);
      byteOffset = chunkEnd - take;
      sequence = chunkSequence;
      remaining -= take;
      if (remaining === 0) break;
    }
    return { runId: run.id, sequence, byteOffset };
  }
}
