/**
 * 对外的 API 端点，以及界面用来管账号池的那几个管理接口。
 *
 * 两族路由的鉴权完全不同，所以它们在 main.ts 里挂在不同的位置：
 *
 * - `/v1/*` 是给编码客户端用的，走这里自己的 key 校验，挂在 Web 的 Basic Auth **之前**——
 *   让 Claude Code 去做一次浏览器式的 Basic Auth 是不现实的。
 * - `/api/gateway/*` 是界面用的，和其余管理接口一样受 Web 凭证保护。
 */
import { Hono } from 'hono';
import { Readable } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { catalogFor } from '../catalog.js';
import { collect, toMessageResponse, type AnthropicRequest } from './anthropic.js';
import { errorFrame, fromOpenAi, toChatCompletion, toChatStream } from './openai.js';
import { sseFrame } from './sse.js';
import { NoAccountError, runForward, type GatewayDeps } from './service.js';
import { isForwardable } from './pool.js';
import { betasFrom, UpstreamError } from './upstream.js';
import { needsPat } from '../../shared/gateway.js';
import { assertQoderIdentity, forgetQoderAuth, getUid, QoderAuthError } from './qoder-auth.js';
import type { EventStream } from './anthropic.js';
import type { Context } from 'hono';
import type { GatewayStatus } from '../../shared/gateway.js';
import type { SendProvider } from '../../shared/types.js';

/** 一个字符一个字符比，避免 key 的校验时间泄露它的前缀。 */
function sameKey(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 请求里带的 key：Anthropic 客户端发 x-api-key，OpenAI 客户端发 Authorization。 */
function presentedKey(c: Context): string {
  const header = c.req.header('authorization') ?? '';
  const bearer = /^Bearer\s+(.+)$/i.exec(header.trim());
  return (bearer ? bearer[1] : c.req.header('x-api-key') ?? '').trim();
}

/** 这条请求是不是来自本机。取不到对端地址时按「不是」处理，宁可多要一次 key。 */
function fromLoopback(c: Context): boolean {
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket;
  const address = socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** 鉴权通过时返回空串，否则返回该告诉客户端的原因。 */
function denyReason(c: Context, deps: GatewayDeps): string {
  const cfg = deps.config().gateway;
  if (!cfg.enabled) return 'API 服务未开启：请先在 QuotaHot 界面里打开它';
  const keys = cfg.apiKeys.filter(Boolean);
  if (keys.length === 0) {
    return fromLoopback(c)
      ? ''
      : '没有配置 API key 时只接受来自本机的请求：请在界面里设置一个 key，再从别的机器访问';
  }
  const presented = presentedKey(c);
  if (presented === '') return '缺少 API key：用 x-api-key 头或 Authorization: Bearer 带上它';
  return keys.some((key) => sameKey(key, presented)) ? '' : 'API key 不正确';
}

/** AsyncGenerator<string> → 能交给 Hono 的响应流。 */
function toStream(chunks: AsyncGenerator<string>): ReadableStream {
  return Readable.toWeb(Readable.from(chunks)) as ReadableStream;
}

const STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // 反向代理默认会缓冲响应，那样流式就退化成一次性返回
  'x-accel-buffering': 'no',
};

/**
 * 把内部事件流按客户端要的方言发出去。
 *
 * 流开始之后才出错的，只能用一帧 error 事件告诉客户端——HTTP 状态码那时候已经发出去了。
 * 两种方言的错误帧不一样，所以由调用方各自给。
 */
async function* guarded(
  frames: AsyncGenerator<string>,
  onError: (message: string) => string,
): AsyncGenerator<string> {
  try {
    yield* frames;
  } catch (err) {
    yield onError(err instanceof Error ? err.message : String(err));
  }
}

async function* anthropicFrames(events: EventStream): AsyncGenerator<string> {
  for await (const evt of events) yield sseFrame(evt.event, evt.data);
}

function failure(c: Context, err: unknown): Response {
  if (err instanceof NoAccountError) {
    return c.json({ type: 'error', error: { type: 'overloaded_error', message: err.message } }, 503);
  }
  if (err instanceof UpstreamError) {
    // 上游怎么说就怎么回，客户端的重试策略是照状态码写的
    const status = err.status >= 400 && err.status < 600 ? err.status : 502;
    return c.json({ type: 'error', error: { type: 'api_error', message: err.message } }, status as 400);
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ type: 'error', error: { type: 'api_error', message } }, 502);
}

/** 请求体不合法时的统一回法。 */
function badRequest(c: Context, message: string): Response {
  return c.json({ type: 'error', error: { type: 'invalid_request_error', message } }, 400);
}

