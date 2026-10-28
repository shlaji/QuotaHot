import type { WechatMediaSend, WechatTextSend } from '../../shared/wechat-inbox.js';
import { InboxApiError, type InboxConflictCode } from './errors.js';
import { list, localId, parseBinding, parsePage, parseSend } from './parse.js';
export { InboxApiError } from './errors.js';

export type InboxTarget = string;
export type InboxSend = WechatTextSend | WechatMediaSend;
const root = '/api/wechat-inbox';
const bindingPath = (bindingId: InboxTarget) => `/bindings/${encodeURIComponent(bindingId)}`;
export const attachmentUrl = (attachmentId: string) => `${root}/attachments/${localId(attachmentId)}`;

async function request<T>(path: string, init: RequestInit, parse: (body: unknown) => T): Promise<T> {
  const response = await fetch(`${root}${path}`, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  if (!response.ok && !(init.method === 'POST' && path.endsWith('/messages') && response.status === 504)) {
    let code: InboxConflictCode | undefined;
    if (response.status === 409) {
      try {
        const body: unknown = await response.json();
        if (typeof body === 'object' && body !== null && 'error' in body) {
          switch (body.error) {
            case 'wechat_inbox_context_required': case 'wechat_inbox_binding_read_only':
              code = body.error; break;
          }
        }
      } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    throw new InboxApiError(response.status, response.status >= 500 && response.status !== 502 ? 'unknown' : 'failed', code);
  }
  if (response.status === 204) return parse(null);
  let body: unknown;
  try { body = await response.json(); }
  catch (error) {
    if (error instanceof SyntaxError) throw new InboxApiError(response.status, 'unknown');
    throw error;
  }
  return parse(body);
}
export const inboxApi = {
  bindings: (signal: AbortSignal) => request('/bindings', { signal }, (body) => list(body, parseBinding)),
  messages: (target: InboxTarget, page: { readonly limit?: number; readonly before?: string | null }, signal: AbortSignal) => {
    const query = new URLSearchParams({ limit: String(page.limit ?? 50) });
    if (page.before) query.set('before', page.before);
    return request(`${bindingPath(target)}/messages?${query}`, { signal }, parsePage);
  },
  async send(target: InboxTarget, input: InboxSend, signal: AbortSignal) {
    if (input.kind === 'voice') throw new InboxApiError(400);
    const init: RequestInit = { method: 'POST', signal };
    if (input.kind === 'text') {
      init.body = JSON.stringify({ kind: 'text', text: input.text });
      init.headers = { 'content-type': 'application/json' };
    } else {
      const form = new FormData();
      form.append('kind', input.kind);
      form.append('file', input.file);
      form.append('fileName', input.fileName ?? input.file.name);
      form.append('mediaType', input.mediaType ?? (input.file.type || 'application/octet-stream'));
      init.body = form;
    }
    return request(`${bindingPath(target)}/messages`, init, (body) => {
      try { return parseSend(body); }
      catch (error) {
        if (error instanceof InboxApiError) throw new InboxApiError(error.status, 'unknown');
        throw error;
      }
    });
  },
  typing: (target: InboxTarget, status: 'typing' | 'cancel', signal: AbortSignal) => request(`${bindingPath(target)}/typing`,
    { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) }, () => undefined),
};
