import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { test } from 'node:test';

const exec = promisify(execFile);

test('installer puts a regular executable directly in the command directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-hook-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = join(root, 'package');
  const home = join(root, 'home');
  await mkdir(packageDir, { recursive: true });
  await copyFile(resolve('scripts/install.sh'), join(packageDir, 'install.sh'));
  await writeFile(join(packageDir, 'quotahot-hook'), '#!/usr/bin/env node\nprocess.exit(0);\n', {
    mode: 0o755,
  });
  await writeFile(join(packageDir, 'package.json'), '{"type":"commonjs"}\n');
  await copyFile(resolve('src/opencode-plugin-template.js'), join(packageDir, 'opencode-plugin-template.js'));
  await copyFile(resolve('src/omo-plugin-template.js'), join(packageDir, 'omo-plugin-template.js'));

  await exec('sh', [join(packageDir, 'install.sh')], {
    cwd: packageDir,
    env: { ...process.env, HOME: home },
  });

  const command = join(home, '.local', 'bin', 'quotahot-hook');
  assert.equal((await lstat(command)).isSymbolicLink(), false);
  await access(command, constants.X_OK);
  assert.match(await readFile(command, 'utf8'), /process\.exit\(0\)/);
  assert.equal(await readFile(join(home, '.local', 'bin', 'opencode-plugin-template.js'), 'utf8'),
    await readFile(join(packageDir, 'opencode-plugin-template.js'), 'utf8'));
  assert.equal(await readFile(join(home, '.local', 'bin', 'omo-plugin-template.js'), 'utf8'),
    await readFile(join(packageDir, 'omo-plugin-template.js'), 'utf8'));
  await assert.rejects(lstat(join(home, '.local', 'lib', 'quotahot-hook')));
});

test('installer finds the bundle from the source tree, where it sits one level up in dist', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-hook-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = join(root, 'hooks');
  const home = join(root, 'home');
  await mkdir(join(packageDir, 'scripts'), { recursive: true });
  await mkdir(join(packageDir, 'dist'), { recursive: true });
  await copyFile(resolve('scripts/install.sh'), join(packageDir, 'scripts', 'install.sh'));
  await writeFile(join(packageDir, 'dist', 'quotahot-hook'), '#!/usr/bin/env node\nprocess.exit(0);\n', {
    mode: 0o755,
  });
  await copyFile(resolve('src/opencode-plugin-template.js'), join(packageDir, 'dist', 'opencode-plugin-template.js'));
  await copyFile(resolve('src/omo-plugin-template.js'), join(packageDir, 'dist', 'omo-plugin-template.js'));

  await exec('sh', [join(packageDir, 'scripts', 'install.sh')], {
    cwd: packageDir,
    env: { ...process.env, HOME: home },
  });
  const command = join(home, '.local', 'bin', 'quotahot-hook');
  await access(command, constants.X_OK);
  assert.match(await readFile(command, 'utf8'), /process\.exit\(0\)/);
  assert.equal(await readFile(join(home, '.local', 'bin', 'opencode-plugin-template.js'), 'utf8'),
    await readFile(join(packageDir, 'dist', 'opencode-plugin-template.js'), 'utf8'));
});

test('shell installer rejects unknown targets and extra arguments before installing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-hook-script-pi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = join(root, 'package');
  const home = join(root, 'home');
  await mkdir(packageDir, { recursive: true });
  await copyFile(resolve('scripts/install.sh'), join(packageDir, 'install.sh'));
  await writeFile(join(packageDir, 'quotahot-hook'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.HOME + '/target', process.argv.slice(2).join(' '));\n`, { mode: 0o755 });
  await writeFile(join(packageDir, 'package.json'), '{"type":"commonjs"}\n');
  for (const args of [['pi'], ['codex'], ['all'], ['omo', 'extra'], ['--help', 'extra']]) {
    const result = await exec('sh', [join(packageDir, 'install.sh'), ...args], {
      cwd: packageDir, env: { ...process.env, HOME: home },
    }).then(() => ({ code: 0 }), (error: unknown) => {
      if (error instanceof Error && 'code' in error) return { code: error.code };
      throw error;
    });
    assert.equal(result.code, 2, args.join(' '));
  }
  await assert.rejects(access(join(home, '.local', 'bin', 'quotahot-hook')));
});

test('shell installer reports failure when default OmO registration fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-hook-script-default-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = join(root, 'package');
  const home = join(root, 'home');
  await mkdir(packageDir, { recursive: true });
  await copyFile(resolve('scripts/install.sh'), join(packageDir, 'install.sh'));
  await writeFile(join(packageDir, 'quotahot-hook'), '#!/usr/bin/env node\nprocess.exit(process.argv[3] === "omo" ? 7 : 0);\n', { mode: 0o755 });
  await writeFile(join(packageDir, 'package.json'), '{"type":"commonjs"}\n');
  await copyFile(resolve('src/opencode-plugin-template.js'), join(packageDir, 'opencode-plugin-template.js'));
  await copyFile(resolve('src/omo-plugin-template.js'), join(packageDir, 'omo-plugin-template.js'));
  const result = await exec('sh', [join(packageDir, 'install.sh')], {
    cwd: packageDir, env: { ...process.env, HOME: home },
  }).then(({ stdout }) => ({ code: 0, stdout }), (error: unknown) => {
    if (error instanceof Error && 'code' in error && 'stdout' in error) return { code: error.code, stdout: error.stdout };
    throw error;
  });
  assert.equal(result.code, 7);
  assert.equal(typeof result.stdout, 'string');
  assert.doesNotMatch(String(result.stdout), /Installed/);
});
