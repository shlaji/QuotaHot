import { createDecipheriv } from 'node:crypto';

export interface QoderCliProfile {
  readonly userId: string;
  readonly email: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly plan: string;
}

export class QoderCliDecodeError extends Error {
  constructor(readonly code: 'machine-id' | 'format' | 'decrypt' | 'profile') {
    super(`Qoder CLI credential decode failed (${code})`);
    this.name = 'QoderCliDecodeError';
  }
}

function optionalText(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new QoderCliDecodeError('profile');
  return value;
}

export function decodeQoderCli(payload: Buffer, machineId: string): QoderCliProfile {
  const key = Buffer.from(machineId.trim().slice(0, 16), 'utf8');
  if (key.length !== 16) throw new QoderCliDecodeError('machine-id');
  const encoded = payload.toString('utf8');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new QoderCliDecodeError('format');
  }
  const encrypted = Buffer.from(encoded, 'base64');
  if (!encrypted.length || encrypted.length % 16 !== 0 || encrypted.toString('base64') !== encoded) {
    throw new QoderCliDecodeError('format');
  }
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, key);
    plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (error) {
    if (error instanceof Error) throw new QoderCliDecodeError('decrypt');
    throw error;
  } finally {
    key.fill(0);
  }
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch (error) {
    if (error instanceof Error) throw new QoderCliDecodeError('profile');
    throw error;
  } finally {
    plaintext.fill(0);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data) || !('uid' in data)) {
    throw new QoderCliDecodeError('profile');
  }
  const userId = optionalText(data.uid);
  const accessToken = optionalText('security_oauth_token' in data ? data.security_oauth_token : undefined)
    || optionalText('access_token' in data ? data.access_token : undefined);
  const expiry = 'expire_time' in data ? data.expire_time : 0;
  if (!userId.trim() || !accessToken.trim() || typeof expiry !== 'number'
    || expiry < 0 || !Number.isSafeInteger(expiry * 1000)) {
    throw new QoderCliDecodeError('profile');
  }
  return {
    userId,
    email: optionalText('email' in data ? data.email : undefined).toLowerCase(),
    accessToken,
    refreshToken: optionalText('refresh_token' in data ? data.refresh_token : undefined),
    expiresAt: expiry * 1000,
    plan: '',
  };
}
