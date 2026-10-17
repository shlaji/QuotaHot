import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ClaimedTask, CreateTaskInput, ManagedTask, TaskTrigger, TaskSummary, TaskOutputResponse,
  TaskLogCursor, TaskLogPage, TaskLogPageRequest, TaskOutputChunk, TaskPreviewMetadata, TaskRun, TaskRunCompletion, TaskRunKind,
} from '../shared/tasks.js';
import { boundedText } from './task-output.js';
import { TaskLogStore } from './task-log-store.js';
import { taskTransaction } from './task-log-schema.js';

export type TaskOutcome = Readonly<Pick<ManagedTask, 'output' | 'error'>> & {
  readonly status: 'succeeded' | 'failed';
  readonly archiveState?: TaskRunCompletion['archiveState'];
};

function text(value: SQLOutputValue): string {
  if (typeof value !== 'string') throw new TypeError('Invalid task database text');
  return value;
}

function date(value: SQLOutputValue): number | null {
  return value === null ? null : Date.parse(text(value));
}

function decodeState(row: Record<string, SQLOutputValue>): Omit<TaskOutputResponse, 'output'> {
  const status = row.status;
  if (status !== 'pending' && status !== 'running' && status !== 'succeeded'
    && status !== 'failed' && status !== 'cancelled') throw new TypeError('Invalid task status');
  return {
    id: text(row.id), status, createdAt: Date.parse(text(row.created_at)),
    startedAt: date(row.started_at), finishedAt: date(row.finished_at), error: text(row.error),
  };
}

function decodeMetadata(row: Record<string, SQLOutputValue>): Omit<ManagedTask, 'output'> {
  let trigger: TaskTrigger;
  switch (row.trigger_type) {
    case 'quota': trigger = { type: 'quota' }; break;
    case 'time': trigger = { type: 'time', at: Date.parse(text(row.trigger_at)) }; break;
    default: throw new TypeError('Invalid task trigger');
  }
  return {
    ...decodeState(row), description: text(row.description), model: text(row.model),
    directory: text(row.directory), trigger,
    sessionId: row.session_id === null ? null : text(row.session_id),
  };
}

function decode(row: Record<string, SQLOutputValue>): ManagedTask {
  return { ...decodeMetadata(row), output: text(row.output) };
}

