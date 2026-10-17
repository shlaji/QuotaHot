import { spawn, type ChildProcess } from 'node:child_process';
import type { CreateTaskInput, TaskOutputChunk } from '../shared/tasks.js';
import type { TaskOutcome } from './task-store.js';
import { boundedText, TaskOutput } from './task-output.js';
import { TaskOutputLines } from './task-output-lines.js';
import { terminateProcessTree } from './opencode-process.js';
import {
  createEnvironment,
  errorText,
  reserveLoopbackPort,
  rootSessionId,
  jsonObject,
  requestUrl,
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
  readonly onOutputChunk?: (chunk: Buffer, stream: TaskOutputChunk['stream']) => void;
  readonly onOutput?: TaskOutputCallback;
  readonly onSession?: (sessionId: string) => void;
  readonly onSessionTitle?: (sessionId: string, title: string) => void;
  readonly sessionId?: string;
  readonly prompt?: string;
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
  private readonly archiveAbort = new AbortController();
  private readonly signal: AbortSignal;
  private archiveError = '';
  private published = '';
  private processError = '';
  private serverError = '';
  private serverClosed = false;
  private stopping = false;
  private rootClosed = false;
  private rootExitCode: number | null = null;
  private rootExitSignal: NodeJS.Signals | null = null;
  private rootId: string | null = null;
  private sessionReported = false;
  private base = '';
  private readonly rootOutputLines = new TaskOutputLines();

  constructor(private readonly task: CreateTaskInput, private readonly cancellationSignal: AbortSignal, private readonly options: TaskRunnerOptions) {
    this.signal = AbortSignal.any([cancellationSignal, this.archiveAbort.signal]);
    this.fetcher = options.fetch ?? fetch;
    this.spawnProcess = options.spawn ?? spawn;
    this.sleep = options.sleep ?? waitFor;
    this.rootId = options.sessionId ?? null;
    this.env = createEnvironment(task, options.env, options.proxy?.trim() ?? '', options.noProxy ?? []);
  }

  async run(): Promise<TaskOutcome> {
    if (this.signal.aborted) return { status: 'failed', output: '', error: 'Execution cancelled', archiveState: 'complete' };
    let error = '';
    try {
      const port = await (this.options.reservePort ?? reserveLoopbackPort)();
      this.base = `http://127.0.0.1:${port}`;
      this.start(['serve', '--hostname', '127.0.0.1', '--port', String(port)], true);
      await this.waitForHealth(this.base);
      const root = this.start([
        'run', '--attach', this.base, '--format', 'json', '--model', this.task.model, '--dir', this.task.directory,
        ...(this.options.sessionId === undefined ? [] : ['--session', this.options.sessionId]),
        '--', this.options.prompt ?? this.task.description,
      ], true);
      await this.waitForRoot(root);
      if (!this.rootId || !this.sessionReported) throw new Error('OpenCode run did not report a root session ID');
      error = await this.sessionTree(this.base).wait(this.rootId, this.rootExitCode, this.rootExitSignal);
      if (!error && !this.signal.aborted) await this.publishSessionTitle(this.rootId);
    } catch (cause) {
      error = errorText(cause);
      if (this.rootId && this.base) {
        try { await this.sessionTree(this.base).abort(this.rootId); }
        catch (abortError) { this.processError ||= errorText(abortError); }
      }
    }
    this.stopping = true;
    try { await this.stopProcesses(); }
    catch (cleanupError) {
      this.processError ||= errorText(cleanupError);
      if (!this.rootClosed) this.failArchive(cleanupError);
    }
    if (this.cancellationSignal.aborted) error = `Execution cancelled${this.processError ? `: ${this.processError}` : ''}`;
    else if (this.processError || this.serverError) error ||= this.processError || this.serverError;
    else if (this.rootExitCode !== 0) error ||= `OpenCode exited with ${this.rootExitSignal ?? this.rootExitCode}`;
    return this.finish(error);
  }

  private finish(error: string): TaskOutcome {
    const captured = this.output.finish();
    this.publish(captured);
    const finalError = boundedText(this.archiveError || error || this.processError || this.output.error);
    return {
      status: finalError ? 'failed' : 'succeeded', output: captured, error: finalError,
      archiveState: this.archiveError ? 'incomplete' : 'complete',
    };
  }

  private async publishSessionTitle(sessionId: string): Promise<void> {
    try {
      const response = await this.fetcher(requestUrl(this.base, `/session/${encodeURIComponent(sessionId)}`, this.task.directory), {
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(3000)]),
      });
      if (!response.ok) return;
      const session = jsonObject(await response.json());
      if (session?.id !== sessionId || (session.parentID != null && session.parentID !== '')
        || typeof session.title !== 'string') return;
      const title = session.title.trim();
      if (!title || /^(?:untitled|new session|child session)(?: - \d{4}-\d{2}-\d{2}T.*)?$/i.test(title)) return;
      if (!this.signal.aborted) this.options.onSessionTitle?.(sessionId, title);
    } catch {
      return;
    }
  }

  private start(args: readonly string[], detached: boolean): ChildProcess {
    const child = this.spawnProcess(this.options.executable ?? 'opencode', [...args], {
      cwd: this.task.directory, env: this.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached,
    });
    this.processes.push(child);
    this.closeEvents.set(child, new Promise<void>((resolve) => child.once('close', resolve)));
    child.stdout?.on('data', (chunk: Buffer) => {
      if (args[0] === 'run') this.capture(chunk, 'stdout');
    });
    child.stderr?.on('data', (chunk: Buffer) => { if (args[0] === 'run') this.capture(chunk, 'stderr'); });
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('error', (error: Error) => { if (args[0] === 'run') this.failArchive(error); });
    }
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

  private capture(chunk: Buffer, stream: TaskOutputChunk['stream']): void {
    try { this.options.onOutputChunk?.(chunk, stream); }
    catch (error) { this.failArchive(error); }
    this.output.append(chunk, stream === 'stdout');
    if (stream === 'stdout') this.parseRoot(chunk);
  }

  private failArchive(error: unknown): void {
    this.archiveError ||= `Task output archive failed: ${errorText(error)}`;
    this.archiveAbort.abort();
  }

  private parseRoot(chunk: Buffer): void {
    this.rootOutputLines.append(chunk, (line) => {
      if (!line.trim()) return;
      try {
        const id = rootSessionId(JSON.parse(line));
        if (id && !this.sessionReported) {
          this.sessionReported = true;
          if (this.rootId !== null && this.rootId !== id) {
            this.processError = 'OpenCode run reported a different session than requested';
          } else {
            this.rootId = id;
            this.options.onSession?.(id);
          }
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) this.processError = errorText(error);
      }
    });
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
    this.parseRoot(Buffer.from('\n'));
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
    if (error) {
      this.processError ||= error;
      if (!this.rootClosed) this.failArchive(error);
    }
  }
}

export async function runTask(task: CreateTaskInput, signal: AbortSignal, options: TaskRunnerOptions = {}): Promise<TaskOutcome> {
  return new OpenCodeTaskRuntime(task, signal, options).run();
}
