import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { setTimeout as delay } from 'node:timers/promises';

export function wechatInboxPresence(onFirstViewer: () => void, onLastViewer: () => void) {
  let viewers = 0;
  return (context: Context) => {
    const site = context.req.header('sec-fetch-site');
    if (site && site !== 'same-origin') return context.body(null, 403);
    if (context.req.header('accept') !== 'text/event-stream') return context.body(null, 406);
    context.header('X-Accel-Buffering', 'no');
    const response = streamSSE(context, async (stream) => {
      const disconnected = new AbortController();
      stream.onAbort(() => disconnected.abort());
      try {
        if (++viewers === 1) onFirstViewer();
        await stream.writeSSE({ event: 'ready', data: '' });
        while (!disconnected.signal.aborted) {
          await delay(15_000, undefined, { signal: disconnected.signal });
          await stream.writeSSE({ event: 'ping', data: '' });
        }
      } catch (error) {
        if (!disconnected.signal.aborted) throw error;
      } finally {
        if (--viewers === 0) onLastViewer();
      }
    });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  };
}
