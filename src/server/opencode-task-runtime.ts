import { spawn, type ChildProcess } from 'node:child_process';
import type { CreateTaskInput } from '../shared/tasks.js';
import type { TaskOutcome } from './task-store.js';
import { boundedText, TaskOutput } from './task-output.js';
import { terminateProcessTree } from './opencode-process.js';
import {
  createEnvironment,
  errorText,
  reserveLoopbackPort,
  rootSessionId,
  waitFor,
} from './opencode-runtime-support.js';
import { OpenCodeSessionTree, type Fetcher, type SessionSleep } from './opencode-session-tree.js';

export type TaskOutputCallback = (output: string) => void;
type SpawnProcess = typeof spawn;

type RuntimeDependencies = {
  readonly fetch?: Fetcher;
  readonly spawn?: SpawnProcess;
  readonly reservePort?: () => Promise<number>;
  readonly sleep?: SessionSleep;
  readonly abortTreeTimeoutMs?: number;
};

export interface TaskRunnerOptions extends RuntimeDependencies {
  readonly executable?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly killGraceMs?: number;
  readonly onOutput?: TaskOutputCallback;
  readonly proxy?: string;
  readonly noProxy?: readonly string[];
}

const POLL_MS = 500;

export class OpenCodeTaskRuntime {
  private readonly fetcher: Fetcher;
  private readonly spawnProcess: SpawnProcess;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly output = new TaskOutput();
  private readonly env: NodeJS.ProcessEnv;
  private readonly processes: ChildProcess[] = [];
  private readonly closeEvents = new Map<ChildProcess, Promise<void>>();
  private published = '';
  private processError = '';
  private serverError = '';
  private serverClosed = false;
  private stopping = false;
  private rootClosed = false;
  private rootExitCode: number | null = null;
  private rootExitSignal: NodeJS.Signals | null = null;
  private rootId: string | null = null;
  private base = '';
  private rootOutputLine = '';

  constructor(private readonly task: CreateTaskInput, private readonly signal: AbortSignal, private readonly options: TaskRunnerOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.spawnProcess = options.spawn ?? spawn;
    this.sleep = options.sleep ?? waitFor;
    this.env = createEnvironment(task, options.env, options.proxy?.trim() ?? '', options.noProxy ?? []);
  }

  async run(): Promise<TaskOutcome> {
    if (this.signal.aborted) return { status: 'failed', output: '', error: 'Execution cancelled' };
    let error = '';
    try {
      const port = await (this.options.reservePort ?? reserveLoopbackPort)();
      this.base = `http://127.0.0.1:${port}`;
      this.start(['serve', '--hostname', '127.0.0.1', '--port', String(port)], true);
      await this.waitForHealth(this.base);
      const root = this.start(['run', '--attach', this.base, '--format', 'json', '--model', this.task.model, '--dir', this.task.directory, '--', this.task.description], true);
      await this.waitForRoot(root);
      if (!this.rootId) throw new Error('OpenCode run did not report a root session ID');
      error = await this.sessionTree(this.base).wait(this.rootId, this.rootExitCode, this.rootExitSignal);
    } catch (cause) {
      error = errorText(cause);
      if (this.rootId && this.base) {
        try { await this.sessionTree(this.base).abort(this.rootId); }
        catch (abortError) { this.processError ||= errorText(abortError); }
      }
    }
    this.stopping = true;
    try { await this.stopProcesses(); }
    catch (cleanupError) { this.processError ||= errorText(cleanupError); }
    if (this.signal.aborted) error = `Execution cancelled${this.processError ? `: ${this.processError}` : ''}`;
    else if (this.processError || this.serverError) error ||= this.processError || this.serverError;
    else if (this.rootExitCode !== 0) error ||= `OpenCode exited with ${this.rootExitSignal ?? this.rootExitCode}`;
    return this.finish(error);
  }

  private finish(error: string): TaskOutcome {
    const captured = this.output.finish();
    this.publish(captured);
    const finalError = boundedText(error || this.output.error);
    return { status: finalError ? 'failed' : 'succeeded', output: captured, error: finalError };
  }

  private start(args: readonly string[], detached: boolean): ChildProcess {
    const child = this.spawnProcess(this.options.executable ?? 'opencode', [...args], {
      cwd: this.task.directory, env: this.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached,
    });
    this.processes.push(child);
    this.closeEvents.set(child, new Promise<void>((resolve) => child.once('close', resolve)));
    child.stdout?.on('data', (chunk: Buffer) => {
      if (args[0] === 'run') {
        this.output.append(chunk, true);
        this.parseRoot(chunk);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => { if (args[0] === 'run') this.output.append(chunk, false); });
    child.on('error', (error) => {
      if (args[0] === 'run') this.processError = error.message;
      else this.serverError = error.message;
    });
    child.on('close', (code, signal) => {
      if (args[0] === 'run') {
        this.rootClosed = true;
        this.rootExitCode = code;
        this.rootExitSignal = signal;
      } else {
        this.serverClosed = true;
        if (!this.stopping && !this.signal.aborted && code !== 0) this.serverError = `OpenCode serve exited with ${signal ?? code}`;
      }
    });
    return child;
  }

  private parseRoot(chunk: Buffer): void {
    const lines = (this.rootOutputLine + chunk.toString('utf8')).split('\n');
    this.rootOutputLine = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const id = rootSessionId(JSON.parse(line));
        if (id) this.rootId ??= id;
      } catch (error) {
        if (!(error instanceof SyntaxError)) this.processError = errorText(error);
      }
    }
  }

  private publish(captured: string): void {
    if (captured === this.published) return;
    try { this.options.onOutput?.(captured); this.published = captured; }
    catch (error) { this.processError = `Task output update failed: ${errorText(error)}`; }
  }

  private async waitForHealth(base: string): Promise<void> {
    while (!this.signal.aborted) {
      if (this.serverClosed) throw new Error(this.serverError || 'OpenCode serve exited before becoming ready');
      try {
        const response = await this.fetcher(`${base}/global/health`, { signal: this.signal });
        if (response.ok) return;
      } catch (error) {
        if (this.signal.aborted) throw error;
        if (!(error instanceof TypeError)) throw error;
      }
      await this.sleep(POLL_MS, this.signal);
    }
    throw new Error('Execution cancelled');
  }

  private async waitForRoot(root: ChildProcess): Promise<void> {
    while (!this.rootClosed && !this.signal.aborted) {
      this.publish(this.output.snapshot());
      await this.sleep(POLL_MS, this.signal);
    }
    if (this.signal.aborted) throw new Error('Execution cancelled');
    if (this.processError) throw new Error(this.processError);
    if (!root.pid) throw new Error('OpenCode run did not start');
  }

  private sessionTree(base: string): OpenCodeSessionTree {
    return new OpenCodeSessionTree(
      base, this.task.directory, this.fetcher, this.signal, this.sleep, this.options.abortTreeTimeoutMs,
    );
  }

  private async stopProcesses(): Promise<void> {
    for (const child of [...this.processes].reverse()) await this.terminate(child);
  }

  private async terminate(child: ChildProcess): Promise<void> {
    const error = await terminateProcessTree(child, undefined, this.options.killGraceMs ?? 3000, this.closeEvents.get(child));
    if (error) this.processError ||= error;
  }
}

export async function runTask(task: CreateTaskInput, signal: AbortSignal, options: TaskRunnerOptions = {}): Promise<TaskOutcome> {
  return new OpenCodeTaskRuntime(task, signal, options).run();
}
