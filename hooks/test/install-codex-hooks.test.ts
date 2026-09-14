import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);
const main = resolve('src/index.ts');
const loader = import.meta.resolve('tsx');

interface CommandHook {
  readonly type: string;
  readonly command: string;
  readonly timeout?: number;
}

interface HookEntry {
  readonly matcher?: string;
  readonly hooks: readonly CommandHook[];
}

interface HooksFile {
  readonly hooks: Readonly<Record<string, readonly HookEntry[]>>;
}

async function runCli(home: string, command: 'install' | 'uninstall'): Promise<void> {
  await exec(process.execPath, ['--import', loader, main, command, 'codex'], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, QUOTAHOT_DATA_DIR: join(home, '.quotahot') },
  });
}

async function readHooks(path: string): Promise<HooksFile> {
  return JSON.parse(await readFile(path, 'utf8'));
}

for (const operation of ['install', 'uninstall'] as const) {
  test(`Codex ${operation} recognizes QuotaHot Hook commands from other installation paths`, async (context) => {
    const home = await mkdtemp(join(tmpdir(), 'quotahot-reinstall-'));
    context.after(() => rm(home, { recursive: true, force: true }));
    await mkdir(join(home, '.codex'));
    const path = join(home, '.codex', 'hooks.json');
    const commands = [
      "node '/opt/new quota/quotahot-hook' run codex",
      'quotahot-hook run codex',
      'foreign-quotahot-hook run codex',
    ];
    await writeFile(path, JSON.stringify({ hooks: {
      SessionStart: [{ hooks: commands.map((command) => ({ type: 'command', command })) }],
    } }));

    await runCli(home, operation);

    const result = await readHooks(path);
    const remaining = result.hooks.SessionStart?.flatMap((entry) => entry.hooks.map((hook) => hook.command));
    assert.ok(remaining);
    assert.equal(remaining.length, operation === 'install' ? 2 : 1);
    assert.equal(remaining.includes('foreign-quotahot-hook run codex'), true);
    for (const command of commands.slice(0, -1)) assert.equal(remaining.includes(command), false);
  });
}

test('Codex reinstall and uninstall preserve grouped sibling hooks and foreign similar commands', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-install-codex-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, '.codex', 'hooks.json');
  await runCli(home, 'install');
  const installed = await readHooks(path);
  const ownCommand = installed.hooks.SessionStart?.[0]?.hooks[0]?.command;
  assert.ok(ownCommand);

  const grouped: HooksFile = {
    hooks: Object.fromEntries(Object.keys(installed.hooks).map((event) => [event, [
      {
        matcher: 'keep-matcher',
        hooks: [
          { type: 'command', command: ownCommand, timeout: 20 },
          { type: 'command', command: 'sibling-tool --keep', timeout: 3 },
        ],
      },
      { hooks: [{ type: 'command', command: '/other/tool hook codex' }] },
    ]]))
  };
  await writeFile(path, `${JSON.stringify(grouped, null, 2)}\n`);

  await runCli(home, 'install');
  const reinstalled = await readHooks(path);
  for (const entries of Object.values(reinstalled.hooks)) {
    assert.equal(entries.filter((entry) => entry.hooks.some((hook) => hook.command === ownCommand)).length, 1);
    assert.equal(entries.some((entry) => entry.matcher === 'keep-matcher' && entry.hooks.some((hook) => hook.command === 'sibling-tool --keep')), true);
    assert.equal(entries.some((entry) => entry.hooks.some((hook) => hook.command === '/other/tool hook codex')), true);
  }

  await runCli(home, 'uninstall');
  const uninstalled = await readHooks(path);
  for (const entries of Object.values(uninstalled.hooks)) {
    assert.equal(entries.some((entry) => entry.hooks.some((hook) => hook.command === ownCommand)), false);
    assert.equal(entries.some((entry) => entry.matcher === 'keep-matcher' && entry.hooks.some((hook) => hook.command === 'sibling-tool --keep')), true);
    assert.equal(entries.some((entry) => entry.hooks.some((hook) => hook.command === '/other/tool hook codex')), true);
  }
});
