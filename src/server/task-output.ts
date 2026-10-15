import { StringDecoder } from 'node:string_decoder';

export const TASK_OUTPUT_LIMIT = 64 * 1024;

export function boundedText(value: string): string {
  return new StringDecoder('utf8').write(Buffer.from(value).subarray(0, TASK_OUTPUT_LIMIT));
}

export class TaskOutput {
  private readonly chunks: Buffer[] = [];
  private readonly decoder = new StringDecoder('utf8');
  private bytes = 0;
  private line = '';
  private overflow = false;
  error = '';

  append(chunk: Buffer, stdout: boolean): void {
    const retained = chunk.subarray(0, Math.max(0, TASK_OUTPUT_LIMIT - this.bytes));
    if (retained.length > 0) this.chunks.push(Buffer.from(retained));
    this.bytes += retained.length;
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
    return boundedText(new StringDecoder('utf8').write(Buffer.concat(this.chunks)));
  }

  finish(): string {
    this.line += this.decoder.end();
    this.consumeLine();
    return this.snapshot();
  }
}
