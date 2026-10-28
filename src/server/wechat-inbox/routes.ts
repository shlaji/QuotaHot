import { Hono, type Context } from 'hono';
import type { WechatInboxService } from './service.js';
import { InboxSendError, type InboxSendCommand, type InboxTarget, type WechatInboxSender } from './sender.js';
import type { WechatInboxTyping } from './typing.js';
import { IlinkMediaError, parseMediaMetadata } from './media.js';

export interface WechatInboxRouteDependencies {
  readonly service: WechatInboxService;
  readonly sender: WechatInboxSender;
  readonly typing: WechatInboxTyping;
}

class InvalidInboxRequest extends Error {}
function unreachable(value: never): never { throw new TypeError(`Invalid inbox variant: ${typeof value}`); }
function strictObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}
async function jsonInput(context: Context): Promise<unknown> {
  if (context.req.header('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new InvalidInboxRequest();
  try { return await context.req.json<unknown>(); }
  catch (error) { if (error instanceof SyntaxError) throw new InvalidInboxRequest(); throw error; }
}
async function sendInput(context: Context, target: InboxTarget): Promise<InboxSendCommand> {
  const contentType = context.req.header('content-type')?.split(';')[0].trim().toLowerCase();
  switch (contentType) {
    case 'application/json': {
      const body = await jsonInput(context);
      if (!strictObject(body, ['kind', 'text']) || body.kind !== 'text'
        || typeof body.text !== 'string' || body.text.length === 0) throw new InvalidInboxRequest();
      return { ...target, kind: 'text', text: body.text };
    }
    case 'multipart/form-data': {
      let form: FormData;
      try { form = await context.req.formData(); }
      catch (error) { if (error instanceof TypeError) throw new InvalidInboxRequest(); throw error; }
      for (const key of form.keys()) {
        if (!['kind', 'file', 'fileName', 'mediaType'].includes(key) || form.getAll(key).length !== 1) throw new InvalidInboxRequest();
      }
      const kind = form.get('kind');
      const file = form.get('file');
      const fileName = form.get('fileName');
      const mime = form.get('mediaType');
      if (!(file instanceof File) || (fileName !== null && typeof fileName !== 'string')
        || (mime !== null && typeof mime !== 'string')) throw new InvalidInboxRequest();
      switch (kind) {
        case 'image': case 'file': case 'video': case 'voice': {
          const metadata = parseMediaMetadata({ kind, fileName: fileName ?? file.name,
            mediaType: mime?.trim() || file.type || 'application/octet-stream', sizeBytes: file.size });
          const source = (async function* () {
            const reader = file.stream().getReader();
            try { for (;;) { const next = await reader.read(); if (next.done) return; yield next.value; } }
            finally { reader.releaseLock(); }
          })();
          return { ...target, kind, source, fileName: metadata.fileName,
            mediaType: metadata.mediaType, signal: context.req.raw.signal };
        }
        default: throw new InvalidInboxRequest();
      }
    }
    default: throw new InvalidInboxRequest();
  }
}

export function wechatInboxRoutes(dependencies: WechatInboxRouteDependencies): Hono {
  const { service, sender, typing } = dependencies;
  const app = new Hono();
  app.use('*', async (context, next) => { context.header('Cache-Control', 'no-store'); await next(); });
  app.onError((error, context) => {
    context.header('Cache-Control', 'no-store');
    if (error instanceof InvalidInboxRequest || error instanceof IlinkMediaError) return context.json({ error: 'wechat_inbox_invalid_request' }, 400);
    if (error instanceof InboxSendError) {
      switch (error.code) {
        case 'not_found': return context.json({ error: 'wechat_inbox_not_found' }, 404);
        case 'binding_read_only': return context.json({ error: 'wechat_inbox_binding_read_only' }, 409);
        case 'context_required': return context.json({ error: 'wechat_inbox_context_required' }, 409);
        case 'voice_outbound_disabled': return context.json({ error: 'wechat_inbox_voice_outbound_disabled' }, 400);
        case 'send_rejected': return context.json({ error: 'wechat_inbox_send_rejected' }, 502);
        case 'upload_failed': return context.json({ error: 'wechat_inbox_upload_failed' }, 502);
        case 'storage_failed': case 'send_unknown': return context.json({ error: 'wechat_inbox_internal_error' }, 500);
        default: return unreachable(error.code);
      }
    }
    return context.json({ error: 'wechat_inbox_internal_error' }, 500);
  });
  app.get('/bindings', (context) => context.json(service.listBindings()));
  app.use('/bindings/:bindingId/*', async (context, next) => {
    if (!service.listBindings().some((binding) => binding.ownerIlinkUserId === context.req.param('bindingId'))) {
      return context.json({ error: 'wechat_inbox_not_found' }, 404);
    }
    await next();
  });
  app.use('/bindings/:bindingId/*', async (context, next) => {
    if (context.req.method === 'POST' && (context.req.path.endsWith('/messages') || context.req.path.endsWith('/typing'))) {
      const binding = service.listBindings().find((item) => item.ownerIlinkUserId === context.req.param('bindingId'));
      if (!binding?.canSend) return context.json({ error: 'wechat_inbox_binding_read_only' }, 409);
      if (binding.replyContextState !== 'ready') return context.json({ error: 'wechat_inbox_context_required' }, 409);
    }
    await next();
  });
  app.get('/bindings/:bindingId/messages', (context) => {
    const query = new URL(context.req.url).searchParams;
    const limit = query.get('limit');
    if (query.getAll('limit').length > 1 || query.getAll('before').length > 1
      || (limit !== null && (!/^[0-9]+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100))) throw new InvalidInboxRequest();
    try {
      return context.json(service.listMessages(context.req.param('bindingId'), {
        limit: limit === null ? 50 : Number(limit), before: query.get('before') || null,
      }));
    } catch (error) { if (error instanceof RangeError) throw new InvalidInboxRequest(); throw error; }
  });
  app.post('/bindings/:bindingId/messages', async (context) => {
    const result = await sender.send(await sendInput(context, {
      owner: context.req.param('bindingId'),
    }));
    switch (result.state) {
      case 'accepted': return context.json({ messageId: result.messageId, state: 'accepted', errorCode: null }, 202);
      case 'failed': return context.json({ error: result.errorCode === 'upload_failed' ? 'wechat_inbox_upload_failed' : 'wechat_inbox_send_rejected' }, 502);
      case 'unknown': return context.json({ messageId: result.messageId, state: 'unknown', errorCode: 'send_unknown' }, 504);
      default: return unreachable(result);
    }
  });
  app.post('/bindings/:bindingId/typing', async (context) => {
    const body = await jsonInput(context);
    if (!strictObject(body, ['status']) || (body.status !== 'typing' && body.status !== 'cancel')) throw new InvalidInboxRequest();
    await typing.send({ owner: context.req.param('bindingId'), status: body.status === 'typing' ? 1 : 2 });
    return context.body(null, 204);
  });
  app.get('/attachments/:attachmentId', (context) => {
    const result = service.getAttachmentById(context.req.param('attachmentId'));
    if (!result) return context.json({ error: 'wechat_inbox_not_found' }, 404);
    const metadata = parseMediaMetadata({ ...result.attachment, kind: 'file' });
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('Content-Type', metadata.mediaType);
    context.header('Content-Disposition', `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(metadata.fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`);
    const chunks = result.chunks;
    return context.body(new ReadableStream<Uint8Array>({
      pull(controller) { const next = chunks.next(); if (next.done) controller.close(); else controller.enqueue(next.value); },
      cancel() { chunks.return?.(); },
    }));
  });
  return app;
}
