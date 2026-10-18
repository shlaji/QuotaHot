import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  let directory: string | undefined;
  let output: FileHandle | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'quotahot-export-'));
    const path = join(directory, 'stdout');
    output = await open(path, 'wx', 0o600);
    const stdout = output;
    const maxStdoutBytes = options.maxStdoutBytes ?? 4 * 1024 * 1024;
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let failure: SessionExportError | undefined;
    const child = spawn(options.executable ?? 'opencode', ['export', source.sessionId], {
      cwd: source.directory, env: { ...process.env, ...options.env, PWD: source.directory },
      shell: false, detached: true, windowsHide: true, stdio: ['ignore', stdout.fd, 'pipe'],
    });
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    let stop: Promise<string> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let monitorTimer: NodeJS.Timeout | undefined;
    let monitorWork: Promise<void> | undefined;
    let monitoring = true;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: SessionExportError) => {
        if (failure) return;
        failure = error;
        clearTimeout(timer);
        stop = terminateProcessTree(child, undefined, options.killGraceMs ?? 250, closed);
        reject(error);
      };
      timer = setTimeout(() => fail(new SessionExportError('timeout', 'OpenCode session export timed out')), options.timeoutMs ?? 15000);
      const monitor = () => {
        monitorTimer = setTimeout(() => {
          monitorWork = stdout.stat().then((status) => {
            if (status.size > maxStdoutBytes) {
              fail(new SessionExportError('limit_exceeded', 'OpenCode session stdout exceeded its byte limit'));
            }
          }, () => fail(new SessionExportError('export_failed', 'Cannot inspect OpenCode session export')))
            .then(() => { if (monitoring && !failure) monitor(); });
        }, 25);
      };
      monitor();
      child.stderr?.on('data', (chunk: Buffer) => {
        if (failure) return;
        stderrBytes += chunk.length;
        if (stderrBytes > (options.maxStderrBytes ?? 64 * 1024)) {
          fail(new SessionExportError('limit_exceeded', 'OpenCode session stderr exceeded its byte limit'));
        } else stderr.push(chunk);
      });
      child.on('error', () => fail(new SessionExportError('cli_unavailable', 'Cannot start OpenCode session export; check executable and task directory')));
      child.stderr?.on('error', () => fail(new SessionExportError('export_failed', 'Cannot read OpenCode session export')));
      child.once('close', (code) => {
        clearTimeout(timer);
        if (failure) return;
        const diagnostic = stripVTControlCharacters(Buffer.concat(stderr).toString('utf8'));
        if (/session[^\n]*(?:not found|does not exist)|not found[^\n]*session/i.test(diagnostic)) {
          reject(new SessionExportError('session_unavailable', 'Stored session is unavailable in OpenCode'));
        } else if (code !== 0) {
          reject(new SessionExportError('export_failed', 'OpenCode session export failed'));
        } else {
          resolve();
        }
      });
    }).finally(async () => {
      clearTimeout(timer);
      monitoring = false;
      clearTimeout(monitorTimer);
      await monitorWork;
      if (stop) await stop;
    });
    if (failure) throw failure;
    if ((await stdout.stat()).size > maxStdoutBytes) {
      throw new SessionExportError('limit_exceeded', 'OpenCode session stdout exceeded its byte limit');
    }
    const bytes = await readFile(path);
    let payload: string;
    try { payload = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (error) {
      if (error instanceof TypeError) throw new SessionExportError('invalid_output', 'OpenCode export is not valid UTF-8');
      throw error;
    }
    return parseSessionExport(payload, source.sessionId);
  } catch (error) {
    if (error instanceof SessionExportError) throw error;
    throw new SessionExportError('export_failed', 'Cannot access OpenCode session export temporary file');
  } finally {
    try {
      try { await output?.close(); }
      finally { if (directory) await rm(directory, { recursive: true, force: true }); }
    } catch {
      throw new SessionExportError('export_failed', 'Cannot clean up OpenCode session export temporary file');
    }
  }
}
