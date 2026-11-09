import { spawn } from 'node:child_process';
import { globSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'quotahot-hook-test-'));
try {
  const child = spawn(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--test', '--experimental-test-module-mocks',
    ...globSync('test/*.test.ts').sort(),
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      QUOTAHOT_DATA_DIR: join(home, '.quotahot'),
      OMO_CODING_AGENT_DIR: join(home, '.omo', 'agent'),
      PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'),
    },
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  process.exitCode = exitCode;
} finally {
  await rm(home, { recursive: true, force: true });
}
