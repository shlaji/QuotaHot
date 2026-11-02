import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { WechatLoginError, type WechatLoginService } from './wechat-login-service.js';
import { WechatClawbotError } from './wechat-clawbot-client.js';

export interface WechatRouteDependencies {
  readonly login: WechatLoginService;
  readonly qrSvg: (payload: string) => string | Promise<string>;
}

const FLOW_COOKIE = 'quotahot_wechat_flow';
const COOKIE_OPTIONS = { httpOnly: true, sameSite: 'Strict', path: '/api/wechat' } as const;

class InvalidWechatRequest extends Error {}

async function input(context: Context): Promise<object> {
  const body = await context.req.text();
  const value: unknown = body === '' ? {} : JSON.parse(body);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new InvalidWechatRequest();
  if ('owner' in value || 'ownerIlinkUserId' in value) throw new InvalidWechatRequest();
  return value;
}

async function emptyInput(context: Context): Promise<void> {
  if (Object.keys(await input(context)).length !== 0) throw new InvalidWechatRequest();
}

export function wechatRoutes(dependencies: WechatRouteDependencies): Hono {
  const { login, qrSvg } = dependencies;
  const app = new Hono();
  app.use('/wechat/*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    await next();
  });
  app.onError((error, context) => {
    context.header('Cache-Control', 'no-store');
    if (error instanceof InvalidWechatRequest || error instanceof SyntaxError) {
      return context.json({ error: 'wechat_invalid_request' }, 400);
    }
    if (error instanceof WechatLoginError) {
      return context.json({ error: `wechat_login_${error.code}` }, error.code === 'capacity' ? 503 : 409);
    }
    if (error instanceof WechatClawbotError) {
      switch (error.code) {
        case 'auth_required': return context.json({ error: 'wechat_upstream_auth_failed' }, 502);
        case 'identity_missing': return context.json({ error: 'wechat_identity_missing' }, 502);
        case 'http_failure': case 'invalid_response': case 'request_failed':
          return context.json({ error: 'wechat_upstream_unavailable' }, 502);
        default: return assertNever(error.code);
      }
    }
    return context.json({ error: 'wechat_internal_error' }, 500);
  });
  app.post('/wechat/qrcode', async (context) => {
    await emptyInput(context);
    const attempt = await login.start(getCookie(context, FLOW_COOKIE));
    try {
      const svg = await qrSvg(attempt.qrPayload);
      setCookie(context, FLOW_COOKIE, attempt.flowToken, { ...COOKIE_OPTIONS, secure: new URL(context.req.url).protocol === 'https:', maxAge: 600 });
      return context.json({ attemptId: attempt.attemptId, qrSvg: svg, expiresAt: attempt.expiresAt }, 201);
    } catch (error) {
      login.cancel(attempt.attemptId, attempt.flowToken);
      throw error;
    }
  });
  app.get('/wechat/qrcode/:attemptId', async (context) => {
    const result = await login.poll(context.req.param('attemptId'), getCookie(context, FLOW_COOKIE));
    switch (result.status) {
      case 'confirmed':
        return context.json({ status: result.status });
      case 'unavailable': return context.json({ status: result.status }, 404);
      case 'identity_missing': return context.json({ error: 'wechat_identity_missing' }, 502);
      case 'expired': return context.json({ status: result.status });
      case 'waiting': case 'scanned': case 'unverified':
        return context.json({ status: result.status });
      default: return assertNever(result);
    }
  });
  app.delete('/wechat/qrcode/:attemptId', async (context) => {
    await emptyInput(context);
    if (!login.cancel(context.req.param('attemptId'), getCookie(context, FLOW_COOKIE))) {
      return context.json({ status: 'unavailable' }, 404);
    }
    return context.json({ status: 'cancelled' });
  });
  app.delete('/wechat/bindings/:bindingId', async (context) => {
    await emptyInput(context);
    if (!await login.unlink(context.req.param('bindingId'))) return context.json({ error: 'wechat_binding_not_found' }, 404);
    return context.json({ status: 'unlinked' });
  });
  app.all('/wechat/*', (context) => context.text('404 Not Found', 404));
  return app;
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected login result: ${String(value)}`);
}
