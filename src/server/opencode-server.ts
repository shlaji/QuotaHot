import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { errorText, jsonObject } from './opencode-runtime-support.js';
import type { Fetcher } from './opencode-session-tree.js';

type ServerOptions = {
  readonly executable: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  readonly fetch: Fetcher;
};

export class OpenCodeServer {
  private pending: Promise<string> | undefined;

  constructor(private readonly port = 4096, private readonly readinessTimeoutMs = 15_000) {}

  async ensure(options: ServerOptions, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const pending = this.pending ??= this.ready(options).finally(() => { this.pending = undefined; });
    let onAbort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('Execution cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([pending, cancelled]); }
    finally { signal.removeEventListener('abort', onAbort); }
  }

  private async ready(options: ServerOptions): Promise<string> {
    const base = `http://127.0.0.1:${this.port}`;
    const deadline = AbortSignal.timeout(this.readinessTimeoutMs);
    try {
      if (await this.healthy(base, options.fetch, deadline)) return base;
      const child = options.spawn(options.executable, ['serve', '--hostname', '127.0.0.1', '--port', String(this.port)], {
        cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: 'ignore',
      });
      let processError = '';
      child.on('error', (error) => { processError = error.message; });
      child.on('exit', (code, signal) => { processError ||= `OpenCode serve exited with ${signal ?? code}`; });
      child.unref();
      while (!deadline.aborted) {
        if (await this.healthy(base, options.fetch, deadline)) return base;
        if (processError) throw new Error(`${processError}; no healthy OpenCode service at ${base}`);
        await delay(100, undefined, { signal: deadline });
      }
      throw new Error(`Timed out waiting for OpenCode service at ${base}`);
    } catch (error) {
      if (deadline.aborted) throw new Error(`Timed out waiting for OpenCode service at ${base}`);
      throw error;
    }
  }

  private async healthy(base: string, fetcher: Fetcher, deadline: AbortSignal): Promise<boolean> {
    let response: Response;
    try {
      response = await fetcher(`${base}/global/health`, {
        signal: AbortSignal.any([deadline, AbortSignal.timeout(1000)]), redirect: 'error',
      });
    } catch (error) {
      if (error instanceof TypeError && jsonObject(error.cause)?.code === 'ECONNREFUSED') return false;
      throw new Error(`Cannot verify a healthy OpenCode service at ${base}: ${errorText(error)}`);
    }
    try {
      if (!response.ok) await response.body?.cancel();
      const health = response.ok ? jsonObject(await response.json()) : null;
      if (health?.healthy === true && typeof health.version === 'string') return true;
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw new Error(`Cannot verify a healthy OpenCode service at ${base}: ${errorText(error)}`);
      }
    }
    throw new Error(`Listener at ${base} is not a healthy OpenCode service`);
  }
}

export const sharedOpenCodeServer = new OpenCodeServer();
