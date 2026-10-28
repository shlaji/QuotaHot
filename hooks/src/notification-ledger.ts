import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import {
  NotificationCompletionLedgerSchema,
  NotificationLedgerFileSchema,
  type NotificationCompletionLedgerRecord,
  type NotificationLedgerFile,
} from './notification-schema.js';

export type NotificationClaim =
  | { readonly kind: 'claimed'; readonly record: NotificationCompletionLedgerRecord }
  | { readonly kind: 'existing'; readonly record: NotificationCompletionLedgerRecord };

export class NotificationLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationLedgerError';
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function ledgerPath(dataDir: string): string {
  return join(dataDir, 'session-notify-ledger.json');
}

async function withLedgerLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  await writeFile(lockPath, '', { encoding: 'utf8', mode: 0o600, flag: 'a' });
  const release = await lockfile.lock(lockPath, {
    realpath: false,
    stale: 30_000,
    retries: { retries: 10, factor: 1, minTimeout: 20, maxTimeout: 20 },
  });
  try {
    return await work();
  } finally {
    await release();
  }
}

async function readLedger(path: string): Promise<NotificationLedgerFile> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (isCode(error, 'ENOENT')) return { version: 1, records: [] };
    throw error;
  }

  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) throw new NotificationLedgerError('通知 ledger JSON 无效');
    throw error;
  }
  const parsed = NotificationLedgerFileSchema.safeParse(input);
  if (!parsed.success) throw new NotificationLedgerError('通知 ledger 结构无效');
  return parsed.data;
}

async function writeLedger(path: string, ledger: NotificationLedgerFile): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isCode(error, 'ESRCH')) return false;
    if (isCode(error, 'EPERM')) return true;
    throw error;
  }
}

export async function claimNotification(
  dataDir: string,
  candidate: NotificationCompletionLedgerRecord,
): Promise<NotificationClaim> {
  const path = ledgerPath(dataDir);
  return withLedgerLock(path, async () => {
    const ledger = await readLedger(path);
    const existing = ledger.records.find((record) => record.completionKey === candidate.completionKey);
    if (existing) {
      if (existing.state !== 'in_progress' || isProcessAlive(existing.ownerPid)) {
        return { kind: 'existing', record: existing };
      }
      const unknownRecord = NotificationCompletionLedgerSchema.parse({
        ...existing,
        state: 'unknown',
        reason: '发送进程已退出，投递结果未知',
        updatedAt: new Date().toISOString(),
      });
      const records = ledger.records.map((record) => record.completionKey === candidate.completionKey ? unknownRecord : record);
      await writeLedger(path, { version: 1, records });
      return { kind: 'existing', record: unknownRecord };
    }

    const claimed = NotificationCompletionLedgerSchema.parse({
      ...candidate,
      ownerPid: process.pid,
      state: 'in_progress',
      sentParts: [],
      updatedAt: new Date().toISOString(),
    });
    await writeLedger(path, { version: 1, records: [...ledger.records, claimed] });
    return { kind: 'claimed', record: claimed };
  });
}

export async function saveNotificationRecord(
  dataDir: string,
  candidate: NotificationCompletionLedgerRecord,
): Promise<void> {
  const record = NotificationCompletionLedgerSchema.parse(candidate);
  const path = ledgerPath(dataDir);
  await withLedgerLock(path, async () => {
    const ledger = await readLedger(path);
    const exists = ledger.records.some((item) => item.completionKey === record.completionKey);
    if (!exists) throw new NotificationLedgerError('通知 ledger 记录不存在');
    const records = ledger.records.map((item) => item.completionKey === record.completionKey ? record : item);
    await writeLedger(path, { version: 1, records });
  });
}
