import { Readable } from 'node:stream';
import { fetch as undiciFetch, request as undiciRequest, type Dispatcher } from 'undici';
import { dispatcherFor, getProxy } from './proxy.js';
import { requestAudit } from './audit.js';
import { validateOptions, type FetchOptions } from './options.js';
import { decode, HttpResponse, toHeaders } from './response.js';

export async function request(url: string, opts: FetchOptions = {}): Promise<HttpResponse> {
  validateOptions(opts);
  const { timeoutMs = 120_000, audit, method = 'GET', headers = {}, body, bodyBytes, transport = 'undici' } = opts;
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const followRedirects = opts.followRedirects ?? true;
  const via = dispatcherFor(url, followRedirects);
  const sendBody = bodyBytes ?? body;
  const logging = requestAudit(audit, { method, url, headers, body: body ?? '' });
  let resp: Dispatcher.ResponseData | { statusCode: number; headers: Headers; body: Readable };
  try {
    if (transport === 'fetch') {
      const init = {
        method, headers, body: sendBody as string | undefined, signal, dispatcher: via,
        redirect: followRedirects ? 'follow' : 'manual',
      } satisfies RequestInit & { dispatcher: Dispatcher };
      const fetcher = getProxy() ? undiciFetch : fetch;
      const response = await fetcher(url, init);
      const responseBody = response.body;
      const responseHeaders = new Headers();
      response.headers.forEach((value, key) => responseHeaders.set(key, value));
      resp = {
        statusCode: response.status,
        headers: responseHeaders,
        body: responseBody ? Readable.from((async function* () {
          const reader = responseBody.getReader();
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) return;
            if (chunk.value) yield chunk.value;
          }
        })()) : Readable.from([]),
      };
    } else {
      resp = await undiciRequest(url, {
        method: method as Dispatcher.HttpMethod, headers, body: opts.bodyStream ?? sendBody,
        signal, dispatcher: via, ...(opts.bodyStream ? { idempotent: false } : {}),
      });
    }
  } catch (error) {
    logging.log(0, `network: ${String(error instanceof Error ? error.cause ?? error : error)}`);
    throw error;
  }
  logging.log(resp.statusCode, '');
  const headersOut = resp.headers instanceof Headers ? resp.headers : toHeaders(resp.headers);
  const stream = resp.headers instanceof Headers ? resp.body : decode(resp.body, headersOut.get('content-encoding') ?? '');
  return new HttpResponse(resp.statusCode, headersOut, logging.response(stream));
}
