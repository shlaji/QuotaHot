import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isQoderClient, type QoderClient } from '../shared/qoder.js';

export interface QoderSession {
  readonly client: QoderClient;
  readonly path: string;
  readonly host: string;
  readonly userId: string;
  readonly email: string;
  readonly payload: string;
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseQoderSession(value: unknown): QoderSession {
  if (!record(value) || !isQoderClient(value.client) || typeof value.path !== 'string' ||
      typeof value.host !== 'string' || typeof value.userId !== 'string' || !value.userId ||
      typeof value.email !== 'string' || typeof value.payload !== 'string' || !value.payload) {
    throw new Error('Qoder 客户端认证快照不完整，请重新导入');
  }
  return { client: value.client, path: value.path, host: value.host, userId: value.userId,
    email: value.email, payload: value.payload };
}

export async function readQoderSessions(path: string): Promise<Partial<Record<QoderClient, QoderSession>>> {
  const data: unknown = JSON.parse(await readFile(path, 'utf8'));
  const result: Partial<Record<QoderClient, QoderSession>> = {};
  if (!record(data) || !record(data.qoder_sessions)) return result;
  for (const [client, value] of Object.entries(data.qoder_sessions)) {
    if (!isQoderClient(client)) continue;
    const session = parseQoderSession(value);
    if (session.client !== client) throw new Error('Qoder 快照客户端类型不一致');
    result[client] = session;
  }
  return result;
}

export class QoderWriteConflict extends Error {
  constructor() { super('认证文件已被其他进程更新，未覆盖新内容'); }
}

export async function writePrivateFile(path: string, content: string | Buffer, expected?: Buffer): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(tmp, 'wx', 0o600);
    try { await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
    if (expected) {
      if (!readFileSync(path).equals(expected)) throw new QoderWriteConflict();
      renameSync(tmp, path);
    } else await rename(tmp, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await unlink(tmp).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    });
  }
}
