/**
 * 把本程序手里的令牌写回本机客户端的凭证文件。
 *
 * 这是 clientfile.ts 的反向操作：那边负责“从客户端读进来”，这边负责“写回客户端去”。
 * 典型场景是在本程序里重新登录、或点了强制刷新之后，让 Claude Code、Codex CLI、OpenCode
 * 也用上这份新令牌，省得用户再挨个客户端登录一遍。
 *
 * 一个账户可能对应不止一个文件：Codex 的令牌同时喂给官方 CLI 和 OpenCode，只更新其中一个，
 * 另一个照样拿着过期令牌去撞额度。
 *
 * 动别人的文件是有破坏性的，所以这里立了三条规矩：
 * 1. 先备份：原文件原样复制成 <文件名>.quotahot-bak，出了问题用户自己就能还原。
 * 2. 只改令牌相关的那几个键，其余字段（模型偏好、API key 等）逐字保留。
 * 3. 逐项报出改了什么，由调用方写进日志——用户必须知道自己的配置文件被动了哪里。
 */
import { copyFile, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  fileExists,
  readJsonFile,
} from './clientfile.js';
import { clientPath } from './clientpaths.js';
import {
  readClientCredentialSnapshot,
  type ClientCredentialSnapshot,
  writeVerifiedClientSnapshot,
} from './clientfilesnapshot.js';
import {
  accountIdOf,
  emailOf,
  identityOf,
  type Account,
  type IdentityVerdict,
} from './creds.js';
import type { ConfigChange, SyncToClientResult } from '../shared/types.js';

/** 认得出格式、并且确实能写回的来源。Qoder 不在其中：它的凭证在加密的 state.vscdb 里。 */
const WRITABLE: Record<string, string> = {
  'claude-cli': 'Claude Code',
  'codex-cli': 'Codex CLI',
  opencode: 'OpenCode',
  'cli-proxy-api': 'cli-proxy-api',
};

/** 一次同步的目标文件。 */
export interface SyncTarget {
  /** 来源标识，决定按哪套字段名写。 */
  source: string;
  label: string;
  path: string;
}

export interface AutomaticSyncOptions {
  readonly onTargetValidated?: (target: SyncTarget) => Promise<void>;
}

/** OpenCode 的凭证库：遵循 XDG，默认落在 ~/.local/share/opencode/auth.json。 */
export function opencodeAuthPath(): string {
  return clientPath('opencode');
}

/**
 * 这个账户该写回哪些文件。
 *
 * Codex 写两处：官方 CLI 的 ~/.codex/auth.json 和 OpenCode 的 auth.json。本机上这两个客户端
 * 用的是同一个 ChatGPT 账号，两边的文件格式却各不相同，得分别按各自的字段名写。从 codex-cli
 * 导入的账户回到它自己的来源文件——那可能不在默认位置。
 *
 * OpenCode 那份只在文件已经存在时才算目标：没装 OpenCode 的机器上，同步一个 Codex 账户不该
 * 凭空造出一个它的凭证库。这一判断要看磁盘，所以这个函数是异步的。
 *
 * 其余 provider 仍是一对一：导入进来的账户回到它自己的来源文件，那正是它平时被读取的地方；
 * 在本程序里登录的账户没有来源文件，就落到该客户端在本机的默认位置，这也是“把这个账户
 * 交给 CLI 用”的意思。OpenCode 只认 Codex 这一路：Claude 账户不写给它。
 */
export async function syncTargetsOf(acct: Account): Promise<SyncTarget[]> {
  return targetsOf(acct, acct.provider === 'codex' ? await fileExists(opencodeAuthPath()) : false);
}

/**
 * 一批账户各自的写回目标。
 *
 * 与逐个调用 syncTargetsOf 的区别只在于：OpenCode 那个凭证文件的路径跟账户无关，
 * 这里只探一次磁盘，而不是每个 Codex 账户探一次。界面每刷新一次就要问一遍全部账户。
 */
