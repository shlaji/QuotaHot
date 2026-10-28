import { Hono } from 'hono';

export interface DingtalkInboxProxyOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: (request: Request) => Promise<Response>;
}

export function dingtalkInboxProxyRoutes(options: DingtalkInboxProxyOptions): Hono {
  const app = new Hono();
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const paths: Readonly<Record<string, readonly string[]>> = {
    '/capability': ['GET'],
    '/people/search': ['GET'],
    '/groups/search': ['GET'],
    '/active-target': ['GET', 'PUT', 'DELETE'],
    '/messages': ['GET', 'POST'],
    '/events': ['GET'],
  };
  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    context.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  app.onError((_error, context) => context.json({ error: 'dingtalk_inbox_upstream_unavailable' }, 502));
  for (const [path, methods] of Object.entries(paths)) {
    app.all(path, async (context) => {
      const method = context.req.method;
      if (!methods.includes(method)) return context.notFound();
      const headers = new Headers({ authorization: `Bearer ${options.token}` });
      const accept = context.req.header('accept');
      if (accept) headers.set('accept', accept);
      const carriesBody = method === 'PUT' || method === 'POST';
      const contentType = context.req.header('content-type');
      if (carriesBody && contentType) headers.set('content-type', contentType);
      const request = new Request(`${baseUrl}${path}${new URL(context.req.url).search}`, {
        method, headers,
        body: carriesBody ? await context.req.raw.arrayBuffer() : null,
        signal: context.req.raw.signal,
        redirect: 'manual',
      });
      const upstream = await options.fetch(request);
      const responseHeaders = new Headers({
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      const responseType = upstream.headers.get('content-type');
      if (responseType) responseHeaders.set('content-type', responseType);
      if (path === '/events') responseHeaders.set('X-Accel-Buffering', 'no');
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    });
  }
  return app;
}
