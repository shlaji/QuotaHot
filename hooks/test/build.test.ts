import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  assert.equal(
    (await readFile(join(fixture, 'dist/opencode-notification-plugin-template.js'), 'utf8')).includes('quotahot-session-notify:start'),
    true,
  );
  await context.test('relocated distribution reads its own template instead of the source or working directory', async () => {
    const relocated = join(root, 'relocated package');
    await cp(join(fixture, 'dist'), relocated, { recursive: true });
    const binary = join(relocated, 'quotahot-hook');
    const template = `${await readFile(join(relocated, 'opencode-plugin-template.js'), 'utf8')}\n// relocated-template\n`;
    await writeFile(join(relocated, 'opencode-plugin-template.js'), template);
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

  await context.test('relocated notification plugin preview reads its adjacent template', async () => {
    const notificationFixture = join(root, 'hooks notification');
    await cp(join(fixture, 'dist'), notificationFixture, { recursive: true });
    const relocated = join(root, 'relocated notification package');
    await cp(notificationFixture, relocated, { recursive: true });
    const binary = join(relocated, 'quotahot-hook');
    const templatePath = join(relocated, 'opencode-notification-plugin-template.js');
    const template = `${await readFile(templatePath, 'utf8')}\n// relocated-notification-template\n`;
    await writeFile(templatePath, template);
    const command = [process.execPath, binary];

    const result = spawnSync(process.execPath, [binary, 'notify', 'install', '--print'], {
      cwd: root,
      env: { ...process.env, XDG_CONFIG_HOME: root },
      encoding: 'utf8',
      timeout: 30_000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `# ${join(root, 'opencode/plugin/quotahot-session-notify.js')}\n${template.replace('"__QUOTAHOT_SESSION_NOTIFY_COMMAND_ARGS__"', JSON.stringify(command))}\n`);
  });
  await context.test('relocated OmO plugin preview uses its adjacent template and agent directory', async () => {
    const relocated = join(root, 'relocated omo package');
    await cp(join(fixture, 'dist'), relocated, { recursive: true });
    const binary = join(relocated, 'quotahot-hook');
    const template = await readFile(join(relocated, 'omo-plugin-template.js'), 'utf8');
    const agentDir = join(root, 'omo agent');
    const result = spawnSync(process.execPath, [binary, 'install', 'omo', '--print'], {
      cwd: root, env: { ...process.env, OMO_CODING_AGENT_DIR: agentDir }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `# ${join(agentDir, 'extensions/quotahot.js')}\n${template.replace('"__QUOTAHOT_OMO_COMMAND_ARGS__"', JSON.stringify([process.execPath, binary]))}\n`);
  });
  for (const target of ['both', 'omo'] as const) {
    await context.test(`release shell installer registers ${target} plugins and preserves existing credentials`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'quotahot installer home-'));
      context.after(() => rm(home, { recursive: true, force: true }));
      const agentDir = join(home, 'omo agent');
      const configHome = join(home, 'config');
      const dataHome = join(home, 'data');
      const { version } = JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8'));
      const extracted = join(root, `extracted package ${target}`);
      await mkdir(extracted);
      const unpacked = spawnSync('tar', ['-xzf', join(fixture, 'release', `quotahot-hook-${version}.tar.gz`), '-C', extracted], {
        encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(unpacked.status, 0, unpacked.stderr);
      await mkdir(join(agentDir, 'extensions'), { recursive: true });
      const authPath = join(agentDir, 'auth.json');
      const auth = '{"chatgpt-subscription":{"type":"oauth","access":"keep"}}\n';
      await writeFile(authPath, auth);
      const foreign = join(agentDir, 'extensions', 'other.js');
      await writeFile(foreign, 'keep');
      const opencodeAuthPath = join(dataHome, 'opencode', 'auth.json');
      const opencodeAuth = '{"openai":{"type":"oauth","access":"keep-opencode"}}\n';
      await mkdir(join(dataHome, 'opencode'), { recursive: true });
      await writeFile(opencodeAuthPath, opencodeAuth);
      const result = spawnSync('sh', [join(extracted, `quotahot-hook-${version}`, 'install.sh'), ...(target === 'omo' ? ['omo'] : [])], {
        cwd: root,
        env: { ...process.env, HOME: home, OMO_CODING_AGENT_DIR: agentDir,
          XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome, QUOTAHOT_DATA_DIR: join(home, 'quota') },
        encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(result.status, 0, result.stderr);
      const binary = join(home, '.local', 'bin', 'quotahot-hook');
      const template = await readFile(join(home, '.local', 'bin', 'omo-plugin-template.js'), 'utf8');
      assert.equal(await readFile(join(agentDir, 'extensions', 'quotahot.js'), 'utf8'),
        template.replace('"__QUOTAHOT_OMO_COMMAND_ARGS__"', JSON.stringify([process.execPath, binary])));
      assert.equal(await readFile(authPath, 'utf8'), auth);
      assert.equal(await readFile(opencodeAuthPath, 'utf8'), opencodeAuth);
      assert.equal(await readFile(foreign, 'utf8'), 'keep');
      const opencodePath = join(configHome, 'opencode', 'plugin', 'quotahot.js');
      if (target === 'both') {
        const opencodeTemplate = await readFile(join(home, '.local', 'bin', 'opencode-plugin-template.js'), 'utf8');
        assert.equal(await readFile(opencodePath, 'utf8'),
          opencodeTemplate.replace('"__QUOTAHOT_COMMAND_ARGS__"', JSON.stringify([process.execPath, binary, 'run', 'opencode'])));
      } else {
        await assert.rejects(access(opencodePath));
      }
      assert.match(result.stdout, /\/reload/);
    });
  }
  await rm(fixture, { recursive: true, force: true });
});