export async function syncTargetsOfMany(
  accounts: readonly Account[],
): Promise<Map<string, SyncTarget[]>> {
  const opencodePresent = accounts.some((a) => a.provider === 'codex')
    ? await fileExists(opencodeAuthPath())
    : false;
  return new Map(accounts.map((a) => [a.id, targetsOf(a, opencodePresent)]));
}

function targetsOf(acct: Account, opencodePresent: boolean): SyncTarget[] {
  const source = acct.syncSource || acct.source;
  if (acct.provider === 'codex') {
    const cliPath = source === 'codex-cli' && acct.syncPath ? acct.syncPath : clientPath('codex-cli');
    const targets = [{ source: 'codex-cli', label: WRITABLE['codex-cli'], path: cliPath }];
    if (opencodePresent) {
      targets.push({ source: 'opencode', label: WRITABLE.opencode, path: opencodeAuthPath() });
    }
    return targets;
  }
  if (acct.syncPath && WRITABLE[source]) {
    return [{ source, label: WRITABLE[source], path: acct.syncPath }];
  }
  if (acct.provider === 'claude') {
    return [{ source: 'claude-cli', label: WRITABLE['claude-cli'], path: clientPath('claude-cli') }];
  }
  return [];
}

/** 令牌只留头尾：日志要看得出“换了一份”，但不该把完整凭证留在库里和屏幕上。 */
export function mask(token: string): string {
  if (!token) return '(空)';
  return token.length <= 16 ? `${token.slice(0, 4)}…` : `${token.slice(0, 8)}…${token.slice(-4)}`;
}

/** 字段怎么展示：令牌抹掉中段，时间戳换成人能读的写法，其余原样。 */
type Kind = 'secret' | 'time' | 'plain';

interface Patch {
  /** 配置文件里的点分路径，例如 'claudeAiOauth.accessToken'。 */
  field: string;
  value: unknown;
  kind?: Kind;
}

function show(value: unknown, kind: Kind = 'plain'): string {
  if (value === undefined || value === null || value === '') return '(无)';
  if (kind === 'secret') return mask(String(value));
  if (kind === 'time') {
    const ts = typeof value === 'number' ? value : Date.parse(String(value));
    return Number.isFinite(ts) && ts > 0 ? new Date(ts).toLocaleString() : String(value);
  }
  return String(value);
}

/**
 * 按点分路径写值，并记下真正发生变化的项。
 *
 * 手里没有的东西（空串、0）一律跳过：写回是为了补上新令牌，不是把人家原有的字段清空。
 * 值本来就相同的也不记，否则日志里全是“没变”的噪音。
 */
