/**
 * SSE 的解析与拼装。
 *
 * 转发链路两头都是事件流：上游发一串事件过来，我们改完再发一串出去。中间这层必须
 * **逐事件**处理而不是整段读完——客户端要的就是边生成边看到，攒完再转发等于把流式变成阻塞。
 *
 * 只认 `event:` 和 `data:` 两个字段：注释行、id、retry 在这两家上游的流里都不出现，
 * 认了反而要为不会发生的情况写分支。
 */
import type { Readable } from 'node:stream';

export interface SseEvent {
  /** 事件名；上游没给 `event:` 时为空串（OpenAI 系的流就是这样）。 */
  event: string;
  /** `data:` 的原文，多行 data 会按规范用 \n 连起来。 */
  data: string;
}

/** 把一段字节流按 SSE 帧切开。上游中途断开时抛错，由调用方决定怎么收尾。 */
export async function* parseSse(stream: Readable): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk as Buffer, { stream: true });
    // 帧之间是空行；\r\n 也要认，有的代理会改写换行
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + (/\r\n\r\n/.test(buffer.slice(boundary, boundary + 4)) ? 4 : 2));
      const parsed = parseFrame(frame);
      if (parsed) yield parsed;
      boundary = buffer.search(/\r?\n\r?\n/);
    }
  }
  // 末尾没有空行的最后一帧：上游正常结束时不该出现，但真出现了也别把它丢掉
  const tail = parseFrame(buffer);
  if (tail) yield tail;
}

function parseFrame(frame: string): SseEvent | null {
  let event = '';
  const data: string[] = [];
  for (const raw of frame.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (event === '' && data.length === 0) return null;
  return { event, data: data.join('\n') };
}

/** 拼一帧 SSE。事件名为空时只发 data，这正是 OpenAI 兼容流的形态。 */
export function sseFrame(event: string, data: string): string {
  return event ? `event: ${event}\ndata: ${data}\n\n` : `data: ${data}\n\n`;
}

/** `data:` 里的 JSON；解析不出来时返回 null，让调用方跳过这一帧而不是让整条流炸掉。 */
export function sseJson(evt: SseEvent): Record<string, unknown> | null {
  if (evt.data === '' || evt.data === '[DONE]') return null;
  try {
    const parsed: unknown = JSON.parse(evt.data);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
