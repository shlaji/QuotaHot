import { Readable, Transform } from 'node:stream';
import { maskSecrets, maskText, redactCredentials, type Secrets } from '../../shared/curl.js';
import type { RequestRecord } from '../../shared/types.js';

export interface Audit {
  accountId: string;
  kind?: 'persistent' | 'gateway';
  secrets: Secrets;
  rowId?: number;
}
export interface AuditSink {
  record(accountId: string, sentAt: number, req: RequestRecord, status: number,
    durationMs: number, error: string, kind: 'persistent' | 'gateway'): number;
  update(rowId: number, error: string, kind: 'persistent' | 'gateway'): void;
  updateResponse(rowId: number, response: string, kind: 'persistent' | 'gateway'): void;
}
let sink: AuditSink | null = null;
export function setAuditSink(next: AuditSink | null): void { sink = next; }
export function noteError(audit: Audit | undefined, error: string): void {
  if (audit?.rowId === undefined || error === '') return;
  sink?.update(audit.rowId, error, audit.kind ?? 'persistent');
}
export function recordOutbound(audit: Audit, sentAt: number, req: RequestRecord, status: number,
  durationMs: number, error: string, output: string): void {
  if (!sink) return;
  const rowId = sink.record(audit.accountId, sentAt, maskSecrets(req, audit.secrets), status,
    durationMs, error, audit.kind ?? 'persistent');
  if (output !== '') sink.updateResponse(rowId, redactCredentials(maskText(output, audit.secrets)), audit.kind ?? 'persistent');
}
export function requestAudit(audit: Audit | undefined, record: RequestRecord): {
  readonly log: (status: number, error: string) => void;
  readonly response: (stream: Readable) => Readable;
} {
  const sentAt = Date.now();
  return {
    log(status, error) {
      if (!audit || !sink) return;
      audit.rowId = sink.record(audit.accountId, sentAt, maskSecrets(record, audit.secrets), status,
        Date.now() - sentAt, error, audit.kind ?? 'persistent');
    },
    response(stream) {
      const rowId = audit?.rowId;
      if (!audit || !sink || rowId === undefined) return stream;
      const target = sink;
      const secrets = audit.secrets;
      const kind = audit.kind ?? 'persistent';
      return tap(stream, (text) => target.updateResponse(rowId, redactCredentials(maskText(text, secrets)), kind));
    },
  };
}
const RESPONSE_CAP = 64 * 1024;
function tap(src: Readable, done: (text: string) => void): Readable {
  const kept: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let flushed = false;
  const flush = (): void => {
    if (flushed) return;
    flushed = true;
    const text = Buffer.concat(kept).toString('utf8');
    try { done(truncated ? `${text}\n…（响应体过长，只保留了前 ${RESPONSE_CAP / 1024} KB）` : text); }
    catch (error) { console.error(`记录响应体失败: ${String(error)}`); }
  };
  const out = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      if (size < RESPONSE_CAP) {
        const slice = chunk.subarray(0, RESPONSE_CAP - size);
        if (slice.length < chunk.length) truncated = true;
        kept.push(Buffer.from(slice));
        size += slice.length;
      } else { truncated = true; }
      callback(null, chunk);
    },
  });
  src.on('error', (error: Error) => out.destroy(error));
  src.pipe(out);
  out.on('close', () => { src.destroy(); flush(); });
  out.on('end', flush);
  return out;
}
