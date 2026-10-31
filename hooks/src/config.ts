import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export type HookConfig = {
  readonly proxy: string;
  readonly noProxy: readonly string[];
  readonly accountOrder: Readonly<Record<string, readonly string[]>>;
};

export const DATA_DIR = process.env.QUOTAHOT_DATA_DIR ?? join(homedir(), '.quotahot');
export const CONFIG_PATH = join(DATA_DIR, 'config.json');
export const ACCOUNTS_DIR = join(DATA_DIR, 'accounts');

const DEFAULT_CONFIG: HookConfig = {
  accountOrder: {},
  proxy: 'http://127.0.0.1:7897',
  noProxy: [
    'localhost',
    '127.0.0.1',
    '::1',
    '10.10.0.79',
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '169.254.0.0/16',
    '100.64.0.0/10',
  ],
};

export function loadConfig(): HookConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_CONFIG;
    const record = parsed as Record<string, unknown>;
    const order = z.record(z.string(), z.unknown()).safeParse(record.accountOrder);
    const accountOrder: Record<string, readonly string[]> = {};
    if (order.success) {
      for (const [provider, value] of Object.entries(order.data)) {
        if (Array.isArray(value)) accountOrder[provider] = value.flatMap((id: unknown) =>
          typeof id === 'string' && id.trim() ? [id.trim()] : []);
      }
    }
    return {
      accountOrder,
      proxy: typeof record.proxy === 'string' ? record.proxy.trim() : DEFAULT_CONFIG.proxy,
      noProxy: Array.isArray(record.noProxy)
        ? record.noProxy.map((value) => String(value).trim()).filter(Boolean)
        : DEFAULT_CONFIG.noProxy,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}
