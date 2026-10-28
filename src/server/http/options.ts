import { Readable } from 'node:stream';
import type { Audit } from './audit.js';

interface CommonOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
interface BufferedOptions extends CommonOptions {
  readonly body?: string;
  readonly bodyBytes?: Uint8Array;
  readonly bodyStream?: never;
  readonly audit?: Audit;
  readonly transport?: 'undici' | 'fetch';
  readonly followRedirects?: boolean;
}
interface StreamOptions extends CommonOptions {
  readonly bodyStream: Readable;
  readonly body?: never;
  readonly bodyBytes?: never;
  readonly audit?: never;
  readonly transport?: 'undici';
  readonly followRedirects: false;
}
export type FetchOptions = BufferedOptions | StreamOptions;
export function validateOptions(options: FetchOptions): void {
  if (!('bodyStream' in options)) return;
  if (!(options.bodyStream instanceof Readable) || options.followRedirects !== false
    || (options.transport !== undefined && options.transport !== 'undici')
    || 'body' in options || 'bodyBytes' in options || 'audit' in options) {
    throw new TypeError('Invalid streaming HTTP options');
  }
}
