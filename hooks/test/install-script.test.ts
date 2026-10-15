import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
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

test('shell installer rejects client selectors before installing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-hook-script-pi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = join(root, 'package');
  const home = join(root, 'home');
  await mkdir(packageDir, { recursive: true });
  await copyFile(resolve('scripts/install.sh'), join(packageDir, 'install.sh'));
  await writeFile(join(packageDir, 'quotahot-hook'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.HOME + '/target', process.argv.slice(2).join(' '));\n`, { mode: 0o755 });
  await writeFile(join(packageDir, 'package.json'), '{"type":"commonjs"}\n');
  assert.throws(() => execFileSync('sh', [join(packageDir, 'install.sh'), 'pi'], {
    cwd: packageDir, env: { ...process.env, HOME: home }, encoding: 'utf8',
  }));
  await assert.rejects(access(join(home, '.local', 'bin', 'quotahot-hook')));
});

test('shell installer installs without forwarding a client selector', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-hook-script-default-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = join(root, 'package');
  const home = join(root, 'home');
  await mkdir(packageDir, { recursive: true });
  await copyFile(resolve('scripts/install.sh'), join(packageDir, 'install.sh'));
  await writeFile(join(packageDir, 'quotahot-hook'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.HOME + '/target', process.argv.slice(2).join(' '));\n`, { mode: 0o755 });
  await writeFile(join(packageDir, 'package.json'), '{"type":"commonjs"}\n');
  await copyFile(resolve('src/opencode-plugin-template.js'), join(packageDir, 'opencode-plugin-template.js'));
  const stdout = execFileSync('sh', [join(packageDir, 'install.sh')], { cwd: packageDir, env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.match(stdout, /Installed/);
  assert.equal(await readFile(join(home, 'target'), 'utf8'), 'install');
});
