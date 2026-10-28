import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.js';
import { NotificationConfigSchema, type NotificationConfig } from './notification-schema.js';

const DEFAULT_CONFIG: NotificationConfig = {
  version: 1,
  enabled: false,
  target: null,
  authorizedAt: null,
};

export class NotificationConfigError extends Error {
  constructor() {
    super('通知配置无效或无法解析');
    this.name = 'NotificationConfigError';
  }
}

function isFileMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function readNotificationConfig(dataDir: string = DATA_DIR): Promise<NotificationConfig> {
  const path = join(dataDir, 'session-notify.json');
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (isFileMissing(error)) return DEFAULT_CONFIG;
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) throw new NotificationConfigError();
    throw error;
  }

  const parsedConfig = NotificationConfigSchema.safeParse(parsedJson);
  if (!parsedConfig.success) throw new NotificationConfigError();
  return parsedConfig.data;
}

export async function saveNotificationConfig(dataDir: string, input: unknown): Promise<NotificationConfig> {
  const parsedConfig = NotificationConfigSchema.safeParse(input);
  if (!parsedConfig.success) throw new NotificationConfigError();

  const path = join(dataDir, 'session-notify.json');
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(parsedConfig.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (!isFileMissing(error)) throw error;
    }
  }
  return parsedConfig.data;
}
