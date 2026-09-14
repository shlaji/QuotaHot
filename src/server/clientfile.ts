/**
 * 读取本机其他客户端的凭证文件。
 *
 * 两处都要认这些格式：导入时把账户拷进自己的目录（import.ts），以及“跟随客户端”的账户
 * 在令牌临近过期时回到原文件里取一份新的（creds.ts 的 syncFromClient）。放在同一个地方，
 * 两边就不会各写一份、各自漏掉一个字段。
 *
 * 这个模块只做“读来源 + 认字段”，不碰账户目录、也不判断令牌新旧，因此谁都可以引用它
 * 而不会与 creds.ts 形成循环依赖。认不出来的一律返回 null，由调用方决定怎么提示。
 * Qoder 的来源不是 JSON 文件而是一个加密的 SQLite 库，那部分委托给 qoder.ts。
 */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { profileOf, qoderStateDbPath, readQoderSnapshot } from './qoder.js';

/** 从客户端凭证文件里读到的令牌。字段读不到时为空串或 0，不做猜测。 */
export interface ClientTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  /**
   * 客户端自己写明的登录邮箱；只有来源文件里直接给了才填，为空不代表账户没有邮箱——
   * 令牌里能解出来的那部分交给调用方，这个模块不碰 JWT。
   */
  email: string;
  /** 客户端自己记录的到期时间，毫秒时间戳；文件没写时为 0。 */
  expiresAt: number;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 这个路径上有没有东西。判断“客户端装没装”只看文件在不在，读不读得动是下一步的事。 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function tokensOf(
  o: Record<string, unknown>,
  expiresAt: number,
  email = '',
): ClientTokens | null {
  const accessToken = str(o.access_token) || str(o.accessToken);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: str(o.refresh_token) || str(o.refreshToken),
    idToken: str(o.id_token) || str(o.idToken),
    accountId: str(o.account_id) || str(o.accountId),
    email: email || str(o.email),
    expiresAt,
  };
}

/**
 * Claude Code 当前登录的是谁。
 *
 * 凭证文件 .credentials.json 里只有令牌，邮箱记在 ~/.claude.json 的 oauthAccount 下，
 * 而 Claude 的 access_token 不是 JWT，解不出任何身份声明——判断「这个客户端是不是换了
 * 账号」时，它是唯一能作数的依据。读不到就返回空串，由调用方决定怎么办。
 */
export async function readClaudeCodeEmail(): Promise<string> {
  const profile = await readJsonFile(join(homedir(), '.claude.json'));
  const account = profile?.oauthAccount;
  if (!account || typeof account !== 'object') return '';
  return str((account as Record<string, unknown>).emailAddress);
}

/** Claude Code：令牌挂在 claudeAiOauth 下，到期时间是毫秒时间戳。 */
async function readClaudeCodeData(data: Record<string, unknown>): Promise<ClientTokens | null> {
  const oauth = data.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') return null;
  const o = oauth as Record<string, unknown>;
  const expiresAt = Number(o.expiresAt ?? 0);
  return tokensOf(
    o,
    Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0,
    await readClaudeCodeEmail(),
  );
}

async function readClaudeCodeFile(path: string): Promise<ClientTokens | null> {
  const data = await readJsonFile(path);
  return data ? readClaudeCodeData(data) : null;
}

/** Codex CLI：令牌挂在 tokens 下，文件本身不记到期时间。 */
function readCodexCliData(data: Record<string, unknown>): ClientTokens | null {
  const tokens = data.tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  return tokensOf(tokens as Record<string, unknown>, 0);
}

async function readCodexCliFile(path: string): Promise<ClientTokens | null> {
  const data = await readJsonFile(path);
  return data ? readCodexCliData(data) : null;
}

/**
 * OpenCode：ChatGPT 的登录记在 openai 这一项下，字段名是它自己的短写法，
 * 与 clientsync.ts 写回时用的那一组一一对应。它不存 id_token，因此身份只能靠
 * accountId 和 access_token 本身来认。
 */
function readOpencodeData(data: Record<string, unknown>): ClientTokens | null {
  const openai = data.openai;
  if (!openai || typeof openai !== 'object') return null;
  const o = openai as Record<string, unknown>;
  const accessToken = str(o.access);
  if (!accessToken) return null;
  const expires = Number(o.expires ?? 0);
  return {
    accessToken,
    refreshToken: str(o.refresh),
    idToken: str(o.id_token) || str(o.idToken),
    accountId: str(o.accountId),
    email: str(o.email),
    expiresAt: Number.isFinite(expires) && expires > 0 ? expires : 0,
  };
}

async function readOpencodeFile(path: string): Promise<ClientTokens | null> {
  const data = await readJsonFile(path);
  return data ? readOpencodeData(data) : null;
}

