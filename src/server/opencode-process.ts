import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export interface ProcessTreeAdapter {
  readonly platform: NodeJS.Platform;
  readonly killGroup: (pid: number, signal: NodeJS.Signals | 0) => void;
  readonly taskkill: (pid: number) => Promise<void>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly waitForClose: (child: ChildProcess, milliseconds: number, closed: Promise<void>) => Promise<boolean>;
}

const systemAdapter: ProcessTreeAdapter = {
  platform: process.platform,
  killGroup: (pid, signal) => { process.kill(pid, signal); },
  taskkill: (pid) => new Promise<void>((resolve, reject) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      shell: false, windowsHide: true, timeout: 3000, killSignal: 'SIGKILL',
    }, (error) =>
      error ? reject(error) : resolve());
  }),
  sleep: (milliseconds) => delay(milliseconds),
  waitForClose: async (_child, milliseconds, closed) => {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); });
    const result = await Promise.race([closed.then(() => true), timedOut]);
    clearTimeout(timer);
    return result;
  },
};

export async function terminateProcessTree(
  child: ChildProcess,
  adapter: ProcessTreeAdapter = systemAdapter,
  graceMs = 3000,
  closeEvent?: Promise<void>,
): Promise<string> {
  if (!child.pid) return '';
  const closed = closeEvent ?? new Promise<void>((resolve) => child.once('close', resolve));
  if (adapter.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) {
      if (await adapter.waitForClose(child, graceMs, closed)) return '';
      abandon(child);
      return 'Process exited but stdio did not close';
    }
    try {
      await adapter.taskkill(child.pid);
    } catch (error) {
      const reason = `taskkill failed: ${error instanceof Error ? error.message : String(error)}`;
      try { child.kill('SIGKILL'); } catch (killError) {
        return `${reason}; direct child kill failed: ${killError instanceof Error ? killError.message : String(killError)}`;
      }
      const didClose = await adapter.waitForClose(child, graceMs, closed);
      if (!didClose) abandon(child);
      return didClose ? reason : `${reason}; process did not close after direct kill`;
    }
    if (await adapter.waitForClose(child, graceMs, closed)) return '';
    try { child.kill('SIGKILL'); } catch (error) { return `Taskkill completed but child close timed out; direct child kill failed: ${error instanceof Error ? error.message : String(error)}`; }
    const didClose = await adapter.waitForClose(child, graceMs, closed);
    if (!didClose) abandon(child);
    return didClose ? '' : 'Taskkill completed but process did not close';
  }

  const errors: string[] = [];
  const pid = child.pid;
  try { adapter.killGroup(-pid, 'SIGTERM'); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const parentClosed = await adapter.waitForClose(child, graceMs, closed);
  if (parentClosed) {
    try {
      adapter.killGroup(-pid, 0);
      await adapter.sleep(graceMs);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return errors.join('; ');
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try { adapter.killGroup(-pid, 'SIGKILL'); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!parentClosed && !await adapter.waitForClose(child, graceMs, closed)) {
    abandon(child);
    errors.push('Process did not close after SIGKILL');
  }
  return errors.join('; ');
}

function abandon(child: ChildProcess): void {
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}
