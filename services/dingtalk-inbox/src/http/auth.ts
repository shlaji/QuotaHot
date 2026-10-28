import { createHash, timingSafeEqual } from 'node:crypto';
import { createMiddleware } from 'hono/factory';

export interface InboxAuthConfig {
  readonly bearerToken: string;
}

export class InboxAuthConfigError extends Error {
  constructor() {
    super('Invalid Inbox authentication configuration');
    this.name = 'InboxAuthConfigError';
  }
}

export function bearerAuth(config: InboxAuthConfig) {
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(config.bearerToken)) throw new InboxAuthConfigError();
  const expected = createHash('sha256').update(config.bearerToken).digest();
  return createMiddleware(async (context, next) => {
    const match = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(context.req.header('Authorization') ?? '');
    const supplied = match?.[1];
    if (supplied === undefined || !timingSafeEqual(expected, createHash('sha256').update(supplied).digest())) {
      context.header('WWW-Authenticate', 'Bearer');
      return context.json({ code: 'Unauthorized', message: 'Authentication required' }, 401);
    }
    await next();
  });
}