/** 粗略估算 token 数：按字符折算。够客户端拿来做预算判断，不该当账单用。 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.max(1, Math.ceil(text.length / 4));
}

export function gatewayRoutes(deps: GatewayDeps): Hono {
  const routes = new Hono();

  routes.use('/v1/*', async (c, next) => {
    const reason = denyReason(c, deps);
    if (reason === '') return next();
    const status = deps.config().gateway.enabled ? 401 : 503;
    return c.json({ type: 'error', error: { type: 'authentication_error', message: reason } }, status);
  });

  /** Anthropic Messages：请求体就是内部 IR，因此这条路上没有请求转换。 */
  routes.post('/v1/messages', async (c) => {
    let body: AnthropicRequest;
    try {
      body = (await c.req.json()) as AnthropicRequest;
    } catch {
      return badRequest(c, '请求体必须是 JSON');
    }
    if (!Array.isArray(body.messages)) return badRequest(c, '缺少 messages');

    const wantsStream = body.stream === true;
    try {
      const outcome = await runForward(deps, body, {
        betas: betasFrom(c.req.header('anthropic-beta')),
        signal: c.req.raw.signal,
      });
      if (wantsStream) {
        const frames = guarded(anthropicFrames(outcome.events), (message) => {
          const frame = errorFrame(message);
          return sseFrame(frame.event, frame.data);
        });
        return c.newResponse(toStream(frames), 200, STREAM_HEADERS);
      }
      const result = await collect(outcome.events);
      return c.json(toMessageResponse(result, outcome.model));
    } catch (err) {
      return failure(c, err);
    }
  });

  /** OpenAI Chat Completions：两头都要翻译。 */
  routes.post('/v1/chat/completions', async (c) => {
    let raw: Record<string, unknown>;
    try {
      raw = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return badRequest(c, '请求体必须是 JSON');
    }
    if (!Array.isArray(raw.messages)) return badRequest(c, '缺少 messages');

    const request = fromOpenAi(raw);
    const wantsStream = raw.stream === true;
    const id = `chatcmpl-${Date.now().toString(36)}`;
    try {
      const outcome = await runForward(deps, request, { signal: c.req.raw.signal });
      if (wantsStream) {
        const frames = guarded(toChatStream(outcome.events, outcome.model, id), (message) =>
          sseFrame('', JSON.stringify({ error: { message, type: 'upstream_error' } })),
        );
        return c.newResponse(toStream(frames), 200, STREAM_HEADERS);
      }
      const result = await collect(outcome.events);
      return c.json(toChatCompletion(result, outcome.model, id));
    } catch (err) {
      return failure(c, err);
    }
  });

  /**
   * 可用模型。
   *
   * 只列**池子里真有账户**的那几家：把一个点了就报「没有可用账户」的模型摆在客户端的
   * 下拉框里，只会让人以为是转发坏了。
   */
  routes.get('/v1/models', async (c) => {
    const accounts = (await deps.accounts()).filter((a) => isForwardable(a.provider) && !a.disabled);
    const providers = [...new Set(accounts.map((a) => a.provider))] as SendProvider[];
    const data: Record<string, unknown>[] = [];
    for (const provider of providers) {
      const account = accounts.find((a) => a.provider === provider) ?? null;
      const catalog = await catalogFor(provider, account);
      for (const option of catalog.options) {
        data.push({
          id: option.id,
          object: 'model',
          type: 'model',
          created: 0,
          owned_by: provider,
          display_name: option.label,
        });
      }
    }
    return c.json({ object: 'list', data });
  });

  /**
   * token 估算。
   *
   * 两家上游都没给可用的只读计数接口，真要问就得发一次真请求。这里按字符折算，
   * 返回值明确是估算——客户端拿它做「要不要压缩上下文」的判断足够，当账单用则不行。
   */
  routes.post('/v1/messages/count_tokens', async (c) => {
    let body: AnthropicRequest;
    try {
      body = (await c.req.json()) as AnthropicRequest;
    } catch {
      return badRequest(c, '请求体必须是 JSON');
    }
    const tokens =
      estimateTokens(body.system ?? '') +
      (Array.isArray(body.messages) ? body.messages : []).reduce((sum, m) => sum + estimateTokens(m.content), 0) +
      estimateTokens(body.tools ?? '');
    return c.json({ input_tokens: tokens });
  });

  return routes;
}

/**
 * 网关整体状态。
 *
 * `/api/state` 的首屏和 `/api/gateway` 都要它，因此单独放出来：两处各算一遍的话，
 * 界面上会出现「首屏说 3 个就绪、点一下刷新变成 2 个」这种只能靠读代码解释的差异。
 */
export async function gatewayStatus(deps: GatewayDeps, baseUrl: string): Promise<GatewayStatus> {
  const cfg = deps.config().gateway;
  const accounts = (await deps.accounts()).filter((a) => isForwardable(a.provider));
  const views = deps.pool.views(accounts, deps.states(), cfg);
  const all = [...views.values()];
  return {
    enabled: cfg.enabled,
    baseUrl,
    enabledAccounts: all.filter((v) => v.enabled).length,
    readyAccounts: all.filter((v) => v.state === 'ready' || v.state === 'busy').length,
    keyRequired: cfg.apiKeys.filter(Boolean).length > 0,
  };
}

