import { TASK_OUTPUT_LIMIT } from './task-output.js';

export class TaskOutputLines {
  private readonly buffer = Buffer.alloc(TASK_OUTPUT_LIMIT);
  private length = 0;
  private discarding = false;

  append(chunk: Buffer, consume: (line: string) => void): void {
    let start = 0;
    while (start < chunk.length) {
      const delimiter = chunk.indexOf(10, start);
      const end = delimiter === -1 ? chunk.length : delimiter;
      const size = end - start;
      if (!this.discarding) {
        if (this.length + size > TASK_OUTPUT_LIMIT) {
          this.length = 0;
          this.discarding = true;
        } else {
          chunk.copy(this.buffer, this.length, start, end);
          this.length += size;
        }
      }
      if (delimiter !== -1) {
        if (!this.discarding) consume(this.buffer.toString('utf8', 0, this.length));
        this.length = 0;
        this.discarding = false;
      }
      start = end + 1;
    }
  }
}
