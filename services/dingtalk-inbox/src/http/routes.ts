import { Hono } from 'hono';
import type { InboxService, TargetDto } from '../inbox/service.js';
import { bearerAuth } from './auth.js';
import type { InboxAuthConfig } from './auth.js';

function parseTarget(value: unknown): TargetDto | null {
  if (typeof value !== 'object' || value === null || !('targetType' in value) || !('targetId' in value) || !('displayName' in value)) return null;
  if (typeof value.targetId !== 'string' || value.targetId.trim() === '' || typeof value.displayName !== 'string') return null;
  switch (value.targetType) {
    case 'person': return { targetType: 'person', targetId: value.targetId, displayName: value.displayName };
    case 'group': return { targetType: 'group', targetId: value.targetId, displayName: value.displayName };
    default: return null;
  }
}

export function createApp(service: InboxService, config: InboxAuthConfig): Hono {
  const app = new Hono();
  app.get('/health', context => context.json({ status: 'ok' }));
  app.use('/api/v1/*', bearerAuth(config));
  app.get('/api/v1/capability', context => context.json(service.getCapability()));
  app.get('/api/v1/active-target', context => context.json(service.getActiveTarget()));
  app.put('/api/v1/active-target', async context => {
    let body: unknown;
    try {
      body = await context.req.json<unknown>();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return context.json({ code: 'InvalidTarget', message: 'Invalid target' }, 400);
    }
    const target = parseTarget(body);
    if (target === null) return context.json({ code: 'InvalidTarget', message: 'Invalid target' }, 400);
    const result = service.selectTarget(target);
    return context.json(result, result.code === 'InvalidTarget' ? 400 : 503);
  });
  for (const [path, targetType] of [['people', 'person'], ['groups', 'group']] as const) {
    app.get(`/api/v1/${path}/search`, async context => {
      const query = context.req.query('query');
      if (query === undefined || query.trim() === '') return context.json({ code: 'InvalidTarget', message: 'Search query is required' }, 400);
      const result = await service.search(targetType, query);
      if ('code' in result) return context.json(result, 503);
      const items = result.items.map(item => {
        switch (item.targetType) {
          case 'person': return { userId: item.targetId, displayName: item.displayName };
          case 'group': return { openConversationId: item.targetId, displayName: item.displayName };
        }
      });
      return context.json({ items, complete: result.complete });
    });
  }
  return app;
}
