import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const INSTALLER = new URL('../scripts/install.sh', import.meta.url).pathname;
const homes: string[] = [];

after(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

interface Fixture {
  home: string;
  source: string;
  systemctlLog: string;
  env: NodeJS.ProcessEnv;
}

async function fixture(): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), 'quotahot install home-'));
  homes.push(home);
  const tools = join(home, 'tools');
  const source = join(home, 'bundle', 'quotahot');
  const systemctlLog = join(home, 'systemctl.log');
  await mkdir(tools, { recursive: true });
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, '#!/usr/bin/env node\nconsole.log("fixture")\n', { mode: 0o755 });

  const node = join(tools, 'node');
  await writeFile(node, '#!/bin/sh\nprintf "v24.0.0\\n"\n', { mode: 0o755 });
  const systemctl = join(tools, 'systemctl');
  await writeFile(
    systemctl,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}\n` +
      'if [ "${QUOTAHOT_TEST_SYSTEMCTL_DISABLED:-}" = "1" ] && [ "$*" = "--user is-enabled --quiet quotahot.service" ]; then exit 1; fi\n' +
      'if [ "${QUOTAHOT_TEST_SYSTEMCTL_FAIL:-}" = "$*" ]; then exit 1; fi\n',
    { mode: 0o755 },
  );

  return {
    home,
    source,
    systemctlLog,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      PATH: `${tools}:${process.env.PATH ?? ''}`,
      QUOTAHOT_INSTALL_SOURCE: source,
      QUOTAHOT_SYSTEMCTL: systemctl,
    },
  };
}

function install(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('bash', [INSTALLER, ...args], { env, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

function exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

test('安装到当前用户目录并生成匹配实际路径和端口的 systemd 服务', async () => {
  const f = await fixture();
  const { stdout } = await install(['--port', '9000'], f.env);

  const binary = join(f.home, '.quotahot', 'bin', 'quotahot');
  const unit = join(f.home, '.config', 'systemd', 'user', 'quotahot.service');
  assert.equal(await readFile(binary, 'utf8'), await readFile(f.source, 'utf8'));
  assert.equal((await stat(binary)).mode & 0o777, 0o755);

  const service = await readFile(unit, 'utf8');
  const expectedPath = `${dirname(binary)}:${f.env.PATH}`;
  assert.match(service, new RegExp(`WorkingDirectory=${join(f.home, '.quotahot')}`));
  assert.match(service, new RegExp(`ExecStart="${join(f.home, 'tools', 'node')}" "${binary}"`));
  assert.match(service, new RegExp(`Environment="PATH=${expectedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(service, /Environment=PORT=9000/);
  assert.match(await readFile(f.systemctlLog, 'utf8'), /--user is-enabled --quiet quotahot\.service\n--user daemon-reload\n--user enable quotahot\.service\n--user restart quotahot\.service\n/);
  assert.match(stdout, /http:\/\/localhost:9000/);
  assert.match(stdout, new RegExp(`构建产物目录：${dirname(f.source)}\n`));
});

test('生成的服务单元通过 systemd 自带的语法验证', async () => {
  const f = await fixture();
  await install([], f.env);

  const unit = join(f.home, '.config', 'systemd', 'user', 'quotahot.service');
  await exec('systemd-analyze', ['--user', 'verify', unit]);
});

test('覆盖已有安装时直接盖掉旧文件，不留备份', async () => {
  const f = await fixture();
  await install([], f.env);

  await writeFile(f.source, '#!/usr/bin/env node\nconsole.log("updated")\n');
  await chmod(f.source, 0o755);
  await install([], f.env);

  const binary = join(f.home, '.quotahot', 'bin', 'quotahot');
  const unit = join(f.home, '.config', 'systemd', 'user', 'quotahot.service');
  assert.match(await readFile(binary, 'utf8'), /updated/);
  assert.match(await readFile(unit, 'utf8'), /Description=QuotaHot/);
  await assert.rejects(access(`${binary}.quotahot-bak`), '升级不该在 bin 目录里留下备份');
  await assert.rejects(access(`${unit}.quotahot-bak`), '升级不该在 systemd 目录里留下备份');
});

