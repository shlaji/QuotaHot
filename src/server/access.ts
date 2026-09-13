/** 可选 Web 访问凭证与跨站保护；浏览器原生 Basic Auth 同时覆盖页面、REST 和 SSE。 */
import { basicAuth } from 'hono/basic-auth';
import type { MiddlewareHandler } from 'hono';

export interface WebCredentials {
  readonly username: string;
  readonly password: string;
}

/** 未配置密码时关闭认证；配置密码后用户名默认为 quotahot。 */
export function webCredentials(): WebCredentials | null {
  const username = process.env.QUOTAHOT_AUTH_USERNAME?.trim() ?? '';
  const password = process.env.QUOTAHOT_AUTH_PASSWORD;
  if (!password) {
    if (username) throw new Error('QUOTAHOT_AUTH_PASSWORD must be set when QUOTAHOT_AUTH_USERNAME is configured');
    return null;
  }
  return { username: username || 'quotahot', password };
}

export function accessGuard(credentials: WebCredentials | null): MiddlewareHandler {
  const authenticate = credentials
      ? basicAuth({ username: credentials.username, password: credentials.password, realm: 'quotahot' })
    : null;
  return async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    const origin = c.req.header('origin');
    if (c.req.header('sec-fetch-site') === 'cross-site') return c.text('Forbidden', 403);
    if (origin) {
      try {
        if (new URL(origin).host !== c.req.header('host')) return c.text('Forbidden', 403);
      } catch {
        return c.text('Forbidden', 403);
      }
    }
    return authenticate ? authenticate(c, next) : next();
  };
}
