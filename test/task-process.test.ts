import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { terminateProcessTree, type ProcessTreeAdapter } from '../src/server/opencode-process.js';

function fakeChild(exitCode: number | null = null): ChildProcess {
  return Object.assign(new ChildProcess(), { pid: 12345, exitCode, signalCode: null });
}

test('terminates the entire POSIX process group after the grace period', async () => {
  const calls: string[] = [];
  const adapter: ProcessTreeAdapter = {
    platform: 'darwin',
    killGroup: (pid: number, signal: NodeJS.Signals | 0) => { calls.push(`${pid}:${signal}`); },
    taskkill: async () => { throw new Error('must not call taskkill'); },
    sleep: async (milliseconds: number) => { calls.push(`wait:${milliseconds}`); },
    waitForClose: async () => true,
  };

  const error = await terminateProcessTree(fakeChild(), adapter, 37);

  assert.equal(error, '');
  assert.deepEqual(calls, ['-12345:SIGTERM', '-12345:0', 'wait:37', '-12345:SIGKILL']);
});

test('still removes descendants after the detached group leader has exited', async () => {
  const child = fakeChild(0);
  const calls: string[] = [];
  const adapter: ProcessTreeAdapter = {
    platform: 'linux',
    killGroup: (pid: number, signal: NodeJS.Signals | 0) => { calls.push(`${pid}:${signal}`); },
    taskkill: async () => { throw new Error('must not call taskkill'); },
    sleep: async (milliseconds: number) => { calls.push(`wait:${milliseconds}`); },
    waitForClose: async () => true,
  };

  assert.equal(await terminateProcessTree(child, adapter, 37), '');
  assert.deepEqual(calls, ['-12345:SIGTERM', '-12345:0', 'wait:37', '-12345:SIGKILL']);
});

test('waits for close after exit before returning the final output boundary', async () => {
  const child = fakeChild(0);
  const calls: string[] = [];
  const adapter: ProcessTreeAdapter = {
    platform: 'linux',
    killGroup: (_pid: number, signal: NodeJS.Signals | 0) => {
      calls.push(String(signal));
      if (signal === 0) throw Object.assign(new Error('group exited'), { code: 'ESRCH' });
    },
    taskkill: async () => { throw new Error('must not call taskkill'); },
    sleep: async () => {},
    waitForClose: (_child: ChildProcess, milliseconds: number, closed: Promise<void>) => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), milliseconds);
      void closed.then(() => { clearTimeout(timer); resolve(true); });
    }),
  };
  let settled = false;
  const terminated = terminateProcessTree(child, adapter, 100).then((error: string) => { settled = true; return error; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  child.emit('close', 0, null);
  assert.equal(await terminated, '');
  assert.deepEqual(calls, ['SIGTERM', '0']);
});

test('uses Windows taskkill tree mode and reports native failures', async () => {
  const calls: number[] = [];
  const adapter: ProcessTreeAdapter = {
    platform: 'win32',
    killGroup: () => { throw new Error('must not signal process groups'); },
    taskkill: async (pid: number) => { calls.push(pid); },
    sleep: async () => { throw new Error('must not wait on POSIX grace period'); },
    waitForClose: async () => true,
  };

  assert.equal(await terminateProcessTree(fakeChild(), adapter, 37), '');
  assert.deepEqual(calls, [12345]);
});

test('keeps cancellation errors visible when process tree termination fails', async () => {
  const adapter: ProcessTreeAdapter = {
    platform: 'linux',
    killGroup: (_pid: number, signal: NodeJS.Signals | 0) => { if (signal === 'SIGTERM') throw new Error('permission denied'); },
    taskkill: async () => { throw new Error('must not call taskkill'); },
    sleep: async () => {},
    waitForClose: async () => true,
  };

  assert.match(await terminateProcessTree(fakeChild(), adapter, 0), /permission denied/);
});

test('falls back to killing the direct process when Windows taskkill fails', async () => {
  const child = fakeChild();
  const signals: NodeJS.Signals[] = [];
  child.kill = (signal) => { if (typeof signal === 'string') signals.push(signal); return true; };
  const adapter: ProcessTreeAdapter = {
    platform: 'win32',
    killGroup: () => { throw new Error('must not signal process groups'); },
    taskkill: async () => { throw new Error('Access is denied'); },
    sleep: async () => {},
    waitForClose: async () => true,
  };

  assert.match(await terminateProcessTree(child, adapter), /taskkill failed: Access is denied/);
  assert.deepEqual(signals, ['SIGKILL']);
});

test('reports a process that does not close after taskkill returns', async () => {
  const adapter: ProcessTreeAdapter = {
    platform: 'win32',
    killGroup: () => { throw new Error('must not signal process groups'); },
    taskkill: async () => {},
    sleep: async () => {},
    waitForClose: async () => false,
  };

  assert.equal(await terminateProcessTree(fakeChild(), adapter), 'Taskkill completed but process did not close');
});