test('systemd 单元会转义自定义路径里的百分号', async () => {
  const f = await fixture();
  const binDir = join(f.home, 'bin%release');
  const dataDir = join(f.home, 'data%quotahot');
  await install([], { ...f.env, QUOTAHOT_INSTALL_BIN_DIR: binDir, QUOTAHOT_DATA_DIR: dataDir });

  const unit = join(f.home, '.config', 'systemd', 'user', 'quotahot.service');
  const service = await readFile(unit, 'utf8');
  assert.match(service, /WorkingDirectory=.*data%%quotahot/);
  assert.match(service, /ExecStart=".*node" ".*bin%%release\/quotahot"/);
  assert.match(service, /Environment="PATH=.*bin%%release:/);
  assert.match(service, /Environment="QUOTAHOT_DATA_DIR=.*data%%quotahot"/);
});

test('接受带前导零的十进制端口', async () => {
  const f = await fixture();
  await install(['--port', '08'], f.env);

  const unit = join(f.home, '.config', 'systemd', 'user', 'quotahot.service');
  assert.match(await readFile(unit, 'utf8'), /Environment=PORT=08/);
});

test('拒绝会破坏 systemd 单元结构的换行路径', async () => {
  const f = await fixture();
  await assert.rejects(
    install([], { ...f.env, QUOTAHOT_DATA_DIR: `${f.home}/data\nEnvironment=INJECTED=1` }),
    (error: Error & { stderr?: string }) => {
      assert.match(error.stderr ?? '', /路径不能包含换行/);
      return true;
    },
  );
});

test('升级时 systemctl 失败会保留新文件并说明旧文件已被覆盖', async () => {
  const f = await fixture();
  const binary = join(f.home, '.quotahot', 'bin', 'quotahot');
  const unit = join(f.home, '.config', 'systemd', 'user', 'quotahot.service');
  await mkdir(dirname(binary), { recursive: true });
  await mkdir(dirname(unit), { recursive: true });
  await writeFile(binary, 'old binary\n', { mode: 0o755 });
  await writeFile(unit, 'old unit\n');

  await assert.rejects(
    install([], { ...f.env, QUOTAHOT_TEST_SYSTEMCTL_FAIL: '--user restart quotahot.service' }),
    (error: Error & { stderr?: string }) => {
      assert.match(error.stderr ?? '', /旧文件已被本次安装覆盖，无法还原/);
      return true;
    },
  );
  assert.equal(await readFile(binary, 'utf8'), await readFile(f.source, 'utf8'));
  assert.match(await readFile(unit, 'utf8'), /Description=QuotaHot/);
});

test('首次安装启动失败时移除新文件并撤销 enable', async () => {
  const f = await fixture();
  const binary = join(f.home, '.quotahot', 'bin', 'quotahot');
  const unit = join(f.home, '.config', 'systemd', 'user', 'quotahot.service');

  await assert.rejects(
    install([], {
      ...f.env,
      QUOTAHOT_TEST_SYSTEMCTL_DISABLED: '1',
      QUOTAHOT_TEST_SYSTEMCTL_FAIL: '--user restart quotahot.service',
    }),
  );
  await assert.rejects(access(binary));
  await assert.rejects(access(unit));
  assert.match(await readFile(f.systemctlLog, 'utf8'), /--user disable quotahot\.service/);
});

test('找不到构建产物时明确失败且不创建安装目录', async () => {
  const f = await fixture();
  const missing = join(f.home, 'missing-quotahot');

  await assert.rejects(
    install([], { ...f.env, QUOTAHOT_INSTALL_SOURCE: missing }),
    (error: Error & { stderr?: string }) => {
      assert.match(error.stderr ?? '', /找不到 quotahot 构建产物/);
      return true;
    },
  );
});

test('手动 systemd 模板固定包含用户安装目录的 PATH', async () => {
  const template = new URL('../quotahot.service', import.meta.url).pathname;
  const service = await readFile(template, 'utf8');

  assert.match(
    service,
    /Environment="PATH=%h\/\.quotahot\/bin:\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin"/,
  );
  assert.match(service, /ExecStart=%h\/\.quotahot\/bin\/quotahot/);
  const f = await fixture();
  const sandboxTemplate = join(f.home, 'quotahot.service');
  await writeFile(sandboxTemplate, service.replace(/^ExecStart=.*$/m, `ExecStart="${f.source}"`));
  await exec('systemd-analyze', ['--user', 'verify', sandboxTemplate]);
});

test('统一构建会在发布压缩包中携带安装脚本', async () => {
  const builder = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  assert.match(builder, /copyFileSync\('scripts\/install\.sh', join\(stage, 'install\.sh'\)\)/);
  assert.match(builder, /chmodSync\(join\(stage, 'install\.sh'\), 0o755\)/);
});
