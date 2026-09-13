import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const entry = new URL('../src/main.ts', import.meta.url).pathname;

type CliResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

function cli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolveResult) => {
    execFile(process.execPath, ['--import', 'tsx', entry, ...args], { timeout: 5_000 }, (error, stdout, stderr) => {
      resolveResult({ code: error?.code === undefined ? 0 : Number(error.code), stdout, stderr });
    });
  });
}

async function startsServer(args: readonly string[], dataDir: string): Promise<string> {
  const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
    env: { ...process.env, PORT: '0', QUOTAHOT_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = await new Promise<string>((resolveOutput, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start')), 10_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let text = '';
    const collect = (chunk: string): void => {
      text += chunk;
      if (!text.includes('QuotaHot 已启动:')) return;
      clearTimeout(timeout);
      resolveOutput(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
  });
  child.kill('SIGTERM');
  await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  return output;
}

test('help exits successfully without starting the server', async () => {
  // Given: the main distribution entrypoint.
  // When: a user requests help.
  const result = await cli(['--help']);
  // Then: usage is printed and the process exits instead of listening.
  assert.equal(result.code, 0);
  assert.match(result.stdout, /quotahot \[serve\]/);
  assert.doesNotMatch(result.stdout, /已启动/);
});

test('unknown command exits with usage error without starting the server', async () => {
  // Given: an argument that is not part of the main program's command surface.
  // When: command dispatch runs.
  const result = await cli(['hook']);
  // Then: it exits 2 and does not fall through to the service.
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown command: hook/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /已启动/);
});

test('no arguments starts the service', async (context) => {
  // Given: an isolated data directory and ephemeral port.
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-main-noargs-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  // When: the main program runs without arguments.
  const output = await startsServer([], dataDir);
  // Then: the HTTP service starts.
  assert.match(output, /QuotaHot 已启动:/);
});

test('serve explicitly starts the service', async (context) => {
  // Given: an isolated data directory and ephemeral port.
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-main-serve-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  // When: the serve command is explicit.
  const output = await startsServer(['serve'], dataDir);
  // Then: the HTTP service starts.
  assert.match(output, /QuotaHot 已启动:/);
});
