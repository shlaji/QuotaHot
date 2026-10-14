import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const entry = resolve('src/index.ts');

type CliResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

async function cli(args: readonly string[], home?: string): Promise<CliResult> {
  return new Promise((resolveResult) => {
    execFile(process.execPath, ['--import', import.meta.resolve('tsx'), entry, ...args], {
      cwd: process.cwd(),
    env: home === undefined ? process.env : {
      ...process.env, HOME: home, QUOTAHOT_DATA_DIR: join(home, '.quotahot'),
      XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
      PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'),
    },
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      resolveResult({ code: error?.code === undefined ? 0 : Number(error.code), stdout, stderr });
    });
  });
}

test('standalone command exposes only hook operations', async () => {
  // Given: the independently executable hook entrypoint.
  // When: a user requests its help.
  const { stdout } = await cli(['help']);
  // Then: hook operations use the standalone command name and no server operation is offered.
  assert.match(stdout, /quotahot-hook install/);
  assert.match(stdout, /quotahot-hook run/);
  assert.doesNotMatch(stdout, /serve|Web service/i);
});

test('install print emits only the OpenCode plugin without writing files', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-hook-preview-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const preview = await cli(['install', '--print'], home);
  assert.equal(preview.code, 0);
  assert.match(preview.stdout, /quotahot\.js/);
  assert.match(preview.stdout, /run.*opencode/);
  assert.doesNotMatch(preview.stdout, /hooks\.json|extensions\/quotahot-hook|run codex|run pi/);
  await assert.rejects(access(join(home, '.codex', 'hooks.json')));
  await assert.rejects(access(join(home, '.pi', 'agent', 'extensions', 'quotahot-hook.ts')));
});

test('subcommand help shows only the selected command options', async () => {
  // Given: each standalone command owns a distinct option surface.
  // When: help is requested through both accepted forms.
  const switchHelp = await cli(['help', 'switch']);
  const statusHelp = await cli(['status', '--help']);
  const installHelp = await cli(['install', '--help']);
  const runHelp = await cli(['run', '--help']);
  const uninstallHelp = await cli(['uninstall', '--help']);
  // Then: help is scoped and never falls through to command execution.
  assert.match(switchHelp.stdout, /quotahot-hook switch \[options\]/);
  assert.match(switchHelp.stdout, /--threshold/);
  assert.match(switchHelp.stdout, /--dry-run/);
  assert.doesNotMatch(switchHelp.stdout, /--print/);
  assert.match(statusHelp.stdout, /quotahot-hook status \[options\]/);
  assert.match(statusHelp.stdout, /--no-check/);
  assert.doesNotMatch(statusHelp.stdout, /--dry-run|--min-interval-seconds/);
  assert.match(installHelp.stdout, /quotahot-hook install/);
  assert.match(installHelp.stdout, /--print/);
  assert.doesNotMatch(installHelp.stdout, /--threshold/);
  assert.match(runHelp.stdout, /quotahot-hook run opencode/);
  assert.match(runHelp.stdout, /--threshold/);
  assert.doesNotMatch(runHelp.stdout, /--exhausted|--print/);
  assert.match(uninstallHelp.stdout, /quotahot-hook uninstall/);
  assert.doesNotMatch(uninstallHelp.stdout, /codex|pi/);
  assert.doesNotMatch(uninstallHelp.stdout, /Options:/);
});

test('install help never writes host integration files', async (context) => {
  // Given: an isolated home with no Codex or OpenCode configuration.
  const home = await mkdtemp(join(tmpdir(), 'quotahot-hook-help-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  // When: install help is requested.
  const result = await cli(['install', '--help'], home);
  // Then: it succeeds as documentation and creates no integration files.
  assert.equal(result.code, 0);
  await assert.rejects(access(join(home, '.codex', 'hooks.json')));
  await assert.rejects(access(join(home, '.config', 'opencode')));
});

test('invalid provider is rejected instead of silently selecting Codex', async () => {
  // Given: an unsupported provider value at the CLI boundary.
  // When: status parsing occurs.
  const result = await cli(['status', '--provider', 'other']);
  // Then: the command reports usage error without surveying Codex.
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Invalid --provider: other/);
  assert.equal(result.stdout, '');
});

test('only OpenCode is a supported install and run target', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-hook-pi-cli-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  for (const args of [['install', 'codex'], ['install', 'pi'], ['install', 'all'], ['uninstall', 'codex'], ['uninstall', 'pi']]) {
    const result = await cli(args, home);
    assert.equal(result.code, 2, args.join(' '));
  }
  for (const client of ['codex', 'pi']) {
    const result = await cli(['run', client], home);
    assert.equal(result.code, 2, `run ${client}`);
  }
  assert.equal((await cli(['install', 'wrong'], home)).code, 2);
  await assert.rejects(access(join(home, '.codex', 'hooks.json')));
  await assert.rejects(access(join(home, '.pi', 'agent', 'extensions', 'quotahot-hook.ts')));
});

test('default install removes owned legacy triggers but preserves other hooks and client auth', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-hook-migrate-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const codexDir = join(home, '.codex');
  const piDir = join(home, '.pi', 'agent');
  await Promise.all([
    mkdir(codexDir, { recursive: true }), mkdir(join(piDir, 'extensions'), { recursive: true }),
    writeFile(join(codexDir, 'hooks.json'), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [
        { type: 'command', command: 'quotahot-hook run codex' },
        { type: 'command', command: 'keep-this-hook' },
      ] }],
    } })),
  ]);
  await writeFile(join(piDir, 'extensions', 'quotahot-hook.ts'), '// quotahot:pi-extension\nold integration');
  await writeFile(join(piDir, 'auth.json'), '{"openai-codex":{"access":"keep-auth"}}');

  const installed = await cli(['install'], home);

  assert.equal(installed.code, 0);
  assert.match(await readFile(join(home, '.config', 'opencode', 'plugin', 'quotahot.js'), 'utf8'), /run.*opencode/);
  const hooks = JSON.parse(await readFile(join(codexDir, 'hooks.json'), 'utf8'));
  assert.deepEqual(hooks.hooks.SessionStart[0].hooks.map((hook: { command: string }) => hook.command), ['keep-this-hook']);
  await assert.rejects(access(join(piDir, 'extensions', 'quotahot-hook.ts')));
  assert.equal(await readFile(join(piDir, 'auth.json'), 'utf8'), '{"openai-codex":{"access":"keep-auth"}}');
});
