/**
 * 每个来源在这台机器上的实际位置：内置默认值 + 配置里的覆盖值。
 *
 * 导入（import.ts）、跟随客户端读回（clientfile.ts）、写回客户端（clientsync.ts）和
 * 「本机在用」核对（inuse.ts）四处说的都是同一批文件，从前各自 join 一遍 homedir()，
 * 改一个位置要改四处、漏一处就会出现「导入读 A、同步写 B」这种自相矛盾。全部收到这里。
 *
 * 默认值每次调用现算，不做成模块级常量：homedir() 和 XDG_* 在运行期都可能变
 * （测试就是这么把路径指到临时目录的）。
 *
 * 覆盖值同样放在模块级状态里，由 server/main.ts 在启动和保存配置时灌进来，
 * 与 http.setProxy 是同一套做法——这些模块都是纯函数，没有地方能顺手接住一个 config。
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { qoderStateDbPath } from './qoder.js';
import {
  CLIENT_PATH_KEYS,
  isClientPathKey,
  type ClientPathKey,
  type ClientPaths,
} from '../shared/clientpaths.js';

let overrides: ClientPaths = {};

/**
 * 换一套覆盖值。传进来的应当是 config.normalize 收敛过的结果：
 * 这里不再校验，只认非空字符串，其余一律当成「没配，用默认」。
 */
export function setClientPaths(paths: ClientPaths | undefined): void {
  const next: ClientPaths = {};
  for (const key of CLIENT_PATH_KEYS) {
    const value = paths?.[key];
    if (typeof value === 'string' && value.trim()) next[key] = value.trim();
  }
  overrides = next;
}

/** 这个来源在本机的默认位置。用户没改过的话，这就是实际用的路径。 */
export function defaultClientPath(key: ClientPathKey): string {
  switch (key) {
    case 'cli-proxy-api':
      return join(homedir(), '.cli-proxy-api');
    case 'codex-cli':
      return join(homedir(), '.codex', 'auth.json');
    case 'claude-cli':
      return join(homedir(), '.claude', '.credentials.json');
    // OpenCode 的凭证库遵循 XDG，默认落在 ~/.local/share/opencode/auth.json
    case 'opencode':
      return join(
        process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'),
        'opencode',
        'auth.json',
      );
    case 'qoder-ide':
      return qoderStateDbPath();
    case 'qoder-cli':
      return join(process.env.QODER_CONFIG_DIR || join(homedir(), '.qoder'), '.auth', 'user');
    case 'qoder-desktop':
      return join(
        process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
        'com.qoder.app.stable',
        'auth.v1.dat',
      );
  }
}

/** 这个来源现在该读写哪个路径。 */
export function clientPath(key: ClientPathKey): string {
  return overrides[key] ?? defaultClientPath(key);
}

/** 按来源标识取路径；不是可配置来源（例如账户自己记的 sync_path）时返回空串。 */
export function clientPathOf(source: string): string {
  return isClientPathKey(source) ? clientPath(source) : '';
}

/**
 * Claude Code 记着登录邮箱的那个文件。
 *
 * 官方把它放在凭证目录的上一级（~/.claude/.credentials.json 对 ~/.claude.json），
 * 所以这里跟着凭证路径走而不是单列一个配置项：改了凭证位置的人，profile 也跟着一起搬。
 */
export function claudeProfilePath(): string {
  return join(dirname(dirname(clientPath('claude-cli'))), '.claude.json');
}