export class TaskStore {
  private readonly db: DatabaseSync;
  private readonly logs: TaskLogStore;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      this.logs = new TaskLogStore(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  create(input: CreateTaskInput, now: number): ManagedTask {
    const task: ManagedTask = {
      ...input, id: randomUUID(), status: 'pending', createdAt: now,
      startedAt: null, finishedAt: null, sessionId: null, output: '', error: '',
    };
    this.db.prepare(`INSERT INTO tasks
      (id, description, model, directory, trigger_type, trigger_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(task.id, input.description, input.model, input.directory, input.trigger.type,
        input.trigger.type === 'time' ? new Date(input.trigger.at).toISOString() : null,
        new Date(now).toISOString());
    return task;
  }

  list(): ManagedTask[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at, rowid').all().map(decode);
  }

  listSummaries(): TaskSummary[] {
    return this.db.prepare(`SELECT id, description, model, directory, trigger_type, trigger_at,
      status, session_id, created_at, started_at, finished_at, error, length(output) > 0 AS has_output
      FROM tasks ORDER BY created_at, rowid`).all()
      .map((row) => ({ ...decodeMetadata(row), hasOutput: row.has_output === 1 }));
  }

  getOutput(id: string): TaskOutputResponse | null {
    const row = this.db.prepare(`SELECT id, status, created_at, started_at, finished_at, error, output
      FROM tasks WHERE id = ?`).get(id);
    return row ? { ...decodeState(row), output: text(row.output) } : null;
  }

  get(id: string): ManagedTask | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? decode(row) : null;
  }

  claim(id: string, now: number): ClaimedTask | null {
    return this.claimRound(id, now, 'initial');
  }

  private claimRound(id: string, now: number, kind: Exclude<TaskRunKind, 'legacy_unknown'>): ClaimedTask | null {
    return taskTransaction(this.db, () => {
      const status = { initial: 'pending', continuation: 'succeeded' }[kind];
      const row = this.db.prepare(`UPDATE tasks SET status = 'running', started_at = ?,
        finished_at = NULL, output = '', error = '' WHERE id = ? AND status = ?
        AND (? = 'initial' OR (session_id IS NOT NULL AND session_id != '')) RETURNING *`)
        .get(new Date(now).toISOString(), id, status, kind);
      if (!row) return null;
      const currentRunId = this.logs.createRun(id, kind, now);
      return { ...decode(row), currentRunId };
    });
  }

  updateOutput(id: string, output: string): void {
    taskTransaction(this.db, () => {
      const runId = this.logs.currentRunId(id);
      if (!runId) return;
      this.db.prepare('UPDATE tasks SET output = ? WHERE id = ?').run(boundedText(output), id);
      this.db.prepare(`UPDATE task_runs SET archive_state = 'incomplete'
        WHERE id = ? AND archive_state = 'capturing'`).run(runId);
    });
  }

  appendOutput(id: string, runId: string, chunk: Uint8Array, stream: TaskOutputChunk['stream']): TaskLogCursor {
    return this.logs.append(id, runId, chunk, stream);
  }

  updatePreview(id: string, runId: string, preview: string): void {
    taskTransaction(this.db, () => {
      this.logs.writable(id, runId);
      this.db.prepare('UPDATE tasks SET output = ? WHERE id = ? AND current_run_id = ?').run(boundedText(preview), id, runId);
    });
  }

  listRuns(id: string): TaskRun[] { return this.logs.listRuns(id); }

  readLogPage(id: string, runId: string, request: TaskLogPageRequest = {}): TaskLogPage | null {
    return this.logs.readPage(id, runId, request);
  }

  getPreviewMetadata(id: string): TaskPreviewMetadata | null {
    return this.logs.previewMetadata(id);
  }

  setSession(id: string, sessionId: string): void {
    this.db.prepare(`UPDATE tasks SET session_id = ? WHERE id = ? AND session_id IS NULL
      AND status IN ('running','cancelled')`).run(sessionId, id);
  }

  claimContinuation(id: string, now: number): ClaimedTask | null {
    return this.claimRound(id, now, 'continuation');
  }

  finish(id: string, result: TaskOutcome, now: number): void {
    taskTransaction(this.db, () => {
      const runId = this.logs.currentRunId(id);
      if (runId) this.completeRun(id, runId, { ...result, finishedAt: now, archiveState: 'incomplete' });
    });
  }

  finishRun(id: string, runId: string, completion: TaskRunCompletion): void {
    taskTransaction(this.db, () => this.completeRun(id, runId, completion));
  }

  private completeRun(id: string, runId: string, result: TaskRunCompletion): void {
    this.logs.writable(id, runId);
    this.db.prepare(`UPDATE tasks SET output = ?,
      status = CASE WHEN status = 'running' THEN ? ELSE status END,
      error = CASE WHEN status = 'running' THEN ? ELSE error END,
      finished_at = CASE WHEN status = 'running' THEN ? ELSE finished_at END
      WHERE id = ? AND current_run_id = ?`)
      .run(boundedText(result.output), result.status, boundedText(result.error), new Date(result.finishedAt).toISOString(), id, runId);
    this.db.prepare(`UPDATE task_runs SET status = (SELECT status FROM tasks WHERE id = task_id),
      finished_at = (SELECT finished_at FROM tasks WHERE id = task_id),
      error = (SELECT error FROM tasks WHERE id = task_id), closed_at = ?,
      archive_state = CASE WHEN archive_state IN ('legacy_unknown','incomplete') THEN archive_state ELSE ? END
      WHERE id = ?`).run(new Date(result.finishedAt).toISOString(), result.archiveState ?? 'complete', runId);
  }

  cancel(id: string, now: number): ManagedTask | null {
    return taskTransaction(this.db, () => {
      const time = new Date(now).toISOString();
      const row = this.db.prepare(`UPDATE tasks SET status = 'cancelled', finished_at = ?
        WHERE id = ? AND status IN ('pending','running') RETURNING *`).get(time, id);
      if (!row) return null;
      this.db.prepare(`UPDATE task_runs SET status = 'cancelled', finished_at = ?
        WHERE id = ? AND closed_at IS NULL`).run(time, row.current_run_id);
      return decode(row);
    });
  }

  remove(id: string): boolean {
    return this.db.prepare(`DELETE FROM tasks WHERE id = ? AND status != 'running'
      AND NOT EXISTS (SELECT 1 FROM task_runs WHERE task_id = tasks.id AND closed_at IS NULL)`).run(id).changes > 0;
  }

  recoverInterrupted(now: number): void {
    taskTransaction(this.db, () => {
      const time = new Date(now).toISOString();
      this.db.prepare(`UPDATE tasks SET status = 'failed', finished_at = ?, error = 'Execution interrupted by server restart'
        WHERE status = 'running'`).run(time);
      this.db.prepare(`UPDATE task_runs SET status = (SELECT status FROM tasks WHERE id = task_id),
        finished_at = (SELECT finished_at FROM tasks WHERE id = task_id), error = (SELECT error FROM tasks WHERE id = task_id),
        closed_at = ?, archive_state = CASE WHEN archive_state = 'legacy_unknown' THEN archive_state ELSE 'incomplete' END
        WHERE closed_at IS NULL`).run(time);
    });
  }

  close(): void { this.db.close(); }
}
