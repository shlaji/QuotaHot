/**
 * 把钩子装进 codex 和 OpenCode 的配置里，以及把它摘出来。
 *
 * 装的是别人的配置文件，因此只动自己那一块、改了什么逐条报出来；旧内容直接覆盖，不留备份。
 * 两边的做法不一样：
 *
 * - codex 读 `~/.codex/hooks.json`，格式与 Claude Code 的钩子配置同源（顶层 `hooks`，
 *   按事件名分组）。我们只往三个事件里各插一条命令，原有的钩子逐字保留，靠命令行里的
 *   `quotahot-hook run codex` 认出哪条是自己的，装第二遍不会插出两条。
 * - OpenCode 读插件目录里的 js/ts 文件，所以这边是**生成一个文件**，整份都是我们的。
 *   文件里写死了本可执行文件的绝对路径：钩子被拉起时的 PATH 未必包含它。
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isSea } from 'node:sea';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { opencodePlugin } from './opencode-plugin.js';

export { opencodePlugin } from './opencode-plugin.js';

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** codex 的钩子配置。事件名与 codex 0.153 的一致。 */
export const CODEX_HOOKS_PATH = join(homedir(), '.codex', 'hooks.json');
/**
 * 挂这三个事件：
 * - SessionStart：开新会话前把该换的换掉，这是切换真正能立刻生效的唯一时机。
 * - UserPromptSubmit：每次提问前看一眼，用的是缓存，通常不出网。
 * - Stop：一轮答完，会话记录里刚写下这一轮的 rate_limits，此时判定最准。
 */
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

/** codex 钩子里我们自己那条。timeout 给 20 秒：最坏情况是逐个候选账户查一次额度。 */
function codexEntry(command: string): CodexEntry {
  return { hooks: [{ type: 'command', command, timeout: 20 }] };
}

export async function installCodex(command: string): Promise<InstallReport> {
  const data = (await readJson(CODEX_HOOKS_PATH)) ?? {};
  const hooks = (data.hooks && typeof data.hooks === 'object' ? data.hooks : {}) as Record<
    string,
    CodexEntry[]
  >;
  const changes: string[] = [];

  for (const event of CODEX_EVENTS) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    const cleaned = withoutOwnHooks(list, command);
    hooks[event] = [...cleaned.entries, codexEntry(command)];
    changes.push(`${cleaned.removed ? '更新' : '新增'} ${event} 钩子`);
  }

  data.hooks = hooks;
  await writeAtomic(CODEX_HOOKS_PATH, `${JSON.stringify(data, null, 2)}\n`);
  return { changes, paths: [CODEX_HOOKS_PATH] };
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
