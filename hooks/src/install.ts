/**
 * 安装和卸载 OpenCode 插件，并清理 Codex/Pi 的旧版 QuotaHot 触发器。
 *
 * 装的是别人的配置文件，因此只动自己那一块、改了什么逐条报出来；旧内容直接覆盖，不留备份。
 * OpenCode 读插件目录里的 js/ts 文件，插件中写入本可执行文件的绝对路径。
 */
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isSea } from 'node:sea';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import lockfile from 'proper-lockfile';
import { opencodePlugin } from './opencode-plugin.js';
import { piAuthPath } from './client-auth.js';
const PI_EXTENSION_MARKER = '// quotahot:pi-extension';

export { opencodePlugin } from './opencode-plugin.js';

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** 旧版 codex 钩子的配置路径。 */
export const CODEX_HOOKS_PATH = join(homedir(), '.codex', 'hooks.json');
/** 旧版集成使用的三个 Codex 事件。 */
export const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'] as const;

/** OpenCode 的插件目录候选。不同版本用过两个名字，本机已经有哪个就用哪个。 */
const OPENCODE_PLUGIN_DIRS = ['plugin', 'plugins'];
const OPENCODE_PLUGIN_FILE = 'quotahot.js';

export interface InstallReport {
  /** 装/卸了什么，逐条给用户看。 */
  changes: string[];
  /** 动过的文件。 */
  paths: string[];
}

/** 本可执行文件的绝对路径：钩子由别的进程拉起，那时的 PATH 里未必找得到 quotahot-hook。 */
export function selfCommand(): string {
  return selfInvocation().map(shellArg).join(' ');
}

export function selfInvocation(): readonly string[] {
  if (isSea()) return [process.execPath];
  const script = resolve(process.argv[1] || 'quotahot-hook');
  if (script.endsWith('.ts')) {
    const tsx = pathToFileURL(createRequire(script).resolve('tsx')).href;
    return [process.execPath, '--import', tsx, script];
  }
  return [process.execPath, script];
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 原子写：先落临时文件再改名，中途出错不会给用户留下半份配置。旧内容直接覆盖。 */
async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.quotahot-tmp`;
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

/* ── codex ─────────────────────────────────────────────────────────────── */

interface CodexEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

function isOwnCommand(candidate: string, command: string): boolean {
  if (candidate === command) return true;
  return /(?:^|[/\\])quotahot-hook(?:\.exe)?(?:['"])?\s+run\s+codex\s*$/.test(candidate);
}

function withoutOwnHooks(entries: CodexEntry[], command: string): { entries: CodexEntry[]; removed: boolean } {
  let removed = false;
  const kept: CodexEntry[] = [];
  for (const entry of entries) {
    const hooks = entry.hooks.filter((hook) => !isOwnCommand(hook.command, command));
    if (hooks.length !== entry.hooks.length) removed = true;
    if (hooks.length > 0) kept.push(hooks.length === entry.hooks.length ? entry : { ...entry, hooks });
  }
  return { entries: kept, removed };
}

export async function uninstallCodex(): Promise<InstallReport> {
  const data = await readJson(CODEX_HOOKS_PATH);
  const hooks = data?.hooks as Record<string, CodexEntry[]> | undefined;
  if (!hooks) return { changes: ['codex 那边没有装过'], paths: [] };

  const changes: string[] = [];
  const command = `${selfCommand()} run codex`;
  for (const event of CODEX_EVENTS) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    const cleaned = withoutOwnHooks(list, command);
    if (!cleaned.removed) continue;
    // 事件下没别的钩子了就把这一项也删掉，别在人家配置里留一串空数组
    if (cleaned.entries.length === 0) delete hooks[event];
    else hooks[event] = cleaned.entries;
    changes.push(`移除 ${event} 钩子`);
  }
  if (changes.length === 0) return { changes: ['codex 那边没有装过'], paths: [] };

  await writeAtomic(CODEX_HOOKS_PATH, `${JSON.stringify(data, null, 2)}\n`);
  return { changes, paths: [CODEX_HOOKS_PATH] };
}

/* ── OpenCode ──────────────────────────────────────────────────────────── */

/** 插件放哪儿：本机已经有的那个目录优先，一个都没有就按官方文档建 plugin/。 */
export async function opencodePluginPath(): Promise<string> {
  const base = join(
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'),
    'opencode',
  );
  for (const dir of OPENCODE_PLUGIN_DIRS) {
    try {
      await readdir(join(base, dir));
      return join(base, dir, OPENCODE_PLUGIN_FILE);
    } catch {
      // 这个目录还不存在，看下一个
    }
  }
  return join(base, OPENCODE_PLUGIN_DIRS[0], OPENCODE_PLUGIN_FILE);
}

export async function installOpencode(command: string | readonly string[]): Promise<InstallReport> {
  const path = await opencodePluginPath();
  const existed = (await readFile(path, 'utf8').catch(() => '')) !== '';
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, opencodePlugin(command));
  return { changes: [`${existed ? '更新' : '新增'} OpenCode 插件 ${path}`], paths: [path] };
}

export async function uninstallOpencode(): Promise<InstallReport> {
  const path = await opencodePluginPath();
  const text = await readFile(path, 'utf8').catch(() => '');
  if (!text) return { changes: ['OpenCode 那边没有装过'], paths: [] };
  if (!text.includes('quotahot:start')) {
    return { changes: [`${path} 不是本程序生成的，没有动它`], paths: [] };
  }
  await rm(path, { force: true });
  return { changes: [`已删除 ${path}`], paths: [path] };
}

export function piExtensionPath(): string {
  return join(dirname(piAuthPath()), 'extensions', 'quotahot-hook.ts');
}

async function withPiExtensionLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const release = await lockfile.lock(path, {
    realpath: false, stale: 30_000,
    retries: { retries: 10, factor: 1, minTimeout: 100, maxTimeout: 100 },
  });
  try {
    return await action();
  } finally {
    await release();
  }
}

async function readPiExtension(path: string): Promise<string | null> {
  const details = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (details === null) return null;
  if (!details.isFile()) return '';
  return readFile(path, 'utf8');
}

export async function uninstallPi(): Promise<InstallReport> {
  const path = piExtensionPath();
  const directory = await lstat(dirname(path)).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (directory === null) return { changes: ['Pi 那边没有装过'], paths: [] };
  return withPiExtensionLock(path, async () => {
    const previous = await readPiExtension(path);
    if (previous === null) return { changes: ['Pi 那边没有装过'], paths: [] };
    if (!previous.startsWith(`${PI_EXTENSION_MARKER}\n`)) return { changes: [`${path} 不是本程序生成的，没有动它`], paths: [] };
    await rm(path);
    return { changes: [`已删除 ${path}`], paths: [path] };
  });
}
