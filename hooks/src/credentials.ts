import { fetch } from 'undici';
import { accountIdOf, emailOf, reloadAccount, tokenAccountIdsConflict, tokenExpiresAt, updateAccount } from './account-files.js';
import { readClientTokens } from './client-auth.js';
import { withCredentialLock } from './credential-lock.js';
import { claudeHeaders } from './headers.js';
import { dispatcherFor, type NetworkConfig } from './network.js';
import type { Account } from './types.js';

const REFRESH_MARGIN_MS = 10 * 60_000;

function fresh(account: Account): boolean {
  return account.expiresAt - Date.now() > REFRESH_MARGIN_MS;
}

function apply(account: Account, updated: Account): void {
  account.accessToken = updated.accessToken;
  account.refreshToken = updated.refreshToken;
  account.idToken = updated.idToken;
  account.accountId = updated.accountId;
  account.expiresAt = updated.expiresAt;
}

async function followClient(account: Account): Promise<boolean> {
  if (fresh(account)) return true;
  if (!account.syncPath) return false;
  const tokens = await readClientTokens(account.syncSource || account.source, account.syncPath);
  if (!tokens || tokens.accessToken === account.accessToken) return false;
  const expiresAt = tokens.expiresAt || tokenExpiresAt(tokens.accessToken);
  if (expiresAt > 0 && expiresAt <= Date.now()) return false;
  const idToken = tokens.idToken || account.idToken;
  if (tokenAccountIdsConflict(idToken, tokens.accessToken)) return false;
  const accountId = tokens.accountId || accountIdOf(tokens.idToken || tokens.accessToken);
  const email = tokens.email || emailOf(tokens.idToken || tokens.accessToken);
  const sameId = Boolean(accountId && account.accountId && accountId === account.accountId);
  const comparableEmail = email.includes('@') && account.email.includes('@');
  if ((accountId && account.accountId && accountId !== account.accountId)
    || (comparableEmail && email.trim().toLowerCase() !== account.email.trim().toLowerCase())
    || (!sameId && !comparableEmail)) return false;
  account.accessToken = tokens.accessToken;
  account.refreshToken = tokens.refreshToken || account.refreshToken;
  account.idToken = idToken;
  account.accountId = account.accountId || accountId;
  account.expiresAt = expiresAt || Date.now() + 60 * 60_000;
  await updateAccount(account);
  return true;
}

async function oauthRefresh(account: Account, network: NetworkConfig): Promise<boolean> {
  if (!account.refreshToken) return false;
  const claude = account.provider === 'claude';
  const url = claude ? 'https://platform.claude.com/v1/oauth/token' : 'https://auth.openai.com/oauth/token';
  const body = claude
    ? JSON.stringify({ grant_type: 'refresh_token', refresh_token: account.refreshToken, client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e' })
    : new URLSearchParams({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', grant_type: 'refresh_token', refresh_token: account.refreshToken, scope: 'openid profile email' }).toString();
  const dispatcher = dispatcherFor(url, network);
  try {
    const response = await fetch(url, {
      method: 'POST', body, dispatcher, signal: AbortSignal.timeout(30_000), redirect: 'error',
      headers: claude ? claudeHeaders('') : { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const record = payload as Record<string, unknown>;
    const accessToken = String(record.access_token ?? '');
    if (!accessToken) return false;
    const idToken = String(record.id_token ?? account.idToken);
    const replacementId = accountIdOf(accessToken) || accountIdOf(idToken);
    if (tokenAccountIdsConflict(idToken, accessToken)
      || (account.accountId && replacementId && replacementId !== account.accountId)) return false;
    account.accessToken = accessToken;
    account.refreshToken = String(record.refresh_token ?? account.refreshToken);
    account.idToken = idToken;
    account.accountId = account.accountId || replacementId;
    account.expiresAt = Date.now() + Number(record.expires_in ?? 3600) * 1000;
    await updateAccount(account);
    return true;
  } catch {
    return false;
  } finally {
    await dispatcher.destroy();
  }
}

export async function ensureFresh(account: Account, network: NetworkConfig): Promise<boolean> {
  if (fresh(account)) return true;
  return withCredentialLock(account.path, async () => {
    const latest = await reloadAccount(account);
    if (!latest || latest.id !== account.id
      || (account.accountId && latest.accountId !== account.accountId)) return false;
    if (fresh(latest)) {
      apply(account, latest);
      return true;
    }
    const renewed = latest.autoRefresh ? await oauthRefresh(latest, network) : await followClient(latest);
    if (renewed) apply(account, latest);
    return renewed;
  }).catch(() => false);
}
