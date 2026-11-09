import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';
import type { OmoIdentity } from './omo-auth.js';

export type AccountMemo = {
  readonly usedPercent: number | null;
  readonly resetAt: number;
  readonly checkedAt: number;
  readonly blockedUntil: number;
};

export type QuotaCheckOutcome = 'switched' | 'available' | 'no_candidate' | 'network_error' | 'check_failed';

export type QuotaCheckReceipt = {
  readonly provider: 'codex' | 'claude';
  readonly completedAt: number;
  readonly outcome: QuotaCheckOutcome;
  readonly switched: boolean;
  readonly latestData: boolean;
  readonly waitUntil: number;
};

export type SwitchState = {
  readonly accounts: Record<string, AccountMemo>;
  readonly clients: Record<string, {
    readonly accountId: string;
    readonly email: string;
    readonly switchedAt: number;
    readonly omoChange?: { readonly from: OmoIdentity; readonly to: OmoIdentity };
  }>;
  readonly lastQuotaCheck?: QuotaCheckReceipt;
};

export const STATE_PATH = join(DATA_DIR, 'switch-state.json');
const LOCK_PATH = join(DATA_DIR, 'switch.lock');
const LOCK_STALE_MS = 120_000;

export async function readState(): Promise<SwitchState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(STATE_PATH, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { accounts: {}, clients: {} };
    const record = parsed as Partial<SwitchState>;
    const check = record.lastQuotaCheck;
    const validCheck = check && (check.provider === 'codex' || check.provider === 'claude') &&
      Number.isFinite(check.completedAt) && Number.isFinite(check.waitUntil) && typeof check.switched === 'boolean' &&
      typeof check.latestData === 'boolean' && ['switched', 'available', 'no_candidate', 'network_error', 'check_failed'].includes(check.outcome);
    return {
      accounts: record.accounts && typeof record.accounts === 'object' ? record.accounts : {},
      clients: record.clients && typeof record.clients === 'object' ? record.clients : {},
      ...(validCheck ? { lastQuotaCheck: check } : {}),
    };
  } catch {
    return { accounts: {}, clients: {} };
  }
}

export async function writeState(state: SwitchState): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STATE_PATH}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, STATE_PATH);
}

async function lockAge(): Promise<number | null> {
  try {
    return Date.now() - (await stat(LOCK_PATH)).mtimeMs;
  } catch {
    return null;
  }
}

export async function withSwitchLock<T>(work: () => Promise<T>): Promise<T | null> {
  await mkdir(DATA_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(LOCK_PATH, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
      break;
    } catch {
      const age = await lockAge();
      if (age !== null && age < LOCK_STALE_MS) return null;
      await rm(LOCK_PATH, { force: true });
      if (attempt === 1) return null;
    }
  }
  try {
    return await work();
  } finally {
    await rm(LOCK_PATH, { force: true });
  }
}

export async function waitForSwitchLock<T>(work: () => Promise<T>): Promise<T | null> {
  await mkdir(DATA_DIR, { recursive: true });
  let changed = false;
  let expired = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  const watcher = watch(DATA_DIR, (_event, name) => {
    if (name !== null && name.toString() !== 'switch.lock') return;
    changed = true;
    wake?.();
  });
  watcher.on('error', (error) => { failure = error; wake?.(); });
  const timer = setTimeout(() => { expired = true; wake?.(); }, 110_000);
  try {
    while (!expired) {
      if (failure) throw failure;
      changed = false;
      const result = await withSwitchLock(work);
      if (result !== null) return result;
      const age = await lockAge();
      if (age === null) continue;
      if (!changed && !expired && !failure) {
        await new Promise<void>((resolve) => {
          const staleTimer = setTimeout(resolve, Math.max(1, Math.ceil(LOCK_STALE_MS - age)));
          wake = () => { clearTimeout(staleTimer); resolve(); };
        });
        wake = undefined;
      }
    }
    if (failure) throw failure;
    return null;
  } finally {
    clearTimeout(timer);
    watcher.close();
  }
}
