import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const entry = resolve('src/index.ts');

type CliResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

async function cli(args: readonly string[], home?: string): Promise<CliResult> {
  return new Promise((resolveResult) => {
    execFile(process.execPath, ['--import', import.meta.resolve('tsx'), entry, ...args], {
      cwd: process.cwd(),
    env: home === undefined ? process.env : { ...process.env, HOME: home, QUOTAHOT_DATA_DIR: join(home, '.quotahot') },
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

test('install print emits the standalone invocation without writing files', async () => {
  // Given: an installation preview for Codex.
  // When: the standalone installer renders the configuration.
  const { stdout } = await cli(['install', 'codex', '--print']);
  // Then: the generated command invokes this program's run subcommand.
  assert.match(stdout, /quotahot-hook|index\.ts/);
  assert.match(stdout, /run codex/);
  assert.doesNotMatch(stdout, /legacy-hook(?:\.exe)?(?:['"])? hook codex/);

  const opencode = await cli(['install', 'opencode', '--print']);
  assert.match(opencode.stdout, /quotahot\.js/);
  assert.match(opencode.stdout, /run.+opencode/);
  assert.doesNotMatch(opencode.stdout, /hooks\.json/);
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
  assert.match(runHelp.stdout, /quotahot-hook run <codex\|opencode>/);
  assert.match(runHelp.stdout, /--threshold/);
  assert.doesNotMatch(runHelp.stdout, /--exhausted|--print/);
  assert.match(uninstallHelp.stdout, /quotahot-hook uninstall/);
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
