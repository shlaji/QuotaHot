import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { emailOf } from './account-files.js';
import type { Account, ConfigChange, SyncResult } from './types.js';

type ClientTokens = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string;
  readonly accountId: string;
  readonly email: string;
  readonly expiresAt: number;
};

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function opencodeAuthPath(): string {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'opencode', 'auth.json');
}

export async function readClientTokens(source: string, path: string): Promise<ClientTokens | null> {
  const data = await readJson(path);
  if (!data) return null;
  if (source === 'codex-cli') {
    const tokens = data.tokens;
    if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) return null;
    const record = tokens as Record<string, unknown>;
    const accessToken = text(record.access_token);
    return accessToken ? { accessToken, refreshToken: text(record.refresh_token), idToken: text(record.id_token), accountId: text(record.account_id), email: text(record.email), expiresAt: 0 } : null;
  }
  if (source === 'opencode') {
    const openai = data.openai;
    if (openai === null || typeof openai !== 'object' || Array.isArray(openai)) return null;
    const record = openai as Record<string, unknown>;
    const accessToken = text(record.access);
    const expiresAt = Number(record.expires ?? 0);
    return accessToken ? { accessToken, refreshToken: text(record.refresh), idToken: '', accountId: text(record.accountId), email: '', expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0 } : null;
  }
  if (source === 'claude-cli') {
    const oauth = data.claudeAiOauth;
    if (oauth === null || typeof oauth !== 'object' || Array.isArray(oauth)) return null;
    const record = oauth as Record<string, unknown>;
    const accessToken = text(record.accessToken);
    const expiresAt = Number(record.expiresAt ?? 0);
    const profile = await readJson(join(homedir(), '.claude.json'));
    const oauthAccount = profile?.oauthAccount;
    const email = oauthAccount !== null && typeof oauthAccount === 'object' && !Array.isArray(oauthAccount)
      ? text((oauthAccount as Record<string, unknown>).emailAddress)
      : '';
    return accessToken ? { accessToken, refreshToken: text(record.refreshToken), idToken: text(record.idToken), accountId: '', email, expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0 } : null;
  }
  return null;
}

export function clientPath(source: string): string {
  if (source === 'codex-cli') return join(homedir(), '.codex', 'auth.json');
  if (source === 'opencode') return opencodeAuthPath();
  if (source === 'claude-cli') return join(homedir(), '.claude', '.credentials.json');
  return '';
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function mask(value: string): string {
  return value.length <= 16 ? `${value.slice(0, 4)}…` : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function setPath(root: Record<string, unknown>, field: string, value: string | number): ConfigChange | null {
  if (value === '' || value === 0) return null;
  const keys = field.split('.');
  const leaf = keys.pop();
  if (leaf === undefined) return null;
  let node = root;
  for (const key of keys) {
    const child = node[key];
    if (child === null || typeof child !== 'object' || Array.isArray(child)) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  const before = node[leaf];
  if (before === value) return null;
  node[leaf] = value;
  const secret = /token|access|refresh/i.test(field);
  return { field, before: secret && before ? mask(String(before)) : String(before ?? '(无)'), after: secret ? mask(String(value)) : String(value) };
}

function patches(source: string, account: Account): readonly (readonly [string, string | number])[] {
  if (source === 'codex-cli') return [['tokens.access_token', account.accessToken], ['tokens.refresh_token', account.refreshToken], ['tokens.id_token', account.idToken], ['tokens.account_id', account.accountId]];
  if (source === 'opencode') return [['openai.type', 'oauth'], ['openai.access', account.accessToken], ['openai.refresh', account.refreshToken], ['openai.expires', account.expiresAt], ['openai.accountId', account.accountId]];
  return [['claudeAiOauth.accessToken', account.accessToken], ['claudeAiOauth.refreshToken', account.refreshToken], ['claudeAiOauth.expiresAt', account.expiresAt]];
}

async function syncOne(account: Account, source: string, path: string, label: string): Promise<SyncResult> {
  const base = { path, source, label };
  try {
    const created = !(await exists(path));
    const data = (await readJson(path)) ?? {};
    const beforeToken = source === 'opencode'
      ? text((data.openai as Record<string, unknown> | undefined)?.access)
      : source === 'codex-cli'
        ? text((data.tokens as Record<string, unknown> | undefined)?.access_token)
        : text((data.claudeAiOauth as Record<string, unknown> | undefined)?.accessToken);
    const owner = emailOf(beforeToken);
    const warning = owner && owner.toLowerCase() !== account.email.toLowerCase() ? `该文件原先属于 ${owner}，这次同步后该客户端会切换到 ${account.email}` : '';
    const changes = patches(source, account).map(([field, value]) => setPath(data, field, value)).filter((change): change is ConfigChange => change !== null);
    if (changes.length === 0) return { ...base, created: false, backupPath: '', changes, warning, error: '' };
    await mkdir(dirname(path), { recursive: true });
    const backupPath = created ? '' : `${path}.quotahot-bak`;
    if (backupPath) await copyFile(path, backupPath);
    const temporary = `${path}.quotahot-tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
    return { ...base, created, backupPath, changes, warning, error: '' };
  } catch (error) {
    return { ...base, created: false, backupPath: '', changes: [], warning: '', error: error instanceof Error ? error.message : String(error) };
  }
}

export async function syncToClients(account: Account, only: readonly string[]): Promise<SyncResult[]> {
  if (!account.accessToken) return [];
  const targets: Array<readonly [string, string, string]> = [];
  if (account.provider === 'codex') {
    targets.push(['codex-cli', account.syncSource === 'codex-cli' && account.syncPath ? account.syncPath : clientPath('codex-cli'), 'Codex CLI']);
    if (await exists(opencodeAuthPath())) targets.push(['opencode', opencodeAuthPath(), 'OpenCode']);
  } else if (account.provider === 'claude') {
    const source = account.syncSource || account.source;
    const path = source === 'claude-cli' && account.syncPath
      ? account.syncPath
      : clientPath('claude-cli');
    targets.push(['claude-cli', path, 'Claude Code']);
  }
  const selected = only.length === 0 ? targets : targets.filter(([source]) => only.includes(source));
  const results: SyncResult[] = [];
  for (const [source, path, label] of selected) results.push(await syncOne(account, source, path, label));
  return results;
}
