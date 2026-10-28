import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { Lines, parseExitReason, parseJson, parseReady, safeOsCode } from './protocol.js';
import type { ExitReason, JsonValue, ReadyInfo } from './protocol.js';
import { parseGroups, parsePeople } from './search.js';

export type { JsonValue, ReadyInfo } from './protocol.js';
export type DwsConfig = { readonly binary: string; readonly profile: string; readonly configDir: string };
export type DwsChild = EventEmitter & {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal: NodeJS.Signals): boolean;
};
export type DwsSpawn = (binary: string, args: readonly string[], options: {
  readonly shell: false;
  readonly stdio: ['pipe', 'pipe', 'pipe'];
  readonly env: NodeJS.ProcessEnv;
}) => DwsChild;
type Failure = 'process_error' | 'invalid_json' | 'callback_error' | 'stream_error';
export type ProcessExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly reason: ExitReason | null;
  readonly ready: ReadyInfo | null;
  readonly failure: Failure | null;
  readonly remoteCleanup: 'unknown';
  readonly diagnostics: { readonly stderrLines: number; readonly errorLines: number; readonly osCode: string | null };
};
export type Consumer = {
  readonly ready: Promise<ReadyInfo | null>;
  readonly exited: Promise<ProcessExit>;
  stop(method?: 'sigterm' | 'stdin'): Promise<ProcessExit>;
};

export class DwsProcessError extends Error {
  constructor(readonly kind: 'configuration' | 'arguments' | 'process_exit' | Failure, readonly exit: ProcessExit | null = null) {
    super(`DWS subprocess: ${kind}`);
    this.name = 'DwsProcessError';
  }
}

function deferred<Value>() {
  let resolve: (value: Value) => void = () => { throw new DwsProcessError('process_error'); };
  const promise = new Promise<Value>(complete => { resolve = complete; });
  return { promise, resolve };
}

export class DwsRunner {
  private readonly config: DwsConfig;
  constructor(config: DwsConfig, private readonly execute: DwsSpawn = spawn) {
    if (!config.binary.trim() || !config.profile.trim() || !config.configDir.trim()) throw new DwsProcessError('configuration');
    this.config = { ...config };
  }

  private launch(args: readonly string[]): DwsChild {
    if (args.some(arg => /^(--token|--profile|--quiet|--yes)(=|$)/.test(arg) || arg === '-q')) throw new DwsProcessError('arguments');
    const env: NodeJS.ProcessEnv = { DWS_CONFIG_DIR: this.config.configDir };
    for (const name of ['PATH', 'HOME', 'LANG', 'TMPDIR']) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    try {
      return this.execute(this.config.binary, ['--profile', this.config.profile, ...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new DwsProcessError('process_error');
    }
  }

  async runJson(args: readonly string[]): Promise<JsonValue> {
    const child = this.launch(args);
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    const process = this.observe(child, null, () => {});
    child.stdin.end();
    const exit = await process.exited;
    if (exit.failure || exit.code !== 0 || exit.signal !== null) throw new DwsProcessError(exit.failure ?? 'process_exit', exit);
    try {
      return parseJson(output);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new DwsProcessError('invalid_json', exit);
    }
  }

  async searchPeople(query: string) {
    return parsePeople(await this.runJson(['aisearch', 'person', '--query', query, '--dimension', 'name', '--format', 'json']));
  }

  async searchGroups(query: string) {
    return parseGroups(await this.runJson(['chat', '+chat-search', '--query', query, '--page-all', '--format', 'json']));
  }

  get profileKey(): string { return this.config.profile; }

  consume(args: readonly string[], expectedEventKey: string, onEvent: (event: JsonValue) => void): Consumer {
    const child = this.launch(args);
    return this.observe(child, expectedEventKey, onEvent);
  }

  private observe(child: DwsChild, expectedEventKey: string | null, onEvent: (event: JsonValue) => void): Consumer {
    let readyInfo: ReadyInfo | null = null;
    let reason: ExitReason | null = null;
    let failure: Failure | null = null;
    let stderrLines = 0;
    let errorLines = 0;
    let osCode: string | null = null;
    let closed = false;
    let stopping = false;
    const ready = deferred<ReadyInfo | null>();
    const exited = deferred<ProcessExit>();
    const stop = (method: 'sigterm' | 'stdin' = 'sigterm') => {
      if (!closed && !stopping) {
        stopping = true;
        if (method === 'stdin') child.stdin.end();
        else child.kill('SIGTERM');
      }
      return exited.promise;
    };
    const stderr = new Lines(line => {
      stderrLines++;
      if (line.startsWith('Error:')) errorLines++;
      const marker = parseReady(line);
      if (marker && marker.eventKey === expectedEventKey && readyInfo === null && !stopping) {
        readyInfo = marker;
        ready.resolve(marker);
      }
      reason = parseExitReason(line) ?? reason;
    });
    const stdout = new Lines(line => {
      if (failure || line.trim() === '') return;
      let event: JsonValue;
      try {
        event = parseJson(line);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        failure = 'invalid_json';
        void stop();
        return;
      }
      try {
        onEvent(event);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        failure = 'callback_error';
        void stop();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.write(chunk));
    if (expectedEventKey !== null) child.stdout.on('data', (chunk: Buffer) => stdout.write(chunk));
    child.on('error', (error: Error) => { failure = 'process_error'; osCode = safeOsCode(error); });
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on('error', (error: Error) => {
        failure = 'stream_error';
        osCode = safeOsCode(error);
        void stop();
      });
    }
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      stderr.end();
      if (expectedEventKey !== null) stdout.end();
      closed = true;
      ready.resolve(null);
      exited.resolve({ code, signal, reason, ready: readyInfo, failure, remoteCleanup: 'unknown', diagnostics: { stderrLines, errorLines, osCode } });
    });
    return { ready: ready.promise, exited: exited.promise, stop };
  }
}
