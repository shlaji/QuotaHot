export class WechatApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(ERROR_LABELS[code] ?? `请求失败（HTTP ${status}），请重试。`);
  }
}

const ERROR_LABELS: Readonly<Record<string, string>> = {
  wechat_upstream_auth_failed: '微信上游认证失败，请重试或重新扫码。',
  wechat_identity_missing: '授权身份信息不完整，绑定未完成，请重新扫码。',
  wechat_flow_required: '扫码流程已失效，请重新生成二维码。',
  wechat_binding_not_found: '绑定已不存在，请刷新绑定列表。',
  wechat_upstream_unavailable: '微信服务暂不可用，请稍后重试。',
  wechat_login_capacity: '扫码请求过多，请稍后重试。',
  wechat_invalid_request: '请求内容无效，请检查后重试。',
  invalid_response: '服务返回的数据不完整，请刷新重试。',
};

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new WechatApiError(200, 'invalid_response');
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new WechatApiError(200, 'invalid_response');
  return value;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new WechatApiError(200, 'invalid_response');
  return value;
}
function variant<const T extends string>(value: unknown, choices: readonly T[]): T {
  const result = choices.find((choice) => choice === value);
  if (result === undefined) throw new WechatApiError(200, 'invalid_response');
  return result;
}
function parseQr(value: unknown) {
  const body = record(value);
  return { attemptId: text(body.attemptId), qrSvg: text(body.qrSvg), expiresAt: number(body.expiresAt) };
}
function parseQrStatus(value: unknown) {
  const body = record(value);
  return { status: variant(body.status, ['waiting', 'scanned', 'expired', 'unavailable', 'unverified', 'confirmed']) };
}
const parseStatus = (value: unknown) => ({ status: text(record(value).status) });

async function request<T>(path: string, init: RequestInit, parse: (value: unknown) => T): Promise<T> {
  const response = await fetch(`/api/wechat${path}`, { ...init, credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json' } });
  let body: unknown;
  try { body = await response.json(); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new WechatApiError(response.status, response.ok ? 'invalid_response' : 'http_error');
  }
  if (!response.ok) {
    const error = body !== null && typeof body === 'object' && 'error' in body ? body.error : undefined;
    throw new WechatApiError(response.status, typeof error === 'string' ? error : 'http_error');
  }
  return parse(body);
}

export const wechatApi = {
  startQr: (signal: AbortSignal) => request('/qrcode', { method: 'POST', signal }, parseQr),
  pollQr: (id: string, signal: AbortSignal) => request(`/qrcode/${encodeURIComponent(id)}`, { method: 'GET', signal }, parseQrStatus),
  cancelQr: (id: string, signal: AbortSignal) => request(`/qrcode/${encodeURIComponent(id)}`, { method: 'DELETE', signal }, parseStatus),
  unlink: (bindingId: string, signal: AbortSignal) => request(`/bindings/${encodeURIComponent(bindingId)}`, { method: 'DELETE', signal },
    (value) => ({ status: variant(record(value).status, ['unlinked']) })),
};

export type WechatQr = Awaited<ReturnType<typeof wechatApi.startQr>>;
export type WechatQrStatus = Awaited<ReturnType<typeof wechatApi.pollQr>>['status'];
