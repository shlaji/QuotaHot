import { open, stat, type FileHandle } from 'node:fs/promises';
import { tokensOfClientData, type ClientTokens } from './clientfile.js';

type SnapshotWriteResult = 'written' | 'changed' | 'replaced' | 'failed';

export interface ClientCredentialSnapshot {
  readonly data: Record<string, unknown>;
  readonly tokens: ClientTokens;
  readonly text: string;
  readonly close: () => Promise<void>;
  readonly isCurrentPath: (path: string) => Promise<boolean>;
  readonly readCurrentText: () => Promise<string>;
  readonly writeText: (text: string) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readText(file: FileHandle): Promise<string> {
  const { size } = await file.stat();
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) throw new Error('读取客户端凭证文件时内容意外结束');
    offset += bytesRead;
  }
  return bytes.toString('utf8');
}

async function writeText(file: FileHandle, text: string): Promise<void> {
  const bytes = Buffer.from(text, 'utf8');
  await file.truncate(0);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten === 0) throw new Error('写入客户端凭证文件时未写入内容');
    offset += bytesWritten;
  }
  await file.truncate(bytes.length);
  await file.sync();
}

async function sameFile(path: string, file: FileHandle): Promise<boolean> {
  try {
    const [entry, held] = await Promise.all([stat(path), file.stat()]);
    return entry.dev === held.dev && entry.ino === held.ino;
  } catch {
    return false;
  }
}

export async function readClientCredentialSnapshot(
  source: string,
  path: string,
): Promise<ClientCredentialSnapshot | null> {
  try {
    const file = await open(path, 'r+');
    let retain = false;
    try {
      const text = await readText(file);
      const data: unknown = JSON.parse(text);
      if (!isRecord(data)) return null;
      const tokens = await tokensOfClientData(source, data);
      if (!tokens) return null;
      retain = true;
      return {
        data,
        tokens,
        text,
        close: () => file.close(),
        isCurrentPath: (currentPath) => sameFile(currentPath, file),
        readCurrentText: () => readText(file),
        writeText: (nextText) => writeText(file, nextText),
      };
    } finally {
      if (!retain) await file.close();
    }
  } catch {
    return null;
  }
}

export async function writeVerifiedClientSnapshot(
  path: string,
  snapshot: ClientCredentialSnapshot,
  nextText: string,
  options: {
    readonly beforeWrite?: () => Promise<void>;
    readonly publishBackup?: () => Promise<void>;
  } = {},
): Promise<SnapshotWriteResult> {
  const firstCheck = await snapshotWriteStatus(path, snapshot);
  if (firstCheck) return firstCheck;
  await options.beforeWrite?.();
  const secondCheck = await snapshotWriteStatus(path, snapshot);
  if (secondCheck) return secondCheck;
  await options.publishBackup?.();
  const finalCheck = await snapshotWriteStatus(path, snapshot);
  if (finalCheck) return finalCheck;
  try {
    await snapshot.writeText(nextText);
  } catch {
    await restoreClientCredentialSnapshot(snapshot);
    return 'failed';
  }
  return (await snapshot.isCurrentPath(path)) ? 'written' : 'replaced';
}

export async function restoreClientCredentialSnapshot(snapshot: ClientCredentialSnapshot): Promise<boolean> {
  try {
    await snapshot.writeText(snapshot.text);
    return true;
  } catch {
    return false;
  }
}

async function snapshotWriteStatus(
  path: string,
  snapshot: ClientCredentialSnapshot,
): Promise<'changed' | 'replaced' | null> {
  if ((await snapshot.readCurrentText()) !== snapshot.text) return 'changed';
  return (await snapshot.isCurrentPath(path)) ? null : 'replaced';
}
