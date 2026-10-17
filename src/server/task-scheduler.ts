import { homedir } from 'node:os';
import type { CreateTaskInput, ManagedTask, TaskListResponse } from '../shared/tasks.js';
import type { UsageResult } from '../shared/types.js';
import { TaskStore, type TaskOutcome } from './task-store.js';
import { runTask, type TaskRunnerOptions } from './task-runner.js';
import { hasTaskQuota } from './task-quota.js';
import { TaskError } from './task-error.js';

interface TaskSchedulerOptions {
  readonly now?: () => number;
  readonly quota: () => Promise<readonly UsageResult[]>;
  readonly run?: (task: CreateTaskInput, signal: AbortSignal, options: TaskRunnerOptions) => Promise<TaskOutcome>;
  readonly proxy?: () => string;
  readonly noProxy?: () => readonly string[];
}

export class TaskScheduler {
  private readonly now: () => number;
  private readonly run: NonNullable<TaskSchedulerOptions['run']>;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly active = new Map<string, { readonly controller: AbortController; readonly promise: Promise<void> }>();
  private quotaCheck: Promise<void> | null = null;
  private quotaResults: readonly UsageResult[] = [];
  private quotaCheckedAt = -Infinity;
  private nextQuotaCheck = -Infinity;

  constructor(private readonly store: TaskStore, private readonly options: TaskSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.run = options.run ?? ((task, signal, execution) => runTask(task, signal, {
      ...execution, proxy: options.proxy?.(), noProxy: options.noProxy?.(),
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
    if (!cancelled && task.status !== 'cancelled') {
      throw new TaskError('Only pending or running tasks can be cancelled', 409);
    }
    const active = this.active.get(id);
    if (active) {
      active.controller.abort();
      await active.promise;
      return this.store.get(id) ?? cancelled ?? task;
    }
    return cancelled ?? task;
  }

  continueTask(id: string, message: string): ManagedTask {
    if (!this.store.get(id)) throw new TaskError('Task not found', 404);
    if (this.stopped || this.active.has(id)) throw new TaskError('Task service is busy or stopping', 409);
    const task = this.store.claimContinuation(id, this.now());
    if (!task || task.sessionId === null) throw new TaskError('Only succeeded tasks with a session can continue while idle', 409);
    this.launch(task, { sessionId: task.sessionId, prompt: message });
    return task;
  }

  remove(id: string): void {
    if (!this.store.get(id)) throw new TaskError('Task not found', 404);
    if (this.active.has(id) || !this.store.remove(id)) throw new TaskError('Running tasks cannot be deleted', 409);
  }

  tick(): void {
    if (this.stopped) return;
    const now = this.now();
    const pending = this.store.list().filter((task) => task.status === 'pending');
    if (pending.some((task) => task.trigger.type === 'quota') && !this.quotaCheck && now >= this.nextQuotaCheck) {
      this.nextQuotaCheck = now + 60_000;
      this.quotaCheck = this.checkQuota(now).finally(() => { this.quotaCheck = null; });
    }
    const ready = pending.filter((task) => {
      switch (task.trigger.type) {
        case 'time': return task.trigger.at <= now;
        case 'quota': return now >= this.quotaCheckedAt && now - this.quotaCheckedAt < 60_000
          && this.quotaResults.some((result) => hasTaskQuota(result, task.model, now));
      }
    });
    for (const task of ready) {
      if (this.stopped) break;
      if (this.active.has(task.id)) continue;
      const claimed = this.store.claim(task.id, now);
      if (claimed) this.launch(claimed);
    }
  }

  private launch(task: ManagedTask, options: TaskRunnerOptions = {}): void {
    const controller = new AbortController();
    const promise = this.execute(task, controller.signal, options).finally(() => { this.active.delete(task.id); });
    this.active.set(task.id, { controller, promise });
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

  private async execute(task: ManagedTask, signal: AbortSignal, options: TaskRunnerOptions): Promise<void> {
    let result: TaskOutcome;
    let output = '';
    try {
      result = await this.run(task, signal, {
        ...options,
        onSession: (sessionId) => this.store.setSession(task.id, sessionId),
        onOutput: (captured) => {
          output = captured;
          this.store.updateOutput(task.id, captured);
        },
      });
    } catch (error) {
      result = { status: 'failed', output, error: error instanceof Error ? error.message : String(error) };
    }
    this.store.finish(task.id, result, this.now());
  }

  async settled(): Promise<void> {
    while (this.quotaCheck || this.active.size) {
      const results = await Promise.allSettled([this.quotaCheck, ...Array.from(this.active.values(), (execution) => execution.promise)]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    for (const execution of this.active.values()) execution.controller.abort();
    await this.settled();
  }
}
