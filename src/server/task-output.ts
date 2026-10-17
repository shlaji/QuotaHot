import { StringDecoder } from 'node:string_decoder';

export const TASK_OUTPUT_LIMIT = 64 * 1024;
export const TASK_OUTPUT_OMISSION = '\n[... output omitted ...]\n';
const HEAD_LIMIT = 16 * 1024;
const TAIL_LIMIT = TASK_OUTPUT_LIMIT - HEAD_LIMIT - Buffer.byteLength(TASK_OUTPUT_OMISSION);

function decode(value: Buffer, finalize: boolean): string {
  const decoder = new StringDecoder('utf8');
  return decoder.write(value) + (finalize ? decoder.end() : '');
}

function decodePrefix(value: Buffer, limit: number, finalize: boolean): string {
  const bytes = Buffer.from(decode(value, finalize));
  if (bytes.length <= limit) return bytes.toString('utf8');
  let end = limit;
  while (end > 0) {
    const byte = bytes[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end--;
  }
  return bytes.toString('utf8', 0, end);
}

function decodeSuffix(value: Buffer, limit: number, finalize: boolean): string {
  const bytes = Buffer.from(decode(value, finalize));
  if (bytes.length <= limit) return bytes.toString('utf8');
  let start = bytes.length - limit;
  while (start < bytes.length) {
    const byte = bytes[start];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    start++;
  }
  return bytes.toString('utf8', start);
}

class RetainedOutput {
  private readonly buffer = Buffer.alloc(TASK_OUTPUT_LIMIT);
  private bytes = 0;
  private cursor = 0;
  private truncated = false;

  append(chunk: Buffer): void {
    let offset = 0;
    if (!this.truncated) {
      offset = Math.min(chunk.length, TASK_OUTPUT_LIMIT - this.bytes);
      chunk.copy(this.buffer, this.bytes, 0, offset);
      this.bytes += offset;
      if (offset === chunk.length) return;
      this.buffer.copy(this.buffer, HEAD_LIMIT, TASK_OUTPUT_LIMIT - TAIL_LIMIT);
      this.truncated = true;
    }
    const retained = chunk.subarray(Math.max(offset, chunk.length - TAIL_LIMIT));
    const first = Math.min(retained.length, TAIL_LIMIT - this.cursor);
    retained.copy(this.buffer, HEAD_LIMIT + this.cursor, 0, first);
    retained.copy(this.buffer, HEAD_LIMIT, first);
    this.cursor = (this.cursor + retained.length) % TAIL_LIMIT;
  }

  snapshot(finalize = false): string {
    if (!this.truncated) return decodeSuffix(this.buffer.subarray(0, this.bytes), TASK_OUTPUT_LIMIT, finalize);
    const tail = Buffer.concat([
      this.buffer.subarray(HEAD_LIMIT + this.cursor, HEAD_LIMIT + TAIL_LIMIT),
      this.buffer.subarray(HEAD_LIMIT, HEAD_LIMIT + this.cursor),
    ]);
    let start = 0;
    while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
    return decodePrefix(this.buffer.subarray(0, HEAD_LIMIT), HEAD_LIMIT, false) + TASK_OUTPUT_OMISSION
      + decodeSuffix(tail.subarray(start), TAIL_LIMIT, finalize);
  }
}

export function boundedText(value: string): string {
  const output = new RetainedOutput();
  output.append(Buffer.from(value));
  return output.snapshot(true);
}

export class TaskOutput {
  private readonly retained = new RetainedOutput();
  private readonly decoder = new StringDecoder('utf8');
  private line = '';
  private overflow = false;
  error = '';

  append(chunk: Buffer, stdout: boolean): void {
    this.retained.append(chunk);
    if (!stdout) return;
    const text = this.decoder.write(chunk);
    const lines = text.split('\n');
    for (const [index, part] of lines.entries()) {
      const remaining = TASK_OUTPUT_LIMIT - this.line.length;
      this.line += part.slice(0, remaining);
      this.overflow ||= part.length > remaining;
      if (index < lines.length - 1) this.consumeLine();
    }
  }

  private consumeLine(): void {
    if (this.overflow) {
      if (/^\s*\{\s*"type"\s*:\s*"error"/.test(this.line)) this.error = 'OpenCode reported an error (event truncated)';
    } else if (this.line.trim()) {
      try {
        const event: unknown = JSON.parse(this.line);
        if (event !== null && typeof event === 'object' && 'type' in event && event.type === 'error') {
          this.error = boundedText('error' in event ? JSON.stringify(event.error) : 'OpenCode reported an error');
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    this.line = '';
    this.overflow = false;
  }

  snapshot(): string {
    return this.retained.snapshot();
  }

  finish(): string {
    this.line += this.decoder.end();
    this.consumeLine();
    return this.retained.snapshot(true);
  }
}
