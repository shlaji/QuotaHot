import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import type { ServerType } from '@hono/node-server';

export interface ServerOptions {
  readonly hostname: string;
  readonly port: number;
}

export async function startServer(options: ServerOptions): Promise<ServerType> {
  const app = new Hono();
  app.get('/health', (context) => context.json({ status: 'ok' }));

  const server = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(options.port, options.hostname, () => {
      server.off('error', onError);
      resolve();
    });
  });

  return server;
}
