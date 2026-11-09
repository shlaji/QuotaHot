import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);

test('independent switch tests never write inherited OmO or Pi credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-test-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const omoDir = join(root, 'outside-omo');
  const piDir = join(root, 'outside-pi');
  await mkdir(omoDir);
  await mkdir(piDir);
  const omoAuth = join(omoDir, 'auth.json');
  const piAuth = join(piDir, 'auth.json');
  const omoOriginal = JSON.stringify({
    'chatgpt-subscription': {
      type: 'oauth', access: 'outside-access', refresh: 'outside-refresh',
      expires: 9_999_999_999_999, accountId: 'outside-account',
    },
  });
  const piOriginal = JSON.stringify({
    'openai-codex': {
      type: 'oauth', access: 'outside-access', refresh: 'outside-refresh',
      expires: 9_999_999_999_999, accountId: 'outside-account',
    },
  });
  await writeFile(omoAuth, omoOriginal);
  await writeFile(piAuth, piOriginal);

  const environment: NodeJS.ProcessEnv = {
    ...process.env, OMO_CODING_AGENT_DIR: omoDir, PI_CODING_AGENT_DIR: piDir,
  };
  delete environment.NODE_TEST_CONTEXT;
  const { stdout } = await exec(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--test',
    '--test-name-pattern=OpenCode trigger uses the OpenCode current account|generated plugin quota phrases drive the real OpenCode hook switch path|OpenCode quota event switches Codex CLI',
    resolve('test/switcher-clients.test.ts'), resolve('test/plugin-integration.test.ts'),
  ], {
    cwd: process.cwd(),
    env: environment,
    timeout: 30_000,
  });

  assert.match(stdout, /tests 3\b/);
  assert.equal(await readFile(omoAuth, 'utf8'), omoOriginal);
  assert.equal(await readFile(piAuth, 'utf8'), piOriginal);
  await assert.rejects(access(`${omoAuth}.quotahot-bak`));
  await assert.rejects(access(`${piAuth}.quotahot-bak`));
});
