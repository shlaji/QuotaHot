/** 独立 SQLite 事务锁：与服务状态库无关，进程被强杀时由 OS 释放。 */
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';

export async function withCredentialLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lock = `${resolve(path)}.refresh-lock.db`;
  const db = new DatabaseSync(lock);
  const deadline = Date.now() + 35_000;
  try {
    for (;;) {
      try {
        db.exec('BEGIN IMMEDIATE');
        break;
      } catch (error) {
        if (!(error instanceof Error && 'errcode' in error && error.errcode === 5)) throw error;
        if (Date.now() >= deadline) throw new Error(`等待凭证刷新锁超时：${lock}`);
        await setTimeout(100);
      }
    }
    try {
      return await work();
    } finally {
      db.exec('ROLLBACK');
    }
  } finally {
    db.close();
  }
}
