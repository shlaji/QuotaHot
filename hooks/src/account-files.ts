import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Account, Provider } from './types.js';

export function decodeJwt(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function findClaim(node: unknown, names: readonly string[], depth = 0): unknown {
  if (depth > 4 || node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (names.includes(key) && value !== null && value !== '') return value;
  }
  for (const value of Object.values(record)) {
    const found = findClaim(value, names, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function accountIdOf(token: string): string {
  const value = findClaim(decodeJwt(token), ['chatgpt_account_id', 'account_id']);
  return typeof value === 'string' ? value : '';
}

export function tokenAccountIdsConflict(idToken: string, accessToken: string): boolean {
  const idTokenAccount = accountIdOf(idToken);
  const accessTokenAccount = accountIdOf(accessToken);
  return Boolean(idTokenAccount && accessTokenAccount && idTokenAccount !== accessTokenAccount);
}

export function emailOf(token: string): string {
  const value = findClaim(decodeJwt(token), ['email', 'email_address']);
  return typeof value === 'string' ? value : '';
}

export function tokenExpiresAt(token: string): number {
  const expires = Number(decodeJwt(token)?.exp ?? 0);
  return Number.isFinite(expires) && expires > 0 ? expires * 1000 : 0;
}

function expiryOf(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export async function loadAccounts(directory: string): Promise<Account[]> {
  let files: readonly string[];
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
  } catch {
    return [];
  }

  const accounts: Account[] = [];
  for (const file of files) {
    const path = join(directory, file);
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      data = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const provider = String(data.type ?? '').toLowerCase();
    if (provider !== 'claude' && provider !== 'codex' && provider !== 'qoder') continue;
    const email = String(data.email ?? file);
    const idToken = String(data.id_token ?? '');
    const accessToken = String(data.access_token ?? '');
    accounts.push({
      id: `${provider}:${email}`, provider: provider as Provider, email, path,
      accountId: String(data.account_id ?? '') || accountIdOf(idToken || accessToken),
      accessToken, refreshToken: String(data.refresh_token ?? ''), idToken,
      expiresAt: expiryOf(data.expired), disabled: Boolean(data.disabled),
      plan: String(data.plan ?? ''), subscriptionEndsAt: 0,
      userId: String(data.user_id ?? ''), source: String(data.source ?? ''),
      autoRefresh: data.auto_refresh === undefined ? true : Boolean(data.auto_refresh),
      syncPath: String(data.sync_path ?? ''),
      syncSource: String(data.sync_source ?? data.source ?? ''),
    });
  }
  return accounts;
}

export async function updateAccount(account: Account): Promise<void> {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(account.path, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  data.access_token = account.accessToken;
  if (account.refreshToken) data.refresh_token = account.refreshToken;
  if (account.idToken) data.id_token = account.idToken;
  if (account.accountId) data.account_id = account.accountId;
  data.expired = new Date(account.expiresAt).toISOString();
  data.last_refresh = new Date().toISOString();
  const temporary = `${account.path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, account.path);
}

export async function reloadAccount(account: Account): Promise<Account | null> {
  const accounts = await loadAccounts(dirname(resolve(account.path)));
  return accounts.find((candidate) => resolve(candidate.path) === resolve(account.path) && candidate.id === account.id) ?? null;
}
