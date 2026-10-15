import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CreateTaskInput, ManagedTask, TaskTrigger } from '../shared/tasks.js';
import { boundedText } from './task-output.js';

export type TaskOutcome = Readonly<Pick<ManagedTask, 'output' | 'error'>> & {
  readonly status: 'succeeded' | 'failed';
};

function text(value: SQLOutputValue): string {
  if (typeof value !== 'string') throw new TypeError('Invalid task database text');
  return value;
}

function date(value: SQLOutputValue): number | null {
  return value === null ? null : Date.parse(text(value));
}

function decode(row: Record<string, SQLOutputValue>): ManagedTask {
  const status = row.status;
  if (status !== 'pending' && status !== 'running' && status !== 'succeeded'
    && status !== 'failed' && status !== 'cancelled') throw new TypeError('Invalid task status');
  let trigger: TaskTrigger;
  switch (row.trigger_type) {
    case 'quota': trigger = { type: 'quota' }; break;
    case 'time': trigger = { type: 'time', at: Date.parse(text(row.trigger_at)) }; break;
    default: throw new TypeError('Invalid task trigger');
  }
  return {
    id: text(row.id), description: text(row.description), model: text(row.model),
    directory: text(row.directory), trigger, status,
    createdAt: Date.parse(text(row.created_at)), startedAt: date(row.started_at),
    finishedAt: date(row.finished_at), output: text(row.output), error: text(row.error),
  };
}

export class TaskStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, description TEXT NOT NULL, model TEXT NOT NULL,
        directory TEXT NOT NULL, trigger_type TEXT NOT NULL CHECK(trigger_type IN ('quota','time')),
        trigger_at TEXT, status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled')),
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        output TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
    `);
  }

  create(input: CreateTaskInput, now: number): ManagedTask {
    const task: ManagedTask = {
      ...input, id: randomUUID(), status: 'pending', createdAt: now,
      startedAt: null, finishedAt: null, output: '', error: '',
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

  get(id: string): ManagedTask | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? decode(row) : null;
  }

  claim(id: string, now: number): ManagedTask | null {
    const row = this.db.prepare(`UPDATE tasks SET status = 'running', started_at = ?
      WHERE id = ? AND status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM tasks WHERE status = 'running') RETURNING *`)
      .get(new Date(now).toISOString(), id);
    return row ? decode(row) : null;
  }

  updateOutput(id: string, output: string): void {
    this.db.prepare(`UPDATE tasks SET output = ? WHERE id = ? AND status IN ('running','cancelled')`)
      .run(boundedText(output), id);
  }

  finish(id: string, result: TaskOutcome, now: number): void {
    this.db.prepare(`UPDATE tasks SET output = ?,
      status = CASE WHEN status = 'running' THEN ? ELSE status END,
      error = CASE WHEN status = 'running' THEN ? ELSE error END,
      finished_at = CASE WHEN status = 'running' THEN ? ELSE finished_at END
      WHERE id = ? AND status IN ('running','cancelled')`)
      .run(boundedText(result.output), result.status, result.error, new Date(now).toISOString(), id);
  }

  cancel(id: string, now: number): ManagedTask | null {
    const row = this.db.prepare(`UPDATE tasks SET status = 'cancelled', finished_at = ?
      WHERE id = ? AND status IN ('pending','running') RETURNING *`)
      .get(new Date(now).toISOString(), id);
    return row ? decode(row) : null;
  }

  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM tasks WHERE id = ? AND status != 'running'").run(id).changes > 0;
  }

  recoverInterrupted(now: number): void {
    this.db.prepare(`UPDATE tasks SET status = 'failed', finished_at = ?, error = 'Execution interrupted by server restart'
      WHERE status = 'running'`).run(new Date(now).toISOString());
  }

  close(): void { this.db.close(); }
}
