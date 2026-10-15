import { homedir } from 'node:os';
import type { CreateTaskInput, ManagedTask, TaskListResponse } from '../shared/tasks.js';
import type { UsageResult } from '../shared/types.js';
import { TaskStore, type TaskOutcome } from './task-store.js';
import { runTask, type TaskOutputCallback } from './task-runner.js';
import { hasTaskQuota } from './task-quota.js';
import { TaskError } from './task-error.js';

interface TaskSchedulerOptions {
  readonly now?: () => number;
  readonly quota: () => Promise<readonly UsageResult[]>;
  readonly run?: (task: CreateTaskInput, signal: AbortSignal, onOutput?: TaskOutputCallback) => Promise<TaskOutcome>;
  readonly proxy?: () => string;
  readonly noProxy?: () => readonly string[];
}

export class TaskScheduler {
  private readonly now: () => number;
  private readonly run: NonNullable<TaskSchedulerOptions['run']>;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private active: { readonly id: string; readonly controller: AbortController; readonly promise: Promise<void> } | null = null;
  private quotaCheck: Promise<void> | null = null;
  private quotaResults: readonly UsageResult[] = [];
  private quotaCheckedAt = -Infinity;
  private nextQuotaCheck = -Infinity;

  constructor(private readonly store: TaskStore, private readonly options: TaskSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.run = options.run ?? ((task, signal, onOutput) => runTask(task, signal, {
      onOutput, proxy: options.proxy?.(), noProxy: options.noProxy?.(),
    }));
    this.store.recoverInterrupted(this.now());
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 500);
    this.timer.unref();
  }

  list(): TaskListResponse { return { tasks: this.store.list(), defaultDirectory: homedir() }; }

  create(input: CreateTaskInput): ManagedTask {
    if (this.stopped) throw new TaskError('Task service is stopping', 503);
    return this.store.create(input, this.now());
  }

  async cancel(id: string): Promise<ManagedTask> {
    const task = this.store.get(id);
    if (!task) throw new TaskError('Task not found', 404);
    const cancelled = this.store.cancel(id, this.now());
    if (!cancelled) {
      if (task.status === 'cancelled') return task;
      throw new TaskError('Only pending or running tasks can be cancelled', 409);
    }
    if (this.active?.id === id) {
      const active = this.active;
      active.controller.abort();
      await active.promise;
      return this.store.get(id) ?? cancelled;
    }
    return cancelled;
  }

  remove(id: string): void {
    if (!this.store.get(id)) throw new TaskError('Task not found', 404);
    if (this.active?.id === id || !this.store.remove(id)) throw new TaskError('Running tasks cannot be deleted', 409);
  }

  tick(): void {
    if (this.stopped) return;
    const now = this.now();
    const pending = this.store.list().filter((task) => task.status === 'pending');
    if (pending.some((task) => task.trigger.type === 'quota') && !this.quotaCheck && now >= this.nextQuotaCheck) {
      this.nextQuotaCheck = now + 60_000;
      this.quotaCheck = this.checkQuota(now).finally(() => { this.quotaCheck = null; });
    }
    if (this.active) return;
    const ready = pending.find((task) => {
      switch (task.trigger.type) {
        case 'time': return task.trigger.at <= now;
        case 'quota': return now >= this.quotaCheckedAt && now - this.quotaCheckedAt < 60_000
          && this.quotaResults.some((result) => hasTaskQuota(result, task.model, now));
      }
    });
    if (!ready) return;
    const claimed = this.store.claim(ready.id, now);
    if (!claimed) return;
    const controller = new AbortController();
    const promise = this.execute(claimed, controller.signal).finally(() => { this.active = null; });
    this.active = { id: claimed.id, controller, promise };
  }

  private async checkQuota(startedAt: number): Promise<void> {
    try {
      const results = await this.options.quota();
      if (!this.stopped) {
        this.quotaResults = results;
        this.quotaCheckedAt = startedAt;
      }
    } catch (error) {
      this.quotaResults = [];
      console.error('Task quota refresh failed:', error instanceof Error ? error.message : String(error));
    }
  }

  private async execute(task: ManagedTask, signal: AbortSignal): Promise<void> {
    let result: TaskOutcome;
    let output = '';
    try {
      result = await this.run(task, signal, (captured) => {
        output = captured;
        this.store.updateOutput(task.id, captured);
      });
    } catch (error) {
      result = { status: 'failed', output, error: error instanceof Error ? error.message : String(error) };
    }
    this.store.finish(task.id, result, this.now());
  }

  async settled(): Promise<void> {
    await Promise.all([this.quotaCheck, this.active?.promise]);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.active?.controller.abort();
    await this.settled();
  }
}
