import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodeQoderCli } from './qoder-cli-codec.js';
import { decodeSecretValue, decryptSafeStorage, profileOf } from './qoder.js';
import { qoderClientPath } from './qoder-paths.js';
import { QoderWriteConflict, record, writePrivateFile, type QoderSession } from './qoder-session.js';
import type { QoderClient } from '../shared/qoder.js';

const IDE_KEYS = ['secret://aicoding.auth.userInfo', 'secret://aicoding.auth.userPlan', 'secret://aicoding.auth.creditUsage'] as const;

export interface QoderCapture {
  readonly session: QoderSession;
  readonly userId: string;
  readonly email: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly plan: string;
}

export async function qoderHost(): Promise<string> {
  return createHash('sha256').update(await readFile('/etc/machine-id')).update(String(process.getuid?.())).digest('hex');
}

function jsonRecord(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Qoder 认证数据无法解析，请重新登录客户端'); }
  if (!record(value)) throw new Error('Qoder 认证数据格式不受支持');
  return value;
}

function text(value: unknown): string { return typeof value === 'string' ? value : ''; }

function idePayload(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    const select = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
    const values: Record<string, string | null> = {};
    for (const key of IDE_KEYS) {
      const value = select.get(key)?.value;
      values[key] = typeof value === 'string' ? value : null;
    }
    return JSON.stringify(values);
  } finally { db.close(); }
}

export function describeQoderPayload(client: QoderClient, payload: string, path = qoderClientPath(client)): Omit<QoderCapture, 'session'> {
  if (client === 'qoder-cli') return decodeQoderCli(Buffer.from(payload, 'base64'), readFileSync(join(dirname(path), 'machine_id'), 'utf8'));
  if (client === 'qoder-ide') {
    const values = jsonRecord(payload);
    const decode = (key: string) => typeof values[key] === 'string' ? jsonRecord(decodeSecretValue(values[key])) : null;
    const profile = profileOf({ userInfo: decode(IDE_KEYS[0]), userPlan: decode(IDE_KEYS[1]), creditUsage: decode(IDE_KEYS[2]) });
    if (!profile.userId || !profile.accessToken) throw new Error('IDE 认证快照缺少用户 ID 或令牌，请重新登录');
    return { ...profile, refreshToken: '' };
  }
  const bytes = Buffer.from(payload, 'base64');
  const data = jsonRecord(decryptSafeStorage(bytes, 'Qoder App'));
  if (!record(data.user) || data.schemaVersion !== 1 || typeof data.refreshToken !== 'string' || typeof data.expiresAt !== 'string') {
    throw new Error('桌面端认证格式不受支持，请重新导入');
  }
  const userId = text(data.user.id);
  const accessToken = text(data.token);
  if (!userId || !accessToken) throw new Error('Qoder 认证缺少用户 ID 或令牌');
  const expiry = Date.parse(data.expiresAt);
  if (!Number.isFinite(expiry)) throw new Error('Qoder 认证到期时间无效');
  return { userId, email: text(data.user.email).toLowerCase(), accessToken, refreshToken: data.refreshToken, expiresAt: expiry, plan: '' };
}

export async function captureQoderSession(client: QoderClient, path = qoderClientPath(client)): Promise<QoderCapture> {
  if (process.platform !== 'linux') throw new Error('三端认证快照目前仅支持 Linux');
  const payload = await readQoderPayload(client, path);
  const profile = describeQoderPayload(client, payload, path);
  return { ...profile, session: { client, path, host: await qoderHost(), userId: profile.userId, email: profile.email, payload } };
}

export async function restoreQoderSession(session: QoderSession, path: string, expected?: string): Promise<void> {
  if (session.host !== await qoderHost()) throw new Error('认证快照来自其他机器或系统用户，请在本机重新导入');
  const profile = describeQoderPayload(session.client, session.payload, path);
  if (profile.userId !== session.userId) throw new Error('认证快照身份不一致，拒绝写入');
  await writeQoderPayload(session.client, path, session.payload, expected);
}

export async function readQoderPayload(client: QoderClient, path: string): Promise<string> {
  return client === 'qoder-ide' ? idePayload(path) : (await readFile(path)).toString('base64');
}

export async function writeQoderPayload(client: QoderClient, path: string, payload: string, expected?: string): Promise<void> {
  if (client !== 'qoder-ide') {
    await writePrivateFile(path, Buffer.from(payload, 'base64'), expected === undefined ? undefined : Buffer.from(expected, 'base64'));
    return;
  }
  const values = jsonRecord(payload);
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (expected !== undefined && idePayload(path) !== expected) throw new QoderWriteConflict();
      const write = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
      const remove = db.prepare('DELETE FROM ItemTable WHERE key = ?');
      for (const key of IDE_KEYS) {
        const value = values[key];
        if (typeof value === 'string') write.run(key, value);
        else remove.run(key);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}
