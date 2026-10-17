import type { TaskLogPageResponse } from '../shared/tasks.js';
import { projectTextEvents, type TextEventCheckpoint } from './task-output-parser.js';

type Stream = 'stdout' | 'stderr' | 'legacy';
export interface TaskLogCheckpoint {
  readonly events: TextEventCheckpoint;
  readonly bytes: Readonly<Record<Stream, readonly number[]>>;
}

export interface TaskLogWindow {
  readonly messages: string;
  readonly diagnostics: string;
  readonly legacy: string;
  readonly invalidLines: number;
  readonly partial: boolean;
  readonly textTruncated: boolean;
  readonly pending: boolean;
  readonly checkpoint: TaskLogCheckpoint;
}

function decode(bytes: Uint8Array, final: boolean) {
  let end = bytes.length;
  if (!final && end !== 0) {
    let start = end - 1;
    while (start > 0 && (bytes[start] & 0xc0) === 0x80) start -= 1;
    const lead = bytes[start];
    const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (end - start < width) end = start;
  }
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), pending: [...bytes.subarray(end)] };
}

export function projectTaskLogPage(page: TaskLogPageResponse, previous?: TaskLogCheckpoint): TaskLogWindow {
  const bytes: Record<Stream, readonly number[]> = { stdout: [], stderr: [], legacy: [], ...previous?.bytes };
  const text: Record<Stream, string[]> = { stdout: [], stderr: [], legacy: [] };
  for (const chunk of page.chunks) {
    const raw = Uint8Array.from(atob(chunk.data), (character) => character.charCodeAt(0));
    const joined = new Uint8Array(bytes[chunk.stream].length + raw.length);
    joined.set(bytes[chunk.stream]);
    joined.set(raw, bytes[chunk.stream].length);
    const decoded = decode(joined, false);
    bytes[chunk.stream] = decoded.pending;
    text[chunk.stream].push(decoded.text);
  }
  const final = !page.hasMore && page.archiveState !== 'capturing';
  if (final) {
    for (const stream of ['stdout', 'stderr', 'legacy'] as const) {
      text[stream].push(decode(Uint8Array.from(bytes[stream]), true).text);
      bytes[stream] = [];
    }
  }
  const events = projectTextEvents(text.stdout.join(''), { checkpoint: previous?.events, partialStart: page.hasEarlier, final });
  return {
    messages: events.text, diagnostics: text.stderr.join(''), legacy: text.legacy.join(''),
    invalidLines: events.invalidLines, partial: events.partial, textTruncated: events.textTruncated, pending: events.pending,
    checkpoint: { events: events.checkpoint, bytes },
  };
}