/** 界面用的管理接口，挂在 `/api` 下，和其余管理路由一样受 Web 凭证保护。 */
export function gatewayAdminRoutes(deps: GatewayDeps, baseUrl: () => string): Hono {
  const routes = new Hono();

  routes.get('/gateway', async (c) => c.json(await gatewayStatus(deps, baseUrl())));

  /** 改某个账户的转发设置：卡片上的开关和优先级都走这里。 */
  routes.patch('/accounts/:id/gateway', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown; priority?: unknown };
    const accounts = await deps.accounts();
    const account = accounts.find((a) => a.id === id);
    if (!account) return c.json({ error: '找不到该账户' }, 404);
    if (body.enabled === true && !isForwardable(account.provider)) {
      return c.json(
        { error: `${account.provider} 账户不能用于 API 转发：它的推理端点要求官方客户端的签名，本程序给不出来` },
        400,
      );
    }
    const patch: { enabled?: boolean; priority?: number } = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (typeof body.priority === 'number' && Number.isFinite(body.priority)) {
      patch.priority = Math.min(99, Math.max(-99, Math.trunc(body.priority)));
    }
    if (Object.keys(patch).length === 0) return c.json({ error: '需要 enabled 或 priority' }, 400);
    deps.store.setGatewayAccount(id, patch);
    // 开关一动，冷却也该清掉：用户明确表达了「再试一次」
    if (patch.enabled) deps.pool.reset(id);
    deps.changed();
    return c.json({ ok: true });
  });

  /**
   * 批量把一组账户加入或退出 API 服务。
   *
   * 卡片上一个个点开关，账户多了就受不了；顶部动作条据此可以「勾一批、一次开/关」。语义和
   * 单个的 PATCH 完全一致——只改 enabled，其余设置不动;不支持转发的 provider 直接跳过而不是
   * 报错整批失败(勾选里混进 Qoder 未来若不支持时也不至于卡住)。开启时同样清掉各自的冷却。
   */
  routes.post('/accounts/gateway/bulk', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown; enabled?: unknown };
    if (typeof body.enabled !== 'boolean') return c.json({ error: '需要 enabled' }, 400);
    const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === 'string') : [];
    const accounts = await deps.accounts();
    // ids 为空按「全部账户」处理，和顶部动作条「未勾选即全部」的约定一致
    const targets = (ids.length === 0 ? accounts : accounts.filter((a) => ids.includes(a.id))).filter((a) =>
      isForwardable(a.provider),
    );
    for (const account of targets) {
      deps.store.setGatewayAccount(account.id, { enabled: body.enabled });
      if (body.enabled) deps.pool.reset(account.id);
    }
    deps.changed();
    return c.json({ ok: true, changed: targets.length });
  });

  /**
   * 设置或清空某个账户的 Qoder PAT。
   *
   * PAT 和导入登录那份令牌是两回事:它在 Qoder 账户页面单独申请,专供 API 转发用。设进来之前
   * 先真去 exchange + userinfo 走一遍——一个换不出 job token 的 PAT 存下来没有意义,只会等到
   * 真有请求进来时才暴露出错。校验通过才落库,顺手清掉旧 PAT 的缓存,并让账户结束冷却归队。
   * 传空串表示清除。
   */
  routes.put('/accounts/:id/gateway/pat', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { pat?: unknown };
    const accounts = await deps.accounts();
    const account = accounts.find((a) => a.id === id);
    if (!account) return c.json({ error: '找不到该账户' }, 404);
    if (!needsPat(account.provider)) {
      return c.json({ error: `${account.provider} 账户不需要 PAT,它用导入登录的令牌直接转发` }, 400);
    }
    const pat = typeof body.pat === 'string' ? body.pat.trim() : '';
    const old = deps.store.gatewayAccount(id)?.pat ?? '';

    if (pat === '') {
      if (old) forgetQoderAuth(old);
      deps.store.setGatewayAccount(id, { pat: '' });
      deps.changed();
      return c.json({ ok: true, hasPat: false });
    }

    // 校验:换一次 job token 再取 uid,任一步失败都别落库
    try {
      const uid = await getUid(pat);
      assertQoderIdentity(uid, account.userId);
      if (old && old !== pat) forgetQoderAuth(old);
      deps.store.setGatewayAccount(id, { pat });
      // PAT 一到位,账户就从「不可用」变成能接活;顺手清掉之前因缺 PAT 攒下的冷却
      deps.pool.reset(id);
      deps.changed();
      return c.json({ ok: true, hasPat: true, uid });
    } catch (err) {
      // 校验失败不动库里那份旧 PAT——用户可能只是贴错了
      forgetQoderAuth(pat);
      const status = err instanceof QoderAuthError ? err.status : 0;
      const message = err instanceof Error ? err.message : String(err);
      const hint = status === 401 || status === 403 ? 'PAT 无效或已过期' : 'Qoder 校验服务暂时不可用';
      return c.json({ error: `${hint}: ${message}` }, 400);
    }
  });

  /** 让一个在冷却或被判耗尽的账户立刻归队。 */
  routes.post('/accounts/:id/gateway/reset', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    deps.pool.reset(id);
    deps.changed();
    return c.json({ ok: true });
  });

  return routes;
}
