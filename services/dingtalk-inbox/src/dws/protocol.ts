import { StringDecoder } from 'node:string_decoder';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type ReadyInfo = { readonly eventKey: string; readonly busPid: number; readonly subscriptionId: string };
export type ExitReason = 'limit' | 'timeout' | 'signal' | 'bus_shutdown';

function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return typeof value === 'object' && Object.values(value).every(isJson);
}

export function parseJson(text: string): JsonValue {
  const value: unknown = JSON.parse(text);
  if (!isJson(value)) throw new SyntaxError('Invalid JSON value');
  return value;
}

export class Lines {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  constructor(private readonly onLine: (line: string) => void) {}
  write(chunk: Buffer) {
    this.pending += this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/, '');
      this.pending = this.pending.slice(newline + 1);
      this.onLine(line);
    }
  }
  end() {
    this.pending += this.decoder.end();
    if (this.pending.length > 0) this.onLine(this.pending);
    this.pending = '';
  }
}

export function parseReady(line: string): ReadyInfo | null {
  const match = /^\[event\] ready event_key=([\w.-]+) bus_pid=([1-9]\d*) subscribe_id=([\w.-]+)$/.exec(line);
  if (!match) return null;
  const [, eventKey, pid, subscriptionId] = match;
  const busPid = Number(pid);
  if (!Number.isSafeInteger(busPid)) return null;
  return { eventKey, busPid, subscriptionId };
}

export function parseExitReason(line: string): ExitReason | null {
  const match = /^\[event\] exited — received \d+ event\(s\) in \S+ \(reason: (limit|timeout|signal|bus_shutdown)\)$/.exec(line);
  const reason = match?.[1];
  if (reason === 'limit' || reason === 'timeout' || reason === 'signal' || reason === 'bus_shutdown') return reason;
  return null;
}

export function safeOsCode(error: Error): string | null {
  if (!('code' in error)) return null;
  const code = error.code;
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EPIPE' ? code : null;
}
