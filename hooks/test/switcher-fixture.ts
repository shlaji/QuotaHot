import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import type { Account, UsageResult, Window } from '../src/types.js';
import type { SwitchOptions } from '../src/switcher.js';

export const home = mkdtempSync(join(tmpdir(), 'quotahot-hook-switch-'));
export const dataDir = join(home, '.quotahot');
export const accountsDir = join(dataDir, 'accounts');
export const codexAuthPath = join(home, '.codex', 'auth.json');
export const opencodeAuthPath = join(home, '.local', 'share', 'opencode', 'auth.json');
export const statePath = join(dataDir, 'switch-state.json');

process.env.HOME = home;
process.env.XDG_DATA_HOME = join(home, '.local', 'share');
process.env.QUOTAHOT_DATA_DIR = dataDir;

after(() => rmSync(home, { recursive: true, force: true }));

const switcher = await import('../src/switcher.js');
const accountFiles = await import('../src/account-files.js');

export const usageByEmail = new Map<string, readonly Window[]>();
export const availabilityByEmail = new Map<string, boolean | null>();
export const observations = { queried: [] as string[] };

export function usageWindow(name: string, usedPercent: number, resetInMs: number): Window {
  return {
    name,
    resetAt: Date.now() + resetInMs,
    usedPercent,
    windowMinutes: name === 'primary' ? 300 : 10080,
    source: 'test',
  };
}

async function usageQuery(account: Account): Promise<UsageResult> {
  observations.queried.push(account.email);
  return {
    accountId: account.id,
    provider: account.provider,
    email: account.email,
    ok: true,
    status: 200,
    error: '',
    plan: '',
    subscriptionEndsAt: null,
    userId: '',
    quotaAvailable: availabilityByEmail.get(account.email) ?? null,
    windows: usageByEmail.get(account.email) ?? [],
    endpoint: 'test',
  };
}

export function switchWithUsage(options: Partial<SwitchOptions> = {}): ReturnType<typeof switcher.switchAccount> {
  return switcher.switchAccount({ ...options, usageQuery });
}

export const exhaustionOf = switcher.exhaustionOf;
export const currentAccount = switcher.currentAccount;
export const loadAccounts = accountFiles.loadAccounts;

export function writeAccount(email: string, accessToken = `token-${email}`): void {
  mkdirSync(accountsDir, { recursive: true });
  writeFileSync(join(accountsDir, `codex-${email}.json`), JSON.stringify({
    type: 'codex',
    email,
    account_id: `acct-${email}`,
    access_token: accessToken,
    refresh_token: `refresh-${email}`,
    expired: new Date(Date.now() + 86_400_000).toISOString(),
    source: 'codex-cli',
    sync_source: 'codex-cli',
    auto_refresh: true,
  }));
}

export function setClients(email: string): void {
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(codexAuthPath, JSON.stringify({
    tokens: { access_token: `token-${email}`, account_id: `acct-${email}` },
    other: 'keep',
  }));
  mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
  writeFileSync(opencodeAuthPath, JSON.stringify({
    openai: { type: 'oauth', access: `token-${email}` },
    'opencode-go': { type: 'api', key: 'k' },
  }));
}

export function reset(): void {
  rmSync(dataDir, { recursive: true, force: true });
  usageByEmail.clear();
  availabilityByEmail.clear();
  observations.queried.length = 0;
  writeAccount('a@x.com');
  writeAccount('b@x.com');
  setClients('a@x.com');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readJson(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new TypeError(`Expected object in ${path}`);
  return parsed;
}

export function nested(path: string, ...keys: readonly string[]): unknown {
  let value: unknown = readJson(path);
  for (const key of keys) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

export function hasState(): boolean {
  return existsSync(statePath);
}
