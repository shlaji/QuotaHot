/**
 * 从本机已有的客户端里导入账户。
 *
 * QuotaHot 只在自己的账户目录里读写凭证：原地使用 cli-proxy-api 或官方 CLI 的文件，
 * 意味着一次刷新失败就可能把别人的登录状态一起弄坏，而且两个进程同时刷新同一份 refresh_token
 * 时，后写的那份会让先写的失效。导入是一次性拷贝，之后两边各自独立。
 *
 * 各来源的文件格式都不一样，所以每个来源单独解析，统一收敛成 AccountInput。
 */
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  emailOf,
  findClaim,
  decodeJwt,
  saveAccount,
  tokenExpiresAt,
  type AccountInput,
} from './creds.js';
import { readClaudeCodeEmail, readJsonFile as readJson } from './clientfile.js';
import { CLI_PROXY_API_DIR } from './config.js';
import { profileOf, qoderStateDbPath, readQoderSnapshot } from './qoder.js';
import type { ImportCandidate, ImportResult, Provider } from '../shared/types.js';

/** 一处可导入的来源。 */
interface Source {
  /** 稳定标识，前端按它请求导入。 */
  id: string;
  label: string;
  path: string;
  read: (path: string) => Promise<AccountInput[]>;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** cli-proxy-api：一个目录，每个账户一个 JSON，字段名与我们自己的存储完全一致。 */
async function readCliProxyApi(dir: string): Promise<AccountInput[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const out: AccountInput[] = [];
  for (const file of files) {
    const data = await readJson(join(dir, file));
    if (!data) continue;
    const provider = str(data.type).toLowerCase();
    if (provider !== 'claude' && provider !== 'codex') continue;
    const accessToken = str(data.access_token);
    if (!accessToken) continue;
    const expired = Date.parse(str(data.expired));
    out.push({
      provider: provider as Provider,
      email: str(data.email) || emailOf(str(data.id_token) || accessToken) || file.replace(/\.json$/, ''),
      accountId: str(data.account_id),
      accessToken,
      refreshToken: str(data.refresh_token),
      idToken: str(data.id_token),
      expiresAt: Number.isNaN(expired) ? tokenExpiresAt(accessToken) : expired,
      source: 'cli-proxy-api',
      syncPath: join(dir, file),
    });
  }
  return out;
}

/** codex CLI：单文件，令牌都挂在 tokens 下面，邮箱和账户 ID 只能从 id_token 里解。 */
async function readCodexCli(path: string): Promise<AccountInput[]> {
  const data = await readJson(path);
  const tokens = data?.tokens;
  if (!tokens || typeof tokens !== 'object') return [];
  const t = tokens as Record<string, unknown>;
  const accessToken = str(t.access_token);
  if (!accessToken) return [];

  const idToken = str(t.id_token);
  const claims = decodeJwt(idToken) ?? decodeJwt(accessToken);
  const accountFromClaims = claims
    ? findClaim(claims, (k) => k === 'chatgpt_account_id' || k === 'account_id')
    : undefined;
  // 官方 CLI 没有单独的过期字段，只记录了上次刷新时刻，因此优先信 JWT 自己的 exp
  const lastRefresh = Date.parse(str(data?.last_refresh));
  const fallback = Number.isNaN(lastRefresh) ? 0 : lastRefresh + 3_600_000;

  return [
    {
      provider: 'codex',
      email: emailOf(idToken || accessToken) || 'codex-cli',
      accountId: str(t.account_id) || (typeof accountFromClaims === 'string' ? accountFromClaims : ''),
      accessToken,
      refreshToken: str(t.refresh_token),
      idToken,
      expiresAt: tokenExpiresAt(accessToken) || fallback,
      source: 'codex-cli',
      syncPath: path,
    },
  ];
}

/**
 * Claude Code：凭证在 .credentials.json 里，但那份文件不含邮箱；
 * 邮箱要去同目录之外的 ~/.claude.json 里取，取不到就退回一个占位名，
 * 让用户至少能看见这个账户，而不是整条被丢掉。
 *
 * 这个来源默认按“跟随客户端”导入：令牌续期交给 Claude Code 本身，本程序只同步它的结果。
 */
async function readClaudeCli(path: string): Promise<AccountInput[]> {
  const data = await readJson(path);
  const oauth = data?.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') return [];
  const o = oauth as Record<string, unknown>;
  const accessToken = str(o.accessToken);
  if (!accessToken) return [];

  const email = await readClaudeCodeEmail();

  const expiresAt = Number(o.expiresAt ?? 0);
  return [
    {
      provider: 'claude',
      email: email || 'claude-code',
      accessToken,
      refreshToken: str(o.refreshToken),
      expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0,
      source: 'claude-cli',
      syncPath: path,
      // Claude Code 自己会续期，我们跟着它读就行；两个程序抢同一个 refresh_token，
      // 后刷新的那次会让先前那份失效，用户下次打开 CLI 就得重新登录
      autoRefresh: false,
    },
  ];
}

/**
 * Qoder IDE：凭证在 VS Code 式的 state.vscdb 里，还被 Electron safeStorage 加密过，
 * 解析细节都在 qoder.ts。
 *
 * 和 Claude Code 一样按“跟随客户端”导入，但理由不同：Qoder 根本没给出可用的 refresh_token
 * 链路，本程序无从续期，只能在需要时回到同一个库里重读 IDE 已经续好的那份。
 *
 * 导入的同时把套餐和 userId 一并存下：Qoder 的令牌不是 JWT，这些信息解不出来，
 * 而 userId 又是之后判断“IDE 里是不是换了账号”的唯一依据。
 */
async function readQoderIde(path: string): Promise<AccountInput[]> {
  // 库不存在时抛 ENOENT，让 scanSources 显示“本机没有这个路径”，而不是一句解密失败
  await stat(path);
  const profile = profileOf(readQoderSnapshot(path));
  if (!profile.accessToken) return [];
  return [
    {
      provider: 'qoder',
      email: profile.email || profile.displayName || profile.userId || 'qoder',
      accountId: profile.userId,
      userId: profile.userId,
      plan: profile.plan,
      accessToken: profile.accessToken,
      refreshToken: '',
      expiresAt: profile.expiresAt,
      source: 'qoder-ide',
      syncPath: path,
      autoRefresh: false,
    },
  ];
}

/** 已知来源；每一处都是对应客户端在本机的固定位置，不需要用户配置。 */
export function knownSources(): Source[] {
  return [
    {
      id: 'cli-proxy-api',
      label: 'cli-proxy-api 认证目录',
      path: CLI_PROXY_API_DIR,
      read: readCliProxyApi,
    },
    {
      id: 'codex-cli',
      label: 'Codex CLI',
      path: join(homedir(), '.codex', 'auth.json'),
      read: readCodexCli,
    },
    {
      id: 'claude-cli',
      label: 'Claude Code',
      path: join(homedir(), '.claude', '.credentials.json'),
      read: readClaudeCli,
    },
    {
      id: 'qoder-ide',
      label: 'Qoder IDE',
      path: qoderStateDbPath(),
      read: readQoderIde,
    },
  ];
}

/** 扫描所有来源，只返回展示所需的信息，不含任何令牌内容。 */
export async function scanSources(): Promise<ImportCandidate[]> {
  const out: ImportCandidate[] = [];
  for (const src of knownSources()) {
    try {
      const accounts = await src.read(src.path);
      out.push({
        source: src.id,
        path: src.path,
        available: true,
        accounts: accounts.map((a) => ({
          id: `${a.provider}:${a.email}`,
          provider: a.provider,
          email: a.email,
          expiresAt: a.expiresAt,
          followClient: a.autoRefresh === false,
        })),
        error: '',
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      out.push({
        source: src.id,
        path: src.path,
        available: false,
        accounts: [],
        error: code === 'ENOENT' ? '本机没有这个路径' : String((err as Error).message ?? err),
      });
    }
  }
  return out;
}

/**
 * 把选定来源里的账户拷进账户目录。
 * 同一个 provider + email 会覆盖同名文件，因此重复导入是幂等的；
 * 没有 refresh_token 又不跟随客户端的账户会被跳过——它撑不过第一次过期，
 * 导进来只会变成一张报错的卡片。
 */
export async function importFrom(accountsDir: string, sourceIds: string[]): Promise<ImportResult> {
  const wanted = new Set(sourceIds);
  const result: ImportResult = { imported: [], skipped: [] };
  const seen = new Set<string>();

  for (const src of knownSources()) {
    if (wanted.size > 0 && !wanted.has(src.id)) continue;
    let accounts: AccountInput[];
    try {
      accounts = await src.read(src.path);
    } catch {
      continue; // 来源不存在时静默跳过；scanSources 已经把原因告诉过用户
    }

    for (const acct of accounts) {
      const id = `${acct.provider}:${acct.email}`;
      if (seen.has(id)) {
        result.skipped.push({ id, reason: '已从其他来源导入' });
        continue;
      }
      // 跟随客户端的账户本来就不用 refresh_token：过期后回原文件取新的即可
      if (!acct.refreshToken && acct.autoRefresh !== false) {
        result.skipped.push({ id, reason: '缺少 refresh_token，过期后无法续期' });
        continue;
      }
      seen.add(id);
      await saveAccount(accountsDir, acct);
      result.imported.push(id);
    }
  }
  return result;
}

/**
 * 首次启动时的自动迁移：账户目录还是空的，就把 cli-proxy-api 里的账户搬过来。
 * 这样老用户升级后不必先去界面点一次导入，行为和升级前一致。
 */
export async function importIfEmpty(accountsDir: string): Promise<ImportResult | null> {
  try {
    const existing = (await readdir(accountsDir)).filter((f) => f.endsWith('.json'));
    if (existing.length > 0) return null;
  } catch {
    /* 目录还不存在，等同于空 */
  }
  const result = await importFrom(accountsDir, ['cli-proxy-api']);
  return result.imported.length > 0 ? result : null;
}
