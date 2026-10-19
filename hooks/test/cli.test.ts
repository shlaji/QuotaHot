import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const entry = resolve('src/index.ts');

type CliResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

async function cli(args: readonly string[], home?: string): Promise<CliResult> {
  return new Promise((resolveResult) => {
    const child = execFile(process.execPath, ['--import', import.meta.resolve('tsx'), entry, ...args], {
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
    child.stdin?.end();
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

test('print and install render identical owned plugin while uninstall preserves foreign files', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-hook-lifecycle-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const pluginDir = join(home, '.config', 'opencode', 'plugins');
  await mkdir(pluginDir, { recursive: true });
  const pluginPath = join(pluginDir, 'quotahot.js');
  const preview = await cli(['install', '--print'], home);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(preview.stdout.slice(0, preview.stdout.indexOf('\n')), `# ${pluginPath}`);
  await assert.rejects(access(pluginPath));

  const installed = await cli(['install'], home);
  assert.equal(installed.code, 0, installed.stderr);
  const rendered = preview.stdout.slice(preview.stdout.indexOf('\n') + 1, -1);
  assert.equal(await readFile(pluginPath, 'utf8'), rendered);
  assert.match(rendered, /quotahot:start/);
  assert.doesNotMatch(rendered, /__QUOTAHOT_COMMAND_ARGS__/);

  const removed = await cli(['uninstall'], home);
  assert.equal(removed.code, 0, removed.stderr);
  await assert.rejects(access(pluginPath));
  await writeFile(pluginPath, 'export default { id: "other" };\n');
  const foreign = await cli(['uninstall'], home);
  assert.equal(foreign.code, 0, foreign.stderr);
  assert.equal(await readFile(pluginPath, 'utf8'), 'export default { id: "other" };\n');
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
  assert.match(switchHelp.stdout, /quotahot-hook switch \[选项\]/);
  assert.match(switchHelp.stdout, /--threshold/);
  assert.match(switchHelp.stdout, /--dry-run/);
  assert.doesNotMatch(switchHelp.stdout, /--print/);
  assert.match(statusHelp.stdout, /quotahot-hook status \[选项\]/);
  assert.match(statusHelp.stdout, /--no-check/);
  assert.doesNotMatch(statusHelp.stdout, /--dry-run|--min-interval-seconds/);
  assert.match(installHelp.stdout, /quotahot-hook install/);
  assert.match(installHelp.stdout, /--print/);
  assert.doesNotMatch(installHelp.stdout, /--threshold/);
  assert.match(runHelp.stdout, /quotahot-hook run opencode/);
  assert.match(runHelp.stdout, /--min-interval-seconds/);
  assert.doesNotMatch(runHelp.stdout, /--provider|--client|--threshold|--cache-seconds|--reason|--exhausted|--print/);
  assert.match(uninstallHelp.stdout, /quotahot-hook uninstall/);
  assert.doesNotMatch(uninstallHelp.stdout, /codex|pi/);
  assert.doesNotMatch(uninstallHelp.stdout, /Options:/);
});

test('global and subcommand help explain behavior in Chinese', async () => {
  // Given: the documented public commands and their standalone help entrypoints.
  // When: a user requests help rather than executing the command.
  for (const args of [[], ['help'], ['--help'], ['status', '--help'], ['switch', '--help'], ['run', '--help', 'opencode'], ['install', '--help'], ['uninstall', '--help'], ['recovery-status', '--help']]) {
    const result = await cli(args);
    // Then: each help path succeeds and offers Chinese guidance.
    assert.equal(result.code, 0, args.join(' '));
    assert.match(result.stdout, /[\u4e00-\u9fff]{2,}/, args.join(' '));
  }
  const status = await cli(['help', 'status']);
  assert.match(status.stdout, /--threshold|--cache-seconds|--no-check|--json/);
  const selected = await cli(['help', 'switch']);
  assert.match(selected.stdout, /默认|覆盖|风险/);
  const run = await cli(['help', 'run']);
  assert.match(run.stdout, /标准输出|标准错误/);
  assert.doesNotMatch(run.stdout, /--provider|--client|--threshold|--cache-seconds|--reason|--exhausted/);
  const version = await cli(['version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^(?:\d+\.\d+\.\d+|dev)$/);
  assert.equal((await cli(['--version'])).stdout, version.stdout);
});

test('run rejects unsupported options before reading event or writing state', async (context) => {
  // Given: an isolated data directory and options that cannot affect OpenCode's event contract.
  const home = await mkdtemp(join(tmpdir(), 'quotahot-hook-invalid-run-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  // When: each unsupported option is passed before or after the target.
  for (const option of ['--provider', '--client', '--threshold', '--cache-seconds', '--reason', '--exhausted', '--unknown']) {
    for (const args of [['run', 'opencode', option, 'value'], ['run', option, 'value', 'opencode']]) {
      const result = await cli(args, home);
      // Then: usage fails without emitting hook JSON or creating data files.
      assert.equal(result.code, 2, args.join(' '));
      assert.equal(result.stdout, '', args.join(' '));
      assert.match(result.stderr, new RegExp(option), args.join(' '));
    }
  }
  await assert.rejects(access(join(home, '.quotahot', 'switch-state.json')));
});

test('other commands reject flags that their help does not support', async () => {
  for (const args of [
    ['status', '--dry-run'], ['status', '--client', 'opencode'],
    ['switch', '--print'], ['install', '--threshold', '20'],
    ['uninstall', '--print'], ['recovery-status', '--no-check'],
    ['version', '--json'],
  ]) {
    const result = await cli(args);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
  }
});

test('numeric quota options reject missing or invalid values instead of silently using defaults', async () => {
  for (const args of [
    ['status', '--threshold'], ['status', '--threshold', 'foo'],
    ['switch', '--threshold', '101'], ['switch', '--cache-seconds', '-1'],
    ['switch', '--min-interval-seconds', 'nope'],
  ]) {
    const result = await cli(args);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
  }
});

test('long numeric options accept concise aliases without changing command restrictions', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-cli-option-alias-'));
  context.after(() => rm(home, { recursive: true, force: true }));

  for (const args of [
    ['status', '-c', '0', '--no-check'],
    ['status', '-c=0', '--no-check'],
    ['switch', '-c=0', '-i', '0', '--no-check', '--dry-run'],
    ['switch', '--cache-seconds=0', '--min-interval-seconds=0', '--no-check', '--dry-run'],
    ['run', 'opencode', '-i=0', '--dry-run'],
    ['run', '-i', '0', 'opencode', '--dry-run'],
  ]) {
    const result = await cli(args, home);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
  }

  for (const item of [
    { args: ['status', '-c', 'invalid'], error: '--cache-seconds' },
    { args: ['status', '-c', '--no-check'], error: '--cache-seconds' },
    { args: ['switch', '-i=-1', '--no-check'], error: '--min-interval-seconds' },
    { args: ['run', 'opencode', '-c', '10'] },
    { args: ['status', '-i', '10'] },
    { args: ['install', '-c', '10'] },
  ] as const) {
    const result = await cli(item.args, home);
    assert.equal(result.code, 2, item.args.join(' '));
    if (item.error !== undefined) assert.match(result.stderr, new RegExp(item.error));
  }

  const statusHelp = (await cli(['status', '--help'], home)).stdout;
  assert.match(statusHelp, /-c, --cache-seconds/);
  assert.equal((await cli(['status', '-h'], home)).code, 0);
  const switchHelp = (await cli(['switch', '--help'], home)).stdout;
  assert.match(switchHelp, /-c, --cache-seconds/);
  assert.match(switchHelp, /-i, --min-interval-seconds/);
  const runHelp = (await cli(['run', '--help'], home)).stdout;
  assert.match(runHelp, /-i, --min-interval-seconds/);
});

test('run accepts only meaningful options on either side of opencode', async (context) => {
  // Given: an empty event in a temporary home, so no account can be switched.
  const home = await mkdtemp(join(tmpdir(), 'quotahot-hook-valid-run-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  // When: options precede or follow the positional event target.
  for (const args of [
    ['run', '--json', 'opencode'], ['run', 'opencode', '--json'],
    ['run', '--no-check', 'opencode'], ['run', '--dry-run', 'opencode'],
    ['run', '--min-interval-seconds', '0', 'opencode'],
  ]) {
    const result = await cli(args, home);
    // Then: stdout remains the hook protocol; diagnostics for --json use stderr.
    assert.equal(result.code, 0, args.join(' '));
    assert.equal(JSON.parse(result.stdout).outcome, 'skipped_no_signal', args.join(' '));
    if (args.includes('--json')) assert.equal(JSON.parse(result.stderr).outcome, 'skipped_no_signal');
  }
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

test('recovery-status reports multiple local polling instances without querying accounts', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-recovery-cli-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const statusDir = join(home, '.quotahot', 'recovery-status');
  await mkdir(statusDir, { recursive: true });
  const snapshot = (id: string, sessionID: string) => ({
    version: 1, id, pid: process.pid, updatedAt: Date.now(), phase: 'waiting',
    waitingCount: 1, sessions: [{ sessionID, phase: 'waiting' }],
    nextCheckAt: Date.now() + 30_000, lastCheckedAt: null, lastOutcome: null,
  });
  await writeFile(join(statusDir, 'first.json'), JSON.stringify(snapshot('first', 'session-a')));
  await writeFile(join(statusDir, 'second.json'), JSON.stringify(snapshot('second', 'session-b')));

  const json = await cli(['recovery-status', '--json'], home);
  assert.equal(json.code, 0, json.stderr);
  const status = JSON.parse(json.stdout);
  assert.equal(status.totalWaiting, 2);
  assert.deepEqual(status.instances.map((item: { id: string }) => item.id).sort(), ['first', 'second']);
  const text = await cli(['recovery-status'], home);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /session-a/);
  assert.match(text.stdout, /session-b/);
});

test('recovery is an alias for recovery-status, including help and JSON output', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-recovery-alias-'));
  context.after(() => rm(home, { recursive: true, force: true }));

  const canonical = await cli(['recovery-status', '--json'], home);
  const alias = await cli(['recovery', '--json'], home);
  assert.equal(alias.code, canonical.code);
  assert.deepEqual(JSON.parse(alias.stdout), JSON.parse(canonical.stdout));

  const help = await cli(['recovery', '--help'], home);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /用法：quotahot-hook recovery-status/);
  assert.match((await cli(['help', 'recovery'], home)).stdout, /--json/);
});

test('recovery-status separates expired snapshots from active polling instances', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-recovery-stale-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, '.quotahot', 'recovery-status');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'old.json'), JSON.stringify({
    version: 1, id: 'old', pid: process.pid, updatedAt: Date.now() - 200_000,
    phase: 'waiting', waitingCount: 2, sessions: [{ sessionID: 'old-session', phase: 'waiting' }],
    nextCheckAt: null, lastCheckedAt: null, lastOutcome: null,
  }));
  const json = JSON.parse((await cli(['recovery-status', '--json'], home)).stdout);
  assert.equal(json.totalWaiting, 0);
  assert.equal(json.instances[0].stale, true);

  const output = await cli(['recovery-status'], home);
  assert.equal(output.code, 0);
  assert.match(output.stdout, /没有正在等待/);
  assert.doesNotMatch(output.stdout, /old-session:/);
  assert.deepEqual(await readdir(directory), []);
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
