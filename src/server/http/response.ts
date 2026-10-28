import { Readable, type Duplex } from 'node:stream';
import { createBrotliDecompress, createGunzip, createUnzip } from 'node:zlib';
import * as zlib from 'node:zlib';

export class HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Readable;
  private consumed = '';
  private read = false;
  constructor(status: number, headers: Headers, body: Readable) {
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
  get ok(): boolean { return this.status >= 200 && this.status < 300; }
  async text(): Promise<string> {
    if (this.read) return this.consumed;
    this.read = true;
    const chunks: Buffer[] = [];
    for await (const chunk of this.body) chunks.push(Buffer.from(chunk as Buffer));
    this.consumed = Buffer.concat(chunks).toString('utf8');
    return this.consumed;
  }
  async json(): Promise<unknown> { return JSON.parse(await this.text()); }
}
export function toHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(key, one);
  }
  return headers;
}
export function decode(stream: Readable, encoding: string): Readable {
  const layers = encoding.split(',').map((layer) => layer.trim().toLowerCase()).filter(Boolean).reverse();
  let out = stream;
  for (const layer of layers) {
    const decoder = decoderFor(layer);
    if (decoder === null) break;
    out.on('error', (error: Error) => decoder.destroy(error));
    out = out.pipe(decoder);
  }
  return out;
}
function decoderFor(layer: string): Duplex | null {
  switch (layer) {
    case 'gzip':
    case 'x-gzip': return createGunzip();
    case 'deflate': return createUnzip();
    case 'br': return createBrotliDecompress();
    case 'zstd': {
      const make = (zlib as unknown as Record<string, unknown>).createZstdDecompress;
      return typeof make === 'function' ? ((make as () => Duplex)()) : null;
    }
    default: return null;
  }
}
