import { createCipheriv } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { request, type HttpResponse } from '../http.js';
import type { IlinkUploadUrlResponse } from './client.js';
import { IlinkMediaError, parseMediaKey, type MediaEndpoint } from './media.js';
import type { PreparedMediaUpload } from './media-upload-source.js';

function uploadUrl(value: string): string {
  const url = URL.parse(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash
    || /[\u0000-\u0020\u007f]/u.test(value)) throw new IlinkMediaError('invalid_request');
  return value;
}
export function resolveMediaUploadUrl(response: IlinkUploadUrlResponse,
  destination: { readonly filekey: string; readonly cdnBaseUrl?: string }): string {
  const full = response.upload_full_url?.trim();
  if (full) return uploadUrl(full);
  if (!response.upload_param || !destination.cdnBaseUrl) throw new IlinkMediaError('invalid_response');
  const base = uploadUrl(destination.cdnBaseUrl);
  const parsed = new URL(base);
  if (parsed.search) throw new IlinkMediaError('invalid_request');
  return uploadUrl(`${base}/upload?encrypted_query_param=${encodeURIComponent(response.upload_param)}&filekey=${encodeURIComponent(destination.filekey)}`);
}

export async function uploadPreparedMedia(source: PreparedMediaUpload, endpoint: MediaEndpoint,
  transport: typeof request = request): Promise<string> {
  uploadUrl(endpoint.url);
  const key = parseMediaKey(endpoint.key);
  const timeoutMs = endpoint.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new IlinkMediaError('invalid_request');
  }
  const cancellation = new AbortController();
  const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(timeoutMs),
    ...(endpoint.signal ? [endpoint.signal] : [])]);
  let plaintext: Readable | undefined;
  let response: HttpResponse | undefined;
  let production: Promise<void> | undefined;
  let exchange: Promise<string> | undefined;
  let responseCleanup: Promise<unknown> | undefined;
  const body = new PassThrough({ highWaterMark: 65536 });
  try {
    signal.throwIfAborted();
    plaintext = source.openPlaintext(signal);
    const cipher = createCipheriv('aes-128-ecb', key, null, { highWaterMark: 65536 });
    production = pipeline(plaintext, cipher, body, { signal }).catch(() => {
      cancellation.abort();
      throw new IlinkMediaError('upload_failed');
    });
    exchange = (async () => {
      response = await transport(endpoint.url, {
        method: 'POST', transport: 'undici', followRedirects: false, timeoutMs, signal,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(source.filesize) },
        bodyStream: body,
      });
      responseCleanup = Promise.allSettled([finished(response.body)]);
      if (!response.ok) throw new IlinkMediaError('upload_failed');
      const param = response.headers.get('x-encrypted-param');
      if (!param || !/^[A-Za-z0-9_%+/=-]+$/.test(param)) throw new IlinkMediaError('invalid_response');
      for await (const _chunk of response.body) { signal.throwIfAborted(); }
      signal.throwIfAborted();
      return param;
    })().catch((error: unknown) => {
      cancellation.abort();
      if (error instanceof IlinkMediaError && error.code === 'invalid_response') throw new IlinkMediaError('invalid_response');
      throw new IlinkMediaError('upload_failed');
    });
    const [param] = await Promise.all([exchange, production]);
    signal.throwIfAborted();
    return param;
  } catch (error) {
    if (endpoint.signal?.aborted) throw new IlinkMediaError('aborted');
    if (error instanceof IlinkMediaError && error.code === 'invalid_response') throw new IlinkMediaError('invalid_response');
    throw new IlinkMediaError('upload_failed');
  } finally {
    cancellation.abort();
    plaintext?.destroy();
    body.destroy();
    response?.body.destroy();
    await Promise.allSettled([production, exchange, responseCleanup]);
  }
}
