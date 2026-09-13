import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

export type AccountMemo = {
  readonly usedPercent: number | null;
  readonly resetAt: number;
  readonly checkedAt: number;
  readonly blockedUntil: number;
};

export type SwitchState = {
  readonly accounts: Record<string, AccountMemo>;
  readonly clients: Record<string, { readonly accountId: string; readonly email: string; readonly switchedAt: number }>;
};

export const STATE_PATH = join(DATA_DIR, 'switch-state.json');
const LOCK_PATH = join(DATA_DIR, 'switch.lock');
const LOCK_STALE_MS = 120_000;

export async function readState(): Promise<SwitchState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(STATE_PATH, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { accounts: {}, clients: {} };
    const record = parsed as Partial<SwitchState>;
    return {
      accounts: record.accounts && typeof record.accounts === 'object' ? record.accounts : {},
      clients: record.clients && typeof record.clients === 'object' ? record.clients : {},
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
