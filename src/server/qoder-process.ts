import { access, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { qoderClientPath, qoderExecutable } from './qoder-paths.js';
import type { QoderClient } from '../shared/qoder.js';

export interface QoderProcesses {
  preflight(client: QoderClient, path?: string): Promise<void>;
  stop(client: QoderClient): Promise<boolean>;
  assertStopped?(client: QoderClient): Promise<void>;
  start(client: QoderClient): Promise<void>;
}

async function running(client: QoderClient, includeChildren = false): Promise<number[]> {
  const expected = await realpath(qoderExecutable(client));
  const found: number[] = [];
  for (const item of await readdir('/proc')) {
    if (!/^\d+$/.test(item)) continue;
    try {
      const dir = `/proc/${item}`;
      if ((await stat(dir)).uid !== process.getuid?.()) continue;
      const exe = await readlink(`${dir}/exe`);
      const matches = client === 'qoder-cli' ? /^qodercli(?:-[\d.]+)?$/.test(basename(exe)) : exe === expected;
      if (!matches) continue;
      const args = (await readFile(`${dir}/cmdline`, 'utf8')).split('\0');
      if (client !== 'qoder-cli') {
        const option = args.indexOf('--user-data-dir');
        const custom = option >= 0 ? args[option + 1] : args.find((arg) => arg.startsWith('--user-data-dir='))?.slice(16);
        const defaultDir = client === 'qoder-ide' ? dirname(dirname(dirname(qoderClientPath(client)))) : dirname(qoderClientPath(client));
        if (custom && resolve(custom) !== resolve(defaultDir)) throw new Error('检测到自定义用户目录实例，请先手动关闭；本次不会关闭其他实例');
      }
      if (includeChildren || !args.some((arg) => arg.startsWith('--type='))) found.push(Number(item));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && ['ENOENT', 'ESRCH', 'EACCES'].includes(String(error.code)))) throw error;
    }
  }
  return found;
}

export const qoderProcesses: QoderProcesses = {
  async assertStopped(client) {
    if ((await running(client, true)).length) throw new Error('客户端在切换期间重新启动，已中止写入');
  },
  async preflight(client, path) {
    if (process.platform !== 'linux') throw new Error('三端手动切换目前仅支持 Linux');
    if (path && resolve(path) !== resolve(qoderClientPath(client))) throw new Error('客户端数据目录已变化，请从当前目录重新导入，避免重启错误实例');
    await access(qoderExecutable(client), constants.X_OK);
    if (client === 'qoder-cli') {
      if (process.env.QODER_PERSONAL_ACCESS_TOKEN) throw new Error('请先清除 QODER_PERSONAL_ACCESS_TOKEN；该变量会覆盖文件中的登录');
      if ((await running(client)).length) throw new Error('请先退出所有 Qoder CLI 会话，再切换账户');
    } else if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      throw new Error('服务没有桌面会话环境，无法重启客户端；请在桌面会话中运行 QuotaHot');
    }
  },
  async stop(client) {
    const pids = await running(client);
    if (client === 'qoder-cli') {
      if (pids.length) throw new Error('检测到 Qoder CLI 正在运行，请先退出');
      return false;
    }
    for (const pid of pids) {
      if ((await running(client)).includes(pid)) process.kill(pid, 'SIGTERM');
    }
    const deadline = Date.now() + 10_000;
    while ((await running(client, true)).length) {
      if (Date.now() >= deadline) throw new Error('客户端未退出，未写入凭证；请保存工作并手动关闭后重试');
      await setTimeout(100);
    }
    return pids.length > 0;
  },
  async start(client) {
    if (client === 'qoder-cli') return;
    const child = spawn(qoderExecutable(client), [], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    child.unref();
    await setTimeout(1500);
    if (!(await running(client)).length) throw new Error('客户端启动失败');
  },
};
