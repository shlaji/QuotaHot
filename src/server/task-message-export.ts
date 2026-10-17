import type { TaskLogChunk } from '../shared/tasks.js';

export function* messageArray(chunks: Iterable<TaskLogChunk>): Generator<Uint8Array> {
  let decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let fragments: string[] = [];
  let validUtf8 = true;
  let separator = '';

  function decode(bytes: Uint8Array, stream: boolean): void {
    if (!validUtf8) return;
    try {
      fragments.push(decoder.decode(bytes, { stream }));
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      validUtf8 = false;
      fragments = [];
    }
  }

  function finishLine(): Uint8Array | null {
    decode(new Uint8Array(), false);
    const line = validUtf8 ? fragments.join('').trim() : '';
    fragments = [];
    validUtf8 = true;
    decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    if (!line) return null;
    try {
      const event: unknown = JSON.parse(line);
      if (event === null || typeof event !== 'object' || Array.isArray(event)) return null;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return null;
    }
    const bytes = Buffer.from(separator + line);
    separator = ',';
    return bytes;
  }

  yield Buffer.from('[');
  for (const chunk of chunks) {
    if (chunk.stream === 'stdout') {
      let offset = 0;
      while (offset < chunk.data.length) {
        const newline = chunk.data.indexOf(10, offset);
        const end = newline < 0 ? chunk.data.length : newline;
        decode(chunk.data.subarray(offset, end), true);
        offset = end + 1;
        if (newline >= 0) {
          const event = finishLine();
          if (event) yield event;
        }
      }
    }
    yield Buffer.from('\n');
  }
  const finalEvent = finishLine();
  if (finalEvent) yield finalEvent;
  yield Buffer.from(']');
}
