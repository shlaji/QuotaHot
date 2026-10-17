import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import type { TaskSessionTranscript } from '../shared/tasks.js';
import { terminateProcessTree } from './opencode-process.js';
import { parseSessionExport, SessionExportError } from './opencode-export-payload.js';

export interface SessionExportSource {
  readonly sessionId: string;
  readonly directory: string;
}

export interface SessionExportOptions {
  readonly executable?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly killGraceMs?: number;
}

export type SessionExporter = (source: SessionExportSource) => Promise<TaskSessionTranscript>;

export async function exportSession(source: SessionExportSource, options: SessionExportOptions = {}): Promise<TaskSessionTranscript> {
  if (!source.sessionId || source.sessionId.startsWith('-') || source.sessionId.includes('\0')) {
    throw new SessionExportError('session_unavailable', 'Stored OpenCode session ID is invalid');
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let failure: SessionExportError | undefined;
  const child = spawn(options.executable ?? 'opencode', ['export', source.sessionId], {
    cwd: source.directory, env: { ...process.env, ...options.env, PWD: source.directory },
    shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let stop: Promise<string> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const payload = await new Promise<string>((resolve, reject) => {
    const fail = (error: SessionExportError) => {
      if (failure) return;
      failure = error;
      clearTimeout(timer);
      stop = terminateProcessTree(child, undefined, options.killGraceMs ?? 250, closed);
      reject(error);
    };
    timer = setTimeout(() => fail(new SessionExportError('timeout', 'OpenCode session export timed out')), options.timeoutMs ?? 15000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > (options.maxStdoutBytes ?? 4 * 1024 * 1024)) {
        fail(new SessionExportError('limit_exceeded', 'OpenCode session stdout exceeded its byte limit'));
      } else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (failure) return;
      stderrBytes += chunk.length;
      if (stderrBytes > (options.maxStderrBytes ?? 64 * 1024)) {
        fail(new SessionExportError('limit_exceeded', 'OpenCode session stderr exceeded its byte limit'));
      } else stderr.push(chunk);
    });
    child.on('error', () => fail(new SessionExportError('cli_unavailable', 'Cannot start OpenCode session export; check executable and task directory')));
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('error', () => fail(new SessionExportError('export_failed', 'Cannot read OpenCode session export')));
    }
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure) return;
      const diagnostic = stripVTControlCharacters(Buffer.concat(stderr).toString('utf8'));
      if (/session[^\n]*(?:not found|does not exist)|not found[^\n]*session/i.test(diagnostic)) {
        reject(new SessionExportError('session_unavailable', 'Stored session is unavailable in OpenCode'));
      } else if (code !== 0) {
        reject(new SessionExportError('export_failed', 'OpenCode session export failed'));
      } else {
        try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout))); }
        catch (error) {
          if (error instanceof TypeError) reject(new SessionExportError('invalid_output', 'OpenCode export is not valid UTF-8'));
          else reject(error);
        }
      }
    });
  }).finally(async () => {
    clearTimeout(timer);
    if (stop) await stop;
  });
  return parseSessionExport(payload, source.sessionId);
}