function apply(root: Record<string, unknown>, patches: Patch[]): ConfigChange[] {
  const changes: ConfigChange[] = [];
  for (const p of patches) {
    if (p.value === undefined || p.value === null || p.value === '' || p.value === 0) continue;
    const keys = p.field.split('.');
    let node = root;
    for (const key of keys.slice(0, -1)) {
      const next = node[key];
      if (!next || typeof next !== 'object' || Array.isArray(next)) node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    const last = keys[keys.length - 1];
    const before = node[last];
    if (before === p.value) continue;
    node[last] = p.value;
    changes.push({ field: p.field, before: show(before, p.kind), after: show(p.value, p.kind) });
  }
  return changes;
}

/** 各客户端的令牌字段。键名照抄该客户端自己的写法，不做统一。 */
function tokenPatches(source: string, acct: Account): Patch[] {
  if (source === 'claude-cli') {
    return [
      { field: 'claudeAiOauth.accessToken', value: acct.accessToken, kind: 'secret' },
      { field: 'claudeAiOauth.refreshToken', value: acct.refreshToken, kind: 'secret' },
      { field: 'claudeAiOauth.expiresAt', value: acct.expiresAt, kind: 'time' },
    ];
  }
  if (source === 'codex-cli') {
    return [
      { field: 'tokens.access_token', value: acct.accessToken, kind: 'secret' },
      { field: 'tokens.refresh_token', value: acct.refreshToken, kind: 'secret' },
      { field: 'tokens.id_token', value: acct.idToken, kind: 'secret' },
      { field: 'tokens.account_id', value: acct.accountId },
    ];
  }
  if (source === 'opencode') {
    // OpenCode 把 ChatGPT 的登录记在 openai 这一项下，字段名是它自己的短写法；
    // 它不存 id_token，这里也就不写，免得给它的解析多出一个不认识的字段。
    return [
      { field: 'openai.type', value: 'oauth' },
      { field: 'openai.access', value: acct.accessToken, kind: 'secret' },
      { field: 'openai.refresh', value: acct.refreshToken, kind: 'secret' },
      { field: 'openai.expires', value: acct.expiresAt, kind: 'time' },
      { field: 'openai.accountId', value: acct.accountId },
    ];
  }
  // cli-proxy-api：字段名与本程序自己的存储完全一致
  return [
    { field: 'type', value: acct.provider },
    { field: 'email', value: acct.email },
    { field: 'access_token', value: acct.accessToken, kind: 'secret' },
    { field: 'refresh_token', value: acct.refreshToken, kind: 'secret' },
    { field: 'id_token', value: acct.idToken, kind: 'secret' },
    { field: 'account_id', value: acct.accountId },
    { field: 'expired', value: acct.expiresAt ? new Date(acct.expiresAt).toISOString() : '', kind: 'time' },
  ];
}

/**
 * 只在令牌确实变了之后才更新的时间戳字段。
 * 单独一组是因为它每次都会变：混进 tokenPatches 里，就永远判不出“内容已经一致”。
 */
function stampPatches(source: string): Patch[] {
  // Claude Code 和 OpenCode 的文件里本来就没有这一项，别给人家凭空添一个
  if (source === 'claude-cli' || source === 'opencode') return [];
  return [{ field: 'last_refresh', value: new Date().toISOString(), kind: 'time' }];
}

/** 各客户端把令牌放在文件里的哪一层下面；空串表示就摊在顶层。 */
function scopeKeyOf(source: string): string {
  if (source === 'claude-cli') return 'claudeAiOauth';
  if (source === 'codex-cli') return 'tokens';
  if (source === 'opencode') return 'openai';
  return '';
}

/**
 * 目标文件里原本是不是另一个账户。
 *
 * 写回本身照做——“让 Claude Code 换成这个账户”是完全正当的用法——但顶掉了谁必须说清楚，
 * 否则用户下次打开 CLI 才发现登录的人变了，还找不到原因。
 */
function occupantWarning(before: Record<string, unknown>, source: string, acct: Account): string {
  const nest = scopeKeyOf(source);
  const scope = nest ? (before[nest] as Record<string, unknown> | undefined) : before;
  if (!scope || typeof scope !== 'object') return '';
  const token = String(scope.access_token ?? scope.accessToken ?? scope.access ?? '');
  const idToken = String(scope.id_token ?? scope.idToken ?? '');
  const owner = String(scope.email ?? '') || emailOf(idToken) || emailOf(token);
  if (!owner || owner.toLowerCase() === acct.email.toLowerCase()) return '';
  return `该文件原先属于 ${owner}，这次同步后该客户端会切换到 ${acct.email}`;
}

/** 原子写：先落临时文件再 rename，别人就读不到写了一半的凭证。 */
async function writeJson(path: string, data: Record<string, unknown>): Promise<void> {
  const tmp = `${path}.quotahot-tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

/**
 * 写回单个文件。
 *
 * 写不进去时不抛出：一个账户可能有好几个目标，某个文件没权限不该连累另一个，
 * 失败原因原样记在结果里，由调用方报给用户。
 */
async function syncOne(
  acct: Account,
  target: SyncTarget,
): Promise<SyncToClientResult> {
  const base = { path: target.path, source: target.source, label: target.label };
  try {
    const created = !(await fileExists(target.path));
    const data = (await readJsonFile(target.path)) ?? {};
    const warning = created ? '' : occupantWarning(data, target.source, acct);

    const changes = apply(data, tokenPatches(target.source, acct));
    if (changes.length === 0) {
      return { ...base, created: false, backupPath: '', changes: [], warning, error: '' };
    }
    changes.push(...apply(data, stampPatches(target.source)));

    let backupPath = '';
    if (created) {
      await mkdir(dirname(target.path), { recursive: true });
    } else {
      // 备份放在原文件旁边而不是本程序目录里：用户去还原时，两个文件就摆在一起
      backupPath = `${target.path}.quotahot-bak`;
      await copyFile(target.path, backupPath);
    }
    await writeJson(target.path, data);

    return { ...base, created, backupPath, changes, warning, error: '' };
  } catch (err) {
    return {
      ...base,
      created: false,
      backupPath: '',
      changes: [],
      warning: '',
      error: String((err as Error).message ?? err),
    };
  }
}

/**
 * 把账户当前的令牌写回它对应的客户端配置文件，可能不止一个。
 *
 * 返回值里逐个文件、逐项列出改了哪个字段、从什么变成了什么（令牌只给头尾），调用方据此写日志。
 * 某个文件的内容本来就一致时什么都不做，连备份都不留：重复点击不该在用户目录里堆出一串 .quotahot-bak。
 *
 * `only` 限定这次只写哪几个来源，空数组表示全写。限额切换时用得上：钩子是被某一个客户端
 * 拉起来的，用户可能只想让那一个换账户，另一个保持原样。
 */
export async function syncToClient(
  acct: Account,
  only: readonly string[] = [],
): Promise<SyncToClientResult[]> {
  const all = await syncTargetsOf(acct);
  const targets = only.length === 0 ? all : all.filter((t) => only.includes(t.source));
  if (all.length === 0) {
    throw new Error('这个账户没有可写回的客户端配置文件（Qoder 的凭证在加密的 state.vscdb 里，只能在 IDE 里登录）');
  }
  if (targets.length === 0) {
    throw new Error(`这个账户没有 ${only.join('、')} 这一路的写回目标`);
  }
  if (!acct.accessToken) throw new Error('这个账户手里没有 access_token，没什么可同步的');

  // 一个个来而不是并发：日志里的顺序就是目标列表的顺序，用户照着看得下去
  const results: SyncToClientResult[] = [];
  for (const target of targets) results.push(await syncOne(acct, target));
  return results;
}

function safeSkipMessage(target: SyncTarget, verdict: IdentityVerdict): string {
  switch (verdict.kind) {
    case 'same':
      return '';
    case 'other-id':
      return `${target.label} 的凭证属于其他账户，已跳过自动写回`;
    case 'other-email':
      return `${target.label} 的凭证邮箱与当前账户不同，已跳过自动写回`;
    case 'unknown':
      return `无法确认 ${target.label} 的凭证属于当前账户，已跳过自动写回`;
  }
}

function skippedTarget(target: SyncTarget, warning: string): SyncToClientResult {
  return {
    path: target.path,
    source: target.source,
    label: target.label,
    created: false,
    backupPath: '',
    changes: [],
    warning,
    error: '',
  };
}

async function syncSnapshot(
  acct: Account,
  target: SyncTarget,
  snapshot: ClientCredentialSnapshot,
  onTargetValidated?: (target: SyncTarget) => Promise<void>,
): Promise<SyncToClientResult> {
  const base = { path: target.path, source: target.source, label: target.label };
  const backupPath = `${target.path}.quotahot-bak`;
  const stagedBackupPath = `${backupPath}.${randomUUID()}.tmp`;
  let publishedBackupPath = '';
  try {
    const changes = apply(snapshot.data, tokenPatches(target.source, acct));
    if (changes.length === 0) {
      return { ...base, created: false, backupPath: '', changes: [], warning: '', error: '' };
    }
    changes.push(...apply(snapshot.data, stampPatches(target.source)));

    const stagedBackup = await open(stagedBackupPath, 'wx', 0o600);
    try {
      await stagedBackup.writeFile(snapshot.text, 'utf8');
      await stagedBackup.sync();
    } finally {
      await stagedBackup.close();
    }
    const written = await writeVerifiedClientSnapshot(
      target.path,
      snapshot,
      `${JSON.stringify(snapshot.data, null, 2)}\n`,
      {
        beforeWrite: onTargetValidated ? () => onTargetValidated(target) : undefined,
        publishBackup: async () => {
          let publicationError: unknown;
          try {
            await rename(stagedBackupPath, backupPath);
            publishedBackupPath = backupPath;
          } catch (error) {
            publicationError = error;
            const recoveryPath = `${backupPath}.${randomUUID()}.recovery`;
            await rename(stagedBackupPath, recoveryPath);
            publishedBackupPath = recoveryPath;
          }
          const directory = await open(dirname(target.path), 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
          if (publicationError) throw publicationError;
        },
      },
    );
    if (written === 'changed' || written === 'replaced') {
      return {
        ...skippedTarget(target, `${target.label} 的凭证已变化或不存在，已跳过自动写回`),
        backupPath: publishedBackupPath,
      };
    }
    if (written === 'failed') {
      return {
        ...base,
        created: false,
        backupPath: publishedBackupPath,
        changes: [],
        warning: '',
        error: `自动写回 ${target.label} 失败，已尝试恢复原凭证；恢复副本保留在 ${publishedBackupPath}`,
      };
    }

    return { ...base, created: false, backupPath, changes, warning: '', error: '' };
  } catch {
    return {
      ...base,
      created: false,
      backupPath: publishedBackupPath,
      changes: [],
      warning: '',
      error: `自动写回 ${target.label} 失败${publishedBackupPath ? `；恢复副本保留在 ${publishedBackupPath}` : ''}`,
    };
  } finally {
    await rm(stagedBackupPath, { force: true });
  }
}

export async function syncRefreshedTokenToClients(
  acct: Account,
  options: AutomaticSyncOptions = {},
): Promise<SyncToClientResult[]> {
  if (!acct.autoRefresh) return [];

  const results: SyncToClientResult[] = [];
  for (const target of await syncTargetsOf(acct)) {
    if (!(await fileExists(target.path))) continue;

    const snapshot = await readClientCredentialSnapshot(target.source, target.path);
    if (!snapshot) {
      results.push(skippedTarget(target, `无法读取 ${target.label} 的凭证，已跳过自动写回`));
      continue;
    }

    try {
      const tokens = snapshot.tokens;
      const ids = [tokens.accountId, accountIdOf(tokens.idToken), accountIdOf(tokens.accessToken)].filter(Boolean);
      const emails = [tokens.email, emailOf(tokens.idToken), emailOf(tokens.accessToken)]
        .filter(Boolean).map((email) => email.toLowerCase());
      const myId = acct.accountId || accountIdOf(acct.idToken) || accountIdOf(acct.accessToken);
      if (new Set(ids).size > 1 || new Set(emails).size > 1 ||
          ids.some((id) => Boolean(myId) && id !== myId) ||
          emails.some((email) => acct.email.includes('@') && email !== acct.email.toLowerCase())) {
        results.push(skippedTarget(target, `${target.label} 的令牌账户不一致，已跳过自动写回`));
        continue;
      }

      const verdict = identityOf(snapshot.tokens, acct);
      if (verdict.kind !== 'same') {
        results.push(skippedTarget(target, safeSkipMessage(target, verdict)));
        continue;
      }

      results.push(await syncSnapshot(acct, target, snapshot, options.onTargetValidated));
    } finally {
      await snapshot.close();
    }
  }
  return results;
}
