import { Hono } from 'hono';
import { loadAccount } from './creds.js';
import { qoderTargets, switchQoderAccount } from './qoder-switch.js';
import { record } from './qoder-session.js';
import { isQoderClient } from '../shared/qoder.js';

interface RouteContext {
  readonly accountsDir: string;
  readonly changed: () => Promise<void>;
}

export function qoderRoutes(context: RouteContext): Hono {
  const routes = new Hono();
  routes.get('/accounts/:id/qoder-clients', async (c) => {
    const account = await loadAccount(context.accountsDir, c.req.param('id'));
    if (!account) return c.json({ error: '找不到该账户' }, 404);
    try { return c.json(await qoderTargets(account)); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : '读取切换目标失败' }, 400); }
  });
  routes.post('/accounts/:id/qoder-switch', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: '请求必须是 JSON' }, 400); }
    if (!record(body) || !isQoderClient(body.client) || body.confirm !== true) {
      return c.json({ error: '请选择客户端并明确确认关闭和切换操作' }, 400);
    }
    const account = await loadAccount(context.accountsDir, c.req.param('id'));
    if (!account) return c.json({ error: '找不到该账户' }, 404);
    try {
      const result = await switchQoderAccount(account, body.client);
      await context.changed();
      return c.json(result);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : '切换账户失败' }, 400); }
  });
  return routes;
}
