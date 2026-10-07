import { randomUUID } from 'node:crypto';
import { promises as filesystem } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { accountIdOf, emailOf } from './account-files.js';
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

export function omoAgentAuthPath(): string {
  return join(homedir(), '.omo', 'agent', 'auth.json');
}

export function piAuthPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent'), 'auth.json');
}

function piProvider(source: string): 'anthropic' | 'openai-codex' | null {
  if (source === 'pi-claude') return 'anthropic';
  if (source === 'pi-codex') return 'openai-codex';
  return null;
}

function piCredential(value: unknown, provider: 'anthropic' | 'openai-codex'): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (provider === 'openai-codex') {
    if (typeof record.accountId !== 'string' || !record.accountId.trim()) return null;
    const tokenAccountId = accountIdOf(text(record.access));
    if (tokenAccountId && tokenAccountId !== record.accountId) return null;
  }
  return record.type === 'oauth' && typeof record.access === 'string' && record.access.length > 0
    && typeof record.refresh === 'string' && record.refresh.length > 0
    && typeof record.expires === 'number' && Number.isFinite(record.expires) && record.expires > 0
    ? record : null;
}

export async function readClientTokens(source: string, path: string): Promise<ClientTokens | null> {
  const data = await readJson(path);
  if (!data) return null;
  const provider = piProvider(source);
  if (provider) {
    const credential = piCredential(data[provider], provider);
    if (!credential) return null;
    const accountId = provider === 'openai-codex' ? text(credential.accountId) : '';
    return { accessToken: text(credential.access), refreshToken: text(credential.refresh), idToken: '', accountId, email: '', expiresAt: Number(credential.expires) };
  }
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
  if (source === 'omo-agent') {
    const subscription = data['chatgpt-subscription'];
    if (subscription === null || typeof subscription !== 'object' || Array.isArray(subscription)) return null;
    const record = subscription as Record<string, unknown>;
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
  if (piProvider(source)) return piAuthPath();
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
  if (source === 'omo-agent') return [['chatgpt-subscription.type', 'oauth'], ['chatgpt-subscription.access', account.accessToken], ['chatgpt-subscription.refresh', account.refreshToken], ['chatgpt-subscription.expires', account.expiresAt], ['chatgpt-subscription.accountId', account.accountId]];
  if (source === 'claude-cli') return [['claudeAiOauth.accessToken', account.accessToken], ['claudeAiOauth.refreshToken', account.refreshToken], ['claudeAiOauth.expiresAt', account.expiresAt]];
  return [];
}

async function syncPi(account: Account, source: string, path: string, label: string): Promise<SyncResult> {
  const base = { path, source, label, created: false };
  const provider = piProvider(source);
  if (!provider) return { ...base, backupPath: '', changes: [], warning: '', error: 'Unknown Pi source' };
  if (!account.accessToken || !account.refreshToken || !Number.isFinite(account.expiresAt) || account.expiresAt <= 0
    || provider === 'openai-codex' && (!account.accountId
      || [account.idToken, account.accessToken].some((token) => accountIdOf(token) && accountIdOf(token) !== account.accountId))) {
    return { ...base, backupPath: '', changes: [], warning: '', error: 'Incomplete or conflicting Pi OAuth credentials' };
  }
  try {
    const release = await lockfile.lock(path, { realpath: false, stale: 30_000, retries: { retries: 5, factor: 1, minTimeout: 100, maxTimeout: 100 } });
    try {
      const data = await readJson(path);
      if (!data) throw new TypeError('Pi auth.json is missing or malformed');
      if (data[provider] !== undefined && !piCredential(data[provider], provider)) throw new TypeError('Pi provider has unsupported or incomplete credentials');
      const merged: Record<string, string | number> = { type: 'oauth', access: account.accessToken, refresh: account.refreshToken, expires: account.expiresAt };
      if (provider === 'openai-codex') merged.accountId = account.accountId;
      const changes = Object.entries(merged).map(([key, value]) => setPath(data, `${provider}.${key}`, value))
        .filter((change): change is ConfigChange => change !== null);
      if (changes.length === 0) return { ...base, backupPath: '', changes, warning: '', error: '' };
      const backupPath = `${path}.quotahot-bak`;
      await copyFile(path, backupPath);
      const temporary = `${path}.quotahot-tmp-${randomUUID()}`;
      try {
        await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await filesystem.rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      return { ...base, backupPath, changes, warning: '', error: '' };
    } finally {
      await release();
    }
  } catch (error) {
    return { ...base, backupPath: '', changes: [], warning: '', error: error instanceof Error ? error.message : String(error) };
  }
}

async function syncOne(account: Account, source: string, path: string, label: string): Promise<SyncResult> {
  if (piProvider(source)) return syncPi(account, source, path, label);
  const base = { path, source, label };
  if (patches(source, account).length === 0) return { ...base, created: false, backupPath: '', changes: [], warning: '', error: 'Unknown client source' };
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
  if (!account.accessToken && !only.some((source) => piProvider(source))) return [];
  const targets: Array<readonly [string, string, string]> = [];
  if (account.provider === 'codex') {
    targets.push(['codex-cli', account.syncSource === 'codex-cli' && account.syncPath ? account.syncPath : clientPath('codex-cli'), 'Codex CLI']);
    if (await exists(opencodeAuthPath())) targets.push(['opencode', opencodeAuthPath(), 'OpenCode']);
    if (await exists(omoAgentAuthPath())) targets.push(['omo-agent', omoAgentAuthPath(), 'Oh-My-OpenCode agent']);
    if (only.includes('pi-codex') || await exists(piAuthPath())) targets.push(['pi-codex', piAuthPath(), 'Pi Codex']);
  } else if (account.provider === 'claude') {
    const source = account.syncSource || account.source;
    const path = source === 'claude-cli' && account.syncPath
      ? account.syncPath
      : clientPath('claude-cli');
    targets.push(['claude-cli', path, 'Claude Code']);
    if (only.includes('pi-claude') || await exists(piAuthPath())) targets.push(['pi-claude', piAuthPath(), 'Pi Claude']);
  }
  const selected = only.length === 0 ? targets : targets.filter(([source]) => only.includes(source));
  const results: SyncResult[] = [];
  for (const [source, path, label] of selected) results.push(await syncOne(account, source, path, label));
  return results;
}
