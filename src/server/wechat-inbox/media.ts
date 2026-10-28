import { createCipheriv, createDecipheriv } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { request, type HttpResponse } from '../http.js';

export type MediaKind = 'image' | 'video' | 'file' | 'voice';
export type MediaErrorCode = 'invalid_metadata' | 'invalid_key' | 'invalid_request' | 'invalid_response'
  | 'encrypt_failed' | 'decrypt_failed' | 'upload_failed' | 'download_failed' | 'aborted';
export class IlinkMediaError extends Error {
  override readonly name = 'IlinkMediaError';
  constructor(readonly code: MediaErrorCode) { super(`iLink media: ${code}`); }
}
export interface MediaMetadata {
  readonly kind: MediaKind;
  readonly fileName: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
}
export interface MediaEndpoint {
  readonly url: string;
  readonly key: unknown;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
export function mediaType(kind: unknown): 1 | 2 | 3 | 4 {
  switch (kind) {
    case 'image': return 1;
    case 'video': return 2;
    case 'file': return 3;
    case 'voice': return 4;
    default: throw new IlinkMediaError('invalid_metadata');
  }
}
export function messageItemKind(type: unknown): 'text' | MediaKind | 'protocol_event' {
  switch (type) {
    case 1: return 'text';
    case 2: return 'image';
    case 3: return 'voice';
    case 4: return 'file';
    case 5: return 'video';
    default: return 'protocol_event';
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function parseMediaMetadata(value: unknown): MediaMetadata {
  if (!record(value) || (value.kind !== 'image' && value.kind !== 'video' && value.kind !== 'file' && value.kind !== 'voice')
    || typeof value.fileName !== 'string' || typeof value.mediaType !== 'string'
    || typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0) {
    throw new IlinkMediaError('invalid_metadata');
  }
  const mime = value.mediaType.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) throw new IlinkMediaError('invalid_metadata');
  const fileName = (value.fileName.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]+/gu, '_')
    .replace(/^[.\s]+|[.\s]+$/gu, '') || 'attachment';
  const dimensions: { width?: number; height?: number; durationMs?: number } = {};
  for (const field of ['width', 'height', 'durationMs'] as const) {
    const number = value[field];
    if (number === undefined) continue;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < (field === 'durationMs' ? 0 : 1)) {
      throw new IlinkMediaError('invalid_metadata');
    }
    dimensions[field] = number;
  }
  return { kind: value.kind, fileName, mediaType: mime, sizeBytes: value.sizeBytes, ...dimensions };
}
export function parseMediaKey(value: unknown): Buffer {
  if (value instanceof Uint8Array && value.byteLength === 16) return Buffer.from(value);
  if (record(value) && typeof value.value === 'string') {
    if (value.encoding === 'hex' && /^[a-f0-9]{32}$/i.test(value.value)) return Buffer.from(value.value, 'hex');
    if (value.encoding === 'base64' && /^[A-Za-z0-9+/]{22}==$/.test(value.value)) {
      const decoded = Buffer.from(value.value, 'base64');
      if (decoded.toString('base64') === value.value) return decoded;
    }
  }
  throw new IlinkMediaError('invalid_key');
}
export function encryptMedia(bytes: Uint8Array, key: unknown): Buffer {
  const parsedKey = parseMediaKey(key);
  if (!(bytes instanceof Uint8Array)) throw new IlinkMediaError('invalid_request');
  try {
    const cipher = createCipheriv('aes-128-ecb', parsedKey, null);
    return Buffer.concat([cipher.update(bytes), cipher.final()]);
  } catch { throw new IlinkMediaError('encrypt_failed'); }
}
export function decryptMedia(bytes: Uint8Array, key: unknown): Buffer {
  const parsedKey = parseMediaKey(key);
  if (!(bytes instanceof Uint8Array)) throw new IlinkMediaError('invalid_request');
  try {
    const decipher = createDecipheriv('aes-128-ecb', parsedKey, null);
    return Buffer.concat([decipher.update(bytes), decipher.final()]);
  } catch { throw new IlinkMediaError('decrypt_failed'); }
}
export function* mediaChunks(bytes: Uint8Array): Generator<Buffer> {
  if (!(bytes instanceof Uint8Array)) throw new IlinkMediaError('invalid_request');
  for (let offset = 0; offset < bytes.byteLength; offset += 65536) {
    yield Buffer.from(bytes.subarray(offset, offset + 65536));
  }
}
function validateUrl(endpoint: Omit<MediaEndpoint, 'key'>): void {
  const url = typeof endpoint.url === 'string' ? URL.parse(endpoint.url) : null;
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash
    || /[\u0000-\u0020\u007f]/u.test(endpoint.url)
    || (endpoint.timeoutMs !== undefined && (!Number.isSafeInteger(endpoint.timeoutMs)
      || endpoint.timeoutMs < 1 || endpoint.timeoutMs > 2147483647))) throw new IlinkMediaError('invalid_request');
}
function validateEndpoint(endpoint: MediaEndpoint): Buffer {
  validateUrl(endpoint);
  return parseMediaKey(endpoint.key);
}
async function cdnRequest(endpoint: Omit<MediaEndpoint, 'key'>, transport: typeof request, bytes?: Uint8Array): Promise<HttpResponse> {
  const code = bytes === undefined ? 'download_failed' : 'upload_failed';
  try {
    endpoint.signal?.throwIfAborted();
    return await transport(endpoint.url, {
      method: bytes === undefined ? 'GET' : 'POST', followRedirects: false,
      signal: endpoint.signal, timeoutMs: endpoint.timeoutMs,
      ...(bytes === undefined ? {} : { headers: { 'Content-Type': 'application/octet-stream' }, bodyBytes: bytes }),
    });
  } catch (error) {
    if (error instanceof IlinkMediaError && error.code === 'aborted') throw error;
    throw new IlinkMediaError(endpoint.signal?.aborted ? 'aborted' : code);
  }
}
export async function* downloadPlainMedia(endpoint: Omit<MediaEndpoint, 'key'>, transport: typeof request = request): AsyncGenerator<Buffer> {
  validateUrl(endpoint);
  const response = await cdnRequest(endpoint, transport);
  const cleanup = Promise.allSettled([finished(response.body)]);
  try {
    if (endpoint.signal?.aborted) throw new IlinkMediaError('aborted');
    if (!response.ok) throw new IlinkMediaError('download_failed');
    try {
      for await (const chunk of response.body) {
        if (endpoint.signal?.aborted) throw new IlinkMediaError('aborted');
        if (!(chunk instanceof Uint8Array)) throw new IlinkMediaError('download_failed');
        for (const part of mediaChunks(chunk)) {
          if (endpoint.signal?.aborted) throw new IlinkMediaError('aborted');
          yield part;
        }
      }
    } catch (error) {
      if (error instanceof IlinkMediaError && error.code === 'aborted') throw error;
      throw new IlinkMediaError(endpoint.signal?.aborted ? 'aborted' : 'download_failed');
    }
    if (endpoint.signal?.aborted) throw new IlinkMediaError('aborted');
  } finally {
    response.body.destroy();
    await cleanup;
  }
}
export async function uploadMedia(bytes: Uint8Array, endpoint: MediaEndpoint, transport: typeof request = request): Promise<string> {
  const key = validateEndpoint(endpoint);
  const response = await cdnRequest(endpoint, transport, encryptMedia(bytes, key));
  const cleanup = Promise.allSettled([finished(response.body)]);
  try {
    if (endpoint.signal?.aborted) throw new IlinkMediaError('aborted');
    if (!response.ok) throw new IlinkMediaError('upload_failed');
    const param = response.headers.get('x-encrypted-param');
    if (!param || !/^[A-Za-z0-9_%+/=-]+$/.test(param)) throw new IlinkMediaError('invalid_response');
    return param;
  } finally {
    response.body.destroy();
    await cleanup;
  }
}
export async function* downloadMedia(endpoint: MediaEndpoint, transport: typeof request = request): AsyncGenerator<Buffer> {
  const key = validateEndpoint(endpoint);
  const response = await cdnRequest(endpoint, transport);
  const cleanup = Promise.allSettled([finished(response.body)]);
  try {
    if (endpoint.signal?.aborted) throw new IlinkMediaError('aborted');
    if (!response.ok) throw new IlinkMediaError('download_failed');
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    try {
      for await (const chunk of response.body) {
        if (endpoint.signal?.aborted) throw new IlinkMediaError('aborted');
        if (!(chunk instanceof Uint8Array)) throw new IlinkMediaError('download_failed');
        for (const part of mediaChunks(chunk)) {
          if (endpoint.signal?.aborted) throw new IlinkMediaError('aborted');
          yield* mediaChunks(decipher.update(part));
        }
      }
    } catch (error) {
      if (error instanceof IlinkMediaError && error.code === 'aborted') throw error;
      throw new IlinkMediaError(endpoint.signal?.aborted ? 'aborted' : 'download_failed');
    }
    if (endpoint.signal?.aborted) throw new IlinkMediaError('aborted');
    let final: Buffer;
    try { final = decipher.final(); }
    catch { throw new IlinkMediaError('decrypt_failed'); }
    yield* mediaChunks(final);
  } finally {
    response.body.destroy();
    await cleanup;
  }
}
