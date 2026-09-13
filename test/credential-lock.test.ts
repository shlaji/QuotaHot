import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCredentialLock } from '../src/server/credential-lock.js';

test('持锁进程被强杀后下一次刷新仍能取得锁', { timeout: 10000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-lock-crash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'account.json');
  const moduleUrl = new URL('../src/server/credential-lock.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { withCredentialLock } from ${JSON.stringify(moduleUrl)};
    await withCredentialLock(${JSON.stringify(path)}, async()=>{
      process.send('locked');
      setInterval(()=>{},1000);
      await new Promise(()=>{});
    });
  `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  const [message] = await once(child, 'message');
  assert.equal(message, 'locked');
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
  assert.equal(await withCredentialLock(path, async () => 'recovered'), 'recovered');
});
