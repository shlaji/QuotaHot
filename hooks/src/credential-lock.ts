import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';

export async function withCredentialLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lockPath = `${resolve(path)}.refresh-lock.db`;
  const database = new DatabaseSync(lockPath);
  const deadline = Date.now() + 35_000;
  try {
    for (;;) {
      try {
        database.exec('BEGIN IMMEDIATE');
        break;
      } catch (error) {
        if (!(error instanceof Error && 'errcode' in error && error.errcode === 5)) throw error;
        if (Date.now() >= deadline) throw new Error(`等待凭证刷新锁超时：${lockPath}`);
        await setTimeout(100);
      }
    }
    try {
      return await work();
    } finally {
      database.exec('ROLLBACK');
    }
  } finally {
    database.close();
  }
}
