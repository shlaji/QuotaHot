import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const packageRoot = resolve(import.meta.dirname, '..');

test('source CLI resolves its adjacent template from another working directory', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-hook-source-template-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(packageRoot, 'src/index.ts');
  const loader = import.meta.resolve('tsx');
  const template = await readFile(join(packageRoot, 'src/opencode-plugin-template.js'), 'utf8');
  const command = [process.execPath, '--import', loader, entry, 'run', 'opencode'];

  const result = spawnSync(process.execPath, ['--import', loader, entry, 'install', '--print'], {
    cwd: root,
    env: { ...process.env, XDG_CONFIG_HOME: root },
    encoding: 'utf8',
    timeout: 30_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `# ${join(root, 'opencode/plugin/quotahot.js')}\n${template.replace('"__QUOTAHOT_COMMAND_ARGS__"', JSON.stringify(command))}\n`);
});

test('production build has no import.meta warning and resolves a relocated adjacent template', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-hook-build-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'hooks');
  await mkdir(fixture);
  await Promise.all([
    cp(join(packageRoot, 'src'), join(fixture, 'src'), { recursive: true }),
    cp(join(packageRoot, 'scripts'), join(fixture, 'scripts'), { recursive: true }),
    copyFile(join(packageRoot, 'package.json'), join(fixture, 'package.json')),
    copyFile(join(packageRoot, 'README.md'), join(fixture, 'README.md')),
    copyFile(join(packageRoot, '../package.json'), join(root, 'package.json')),
    symlink(join(packageRoot, 'node_modules'), join(fixture, 'node_modules'), 'dir'),
  ]);

  const build = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: fixture, encoding: 'utf8', timeout: 30_000 });

  assert.equal(build.status, 0, build.stderr);
  assert.doesNotMatch(build.stderr, /empty-import-meta|import\.meta/);
  await context.test('relocated distribution reads its own template instead of the source or working directory', async () => {
    const relocated = join(root, 'relocated package');
    await cp(join(fixture, 'dist'), relocated, { recursive: true });
    const binary = join(relocated, 'quotahot-hook');
    const template = `${await readFile(join(relocated, 'opencode-plugin-template.js'), 'utf8')}\n// relocated-template\n`;
    await writeFile(join(relocated, 'opencode-plugin-template.js'), template);
    await rm(fixture, { recursive: true, force: true });
    const command = [process.execPath, binary, 'run', 'opencode'];

    const result = spawnSync(process.execPath, [binary, 'install', '--print'], {
      cwd: root,
      env: { ...process.env, XDG_CONFIG_HOME: root },
      encoding: 'utf8',
      timeout: 30_000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `# ${join(root, 'opencode/plugin/quotahot.js')}\n${template.replace('"__QUOTAHOT_COMMAND_ARGS__"', JSON.stringify(command))}\n`);
  });
});