/** cli-proxy-api：字段名与我们自己的存储一致，到期时间是 ISO 串。 */
function readCliProxyApiData(data: Record<string, unknown>): ClientTokens | null {
  const expired = Date.parse(str(data.expired));
  return tokensOf(data, Number.isNaN(expired) ? 0 : expired);
}

async function readCliProxyApiFile(path: string): Promise<ClientTokens | null> {
  const data = await readJsonFile(path);
  return data ? readCliProxyApiData(data) : null;
}

/**
 * Qoder IDE：凭证不在 JSON 里，而在 VS Code 式的 state.vscdb 中，还被 safeStorage 加密过。
 * 解析细节都在 qoder.ts，这里只把结果对齐成 ClientTokens。
 *
 * Qoder 没有可用的 refresh_token 链路，令牌也不一定带 exp，因此这两项常常为空——
 * 跟随模式下每次都回到这个库里重读一遍即可，成本只是一次本地 SQLite 查询。
 */
async function readQoderIdeFile(path = qoderStateDbPath()): Promise<ClientTokens | null> {
  let profile: ReturnType<typeof profileOf>;
  try {
    profile = profileOf(readQoderSnapshot(path));
  } catch {
    return null;
  }
  if (!profile.accessToken) return null;
  return {
    accessToken: profile.accessToken,
    refreshToken: '',
    idToken: '',
    // Qoder 的 userId 就是它自己的账户标识，正好用来挡住“IDE 里换了账号”这种错配
    accountId: profile.userId,
    email: profile.email || profile.displayName,
    expiresAt: profile.expiresAt,
  };
}

/** 跟随客户端时该盯着哪个文件。 */
export interface FollowSource {
  /** 来源标识，决定 path 怎么解析。 */
  source: string;
  /** 客户端的名字，报错时要说给用户听。 */
  label: string;
  path: string;
}

/**
 * 这个账户要跟随的是本机哪个客户端文件。
 *
 * 「跟随客户端」跟随的是**这台机器上那个客户端现在的登录**，所以位置按 provider 定：
 * Claude 是 ~/.claude/.credentials.json，Codex 是 ~/.codex/auth.json，Qoder 是它的
 * state.vscdb。只有来源本身就是这些客户端时才回 syncPath——它可能不在默认位置。
 *
 * cli-proxy-api 不算：它是另一个程序的账户目录，一个账户一个文件，拿它去核对等于拿这个账户
 * 自己的副本跟自己比，永远一致，校验就成了摆设。要跟随的是真正的客户端，不是导入来源。
 *
 * 与 clientsync.ts 的 syncTargetsOf 是一对：那边决定「令牌写回哪里」，这边决定「从哪里读」。
 * 认不出的 provider 返回 null，由调用方告诉用户没有可跟随的客户端。
 */
export function followSourceOf(
  provider: string,
  source: string,
  syncPath: string,
): FollowSource | null {
  if (syncPath && (source === 'claude-cli' || source === 'codex-cli')) {
    return { source, label: CLIENT_LABELS[source], path: syncPath };
  }
  if (provider === 'claude') {
    return {
      source: 'claude-cli',
      label: CLIENT_LABELS['claude-cli'],
      path: join(homedir(), '.claude', '.credentials.json'),
    };
  }
  if (provider === 'codex') {
    return {
      source: 'codex-cli',
      label: CLIENT_LABELS['codex-cli'],
      path: join(homedir(), '.codex', 'auth.json'),
    };
  }
  if (provider === 'qoder') {
    return { source: 'qoder-ide', label: CLIENT_LABELS['qoder-ide'], path: syncPath || qoderStateDbPath() };
  }
  return null;
}

/**
 * 各客户端在界面和日志里的名字。
 * 认得出格式的都列在这儿，包括不会被跟随的 OpenCode——「本机在用」的标记要报它的名字。
 */
export const CLIENT_LABELS: Record<string, string> = {
  'claude-cli': 'Claude Code',
  'codex-cli': 'Codex CLI',
  opencode: 'OpenCode',
  'qoder-ide': 'Qoder IDE',
};

/** 按来源标识挑解析方式；来源不认识时返回 null。 */
export async function readClientTokens(
  source: string,
  path: string,
): Promise<ClientTokens | null> {
  if (source === 'claude-cli') return readClaudeCodeFile(path);
  if (source === 'codex-cli') return readCodexCliFile(path);
  if (source === 'opencode') return readOpencodeFile(path);
  if (source === 'cli-proxy-api') return readCliProxyApiFile(path);
  if (source === 'qoder-ide') return readQoderIdeFile(path);
  return null;
}

export async function tokensOfClientData(
  source: string,
  data: Record<string, unknown>,
): Promise<ClientTokens | null> {
  if (source === 'claude-cli') return readClaudeCodeData(data);
  if (source === 'codex-cli') return readCodexCliData(data);
  if (source === 'opencode') return readOpencodeData(data);
  if (source === 'cli-proxy-api') return readCliProxyApiData(data);
  return null;
}
