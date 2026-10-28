import { startServer } from './http/server.js';
import { InboxStore } from './inbox/store.js';

const hostname = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? '8787');
const store = new InboxStore();
const server = await startServer({ hostname, port });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close((error) => {
      store.close();
      if (error) process.exitCode = 1;
    });
  });
}
