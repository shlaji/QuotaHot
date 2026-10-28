import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { IlinkMediaError } from './media.js';
import { InboxMediaStaging } from './media-staging.js';

export interface PreparedMediaUpload {
  readonly stagedFile: string;
  readonly rawsize: number;
  readonly rawfilemd5: string;
  readonly filesize: number;
  openPlaintext(signal?: AbortSignal): Readable;
  dispose(): Promise<void>;
}
export function encryptedMediaSize(rawsize: number): number {
  if (!Number.isSafeInteger(rawsize) || rawsize < 0) throw new IlinkMediaError('invalid_metadata');
  const padded = 16n * (BigInt(rawsize) / 16n + 1n);
  if (padded > BigInt(Number.MAX_SAFE_INTEGER)) throw new IlinkMediaError('invalid_metadata');
  return Number(padded);
}
export async function prepareMediaUpload(source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<PreparedMediaUpload> {
  const staging = new InboxMediaStaging();
  const hash = createHash('md5');
  let rawsize = 0;
  let disposed = false;
  try {
    const stagedFile = await staging.stage((async function* () {
      for await (const chunk of source) {
        if (!(chunk instanceof Uint8Array)) throw new IlinkMediaError('invalid_request');
        for (let offset = 0; offset < chunk.byteLength; offset += 65536) {
          const bytes = Buffer.from(chunk.subarray(offset, offset + 65536));
          const nextSize = rawsize + bytes.byteLength;
          encryptedMediaSize(nextSize);
          rawsize = nextSize;
          hash.update(bytes);
          yield bytes;
        }
      }
    })(), signal);
    return {
      stagedFile, rawsize, rawfilemd5: hash.digest('hex'), filesize: encryptedMediaSize(rawsize),
      openPlaintext(readSignal) {
        if (disposed) throw new IlinkMediaError('invalid_request');
        return createReadStream(stagedFile, { highWaterMark: 65536, signal: readSignal });
      },
      async dispose() {
        disposed = true;
        try { await staging.dispose(); }
        catch { throw new IlinkMediaError('upload_failed'); }
      },
    };
  } catch (error) {
    try { await staging.dispose(); }
    catch { throw new IlinkMediaError('upload_failed'); }
    if (signal?.aborted) throw new IlinkMediaError('aborted');
    if (error instanceof IlinkMediaError && (error.code === 'invalid_metadata' || error.code === 'invalid_request')) {
      throw new IlinkMediaError(error.code);
    }
    throw new IlinkMediaError('upload_failed');
  }
}
