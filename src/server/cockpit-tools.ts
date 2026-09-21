import { createDecipheriv } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountInput } from './creds.js';
import { accountIdOf, decodeJwt, emailOf, tokenExpiresAt } from './creds.js';

type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function encrypted(value: RecordValue): boolean {
  return typeof value.ciphertext === 'string' && typeof value.nonce === 'string' && typeof value.algorithm === 'string';
}

function decodeEnvelope(value: RecordValue, key: Buffer): unknown {
  if (value.version !== 1 || value.algorithm !== 'AES-256-GCM') throw new Error('不支持的 cockpit-tools 加密格式');
  const nonce = Buffer.from(text(value.nonce), 'base64');
  const ciphertext = Buffer.from(text(value.ciphertext), 'base64');
  if (nonce.length !== 12 || ciphertext.length < 17) throw new Error('cockpit-tools 加密数据格式无效');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(ciphertext.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString('utf8'));
  } catch {
    throw new Error('cockpit-tools 账户详情无法解密');
  }
}

export function decodeCockpitRecord(textValue: string, key?: Buffer): unknown {
  let value: unknown;
  try { value = JSON.parse(textValue); } catch { throw new Error('cockpit-tools 账户详情不是有效 JSON'); }
  if (!record(value)) throw new Error('cockpit-tools 账户详情格式无效');
  return encrypted(value) ? (key ? decodeEnvelope(value, key) : (() => { throw new Error('cockpit-tools 缺少解密密钥'); })()) : value;
}

function accountFromRecord(provider: 'claude' | 'codex' | 'qoder', data: RecordValue, name: string): AccountInput | undefined {
  const tokens = record(data.tokens) ? data.tokens : {};
  const rawClaude = record(data.claude_credentials_raw) ? data.claude_credentials_raw : {};
  const oauth = record(rawClaude.claudeAiOauth) ? rawClaude.claudeAiOauth : {};
  const rawQoder = record(data.auth_user_info_raw) ? data.auth_user_info_raw : {};
  const accessToken = provider === 'codex' ? text(tokens.access_token) : provider === 'claude' ? text(oauth.accessToken) : text(rawQoder.token);
  if (!accessToken) return undefined;
  const idToken = provider === 'codex' ? text(tokens.id_token) : '';
  const refreshToken = provider === 'codex' ? text(tokens.refresh_token) : provider === 'claude' ? text(oauth.refreshToken) : text(rawQoder.refreshToken);
  const claims = decodeJwt(idToken) ?? decodeJwt(accessToken);
  const email = (text(data.email) || emailOf(idToken) || emailOf(accessToken) || name).toLowerCase();
  const accountId = text(data.account_id) || accountIdOf(idToken) || accountIdOf(accessToken) || text(data.id) || text(data.user_id);
  const rawExpiry = provider === 'claude' ? Number(oauth.expiresAt ?? 0) : provider === 'qoder' ? Number(rawQoder.expireTime ?? 0) : tokenExpiresAt(accessToken) || tokenExpiresAt(idToken);
  return {
    provider,
    email,
    accountId: accountId || (claims ? text(claims.sub) : ''),
    userId: text(data.user_id),
    plan: text(data.plan_type),
    accessToken,
    refreshToken,
    idToken,
    expiresAt: Number.isFinite(rawExpiry) ? rawExpiry : 0,
    source: 'cockpit-tools',
    autoRefresh: Boolean(refreshToken),
  };
}

export async function readCockpitTools(root: string): Promise<AccountInput[]> {
  const key = Buffer.from((await readFile(join(root, 'secure-account-storage.key'), 'utf8')).trim(), 'base64');
  if (key.length !== 32) throw new Error('cockpit-tools 解密密钥格式无效');
  const providers = ['claude', 'codex', 'qoder'] as const;
  const accounts: AccountInput[] = [];
  for (const provider of providers) {
    const dir = join(root, `${provider}_accounts`);
    for (const file of (await readdir(dir)).filter((entry) => entry.endsWith('.json') && !entry.endsWith('.json.bak')).sort()) {
      try {
        const data = decodeCockpitRecord(await readFile(join(dir, file), 'utf8'), key);
        if (record(data)) {
          const account = accountFromRecord(provider, data, file.replace(/\.json$/i, ''));
          if (account) accounts.push(account);
        }
      } catch {
        continue;
      }
    }
  }
  return accounts;
}
