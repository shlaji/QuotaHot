export type TargetType = 'person' | 'group';
export interface Target {
  readonly targetType: TargetType;
  readonly targetId: string;
  readonly displayName: string;
}
export type Candidate = Target & { readonly department?: string };
export interface SearchResult {
  readonly items: readonly Candidate[];
  readonly complete: boolean;
}
export interface Capability {
  readonly available: boolean;
  readonly reason: string;
  readonly dwsVersion?: string;
}
export interface SubscriptionState {
  readonly subscriptionId: string;
  readonly targetType: TargetType;
  readonly targetId: string;
  readonly state: 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed' | 'interrupted';
}
export interface ActiveTarget {
  readonly activeTarget: Target | null;
  readonly listeningDesired: boolean;
  readonly subscriptionState: SubscriptionState | null;
}
const ERROR_MESSAGES = {
  auth: '钉钉连接认证失败，请检查 QuotaHot 访问认证和服务端授权。',
  unavailable: '钉钉可选服务不可用，请检查同源代理配置后重新检查连接。',
  rejected: '目标选择被拒绝，请重新搜索并核对完整候选结果。',
  malformed: '钉钉服务响应格式不符合契约，请检查服务版本和代理配置。',
  network: '无法连接钉钉可选服务，请检查网络后重试。',
} as const;
export class DingtalkInboxApiError extends Error {
  constructor(readonly code: keyof typeof ERROR_MESSAGES) {
    super(ERROR_MESSAGES[code]);
    this.name = 'DingtalkInboxApiError';
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new DingtalkInboxApiError('malformed');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new DingtalkInboxApiError('malformed');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new DingtalkInboxApiError('malformed');
  return value;
}
function optionalText(value: unknown): string | undefined {
  if (value === undefined || typeof value === 'string') return value;
  throw new DingtalkInboxApiError('malformed');
}
function targetType(value: unknown): TargetType {
  if (value === 'person' || value === 'group') return value;
  throw new DingtalkInboxApiError('malformed');
}
function target(value: unknown): Target {
  const data = object(value);
  return { targetType: targetType(data.targetType), targetId: text(data.targetId), displayName: text(data.displayName) };
}
function subscription(value: unknown): SubscriptionState {
  const data = object(value);
  const state = data.state;
  if (state !== 'starting' && state !== 'ready' && state !== 'stopping' && state !== 'stopped' && state !== 'failed' && state !== 'interrupted') {
    throw new DingtalkInboxApiError('malformed');
  }
  optionalText(data.failureCode);
  optionalText(data.failureMessage);
  return { subscriptionId: text(data.subscriptionId), targetType: targetType(data.targetType), targetId: text(data.targetId), state };
}
function capability(value: unknown): Capability {
  const data = object(value);
  if (typeof data.reason !== 'string') throw new DingtalkInboxApiError('malformed');
  const dwsVersion = optionalText(data.dwsVersion);
  return { available: boolean(data.available), reason: data.reason, ...(dwsVersion === undefined ? {} : { dwsVersion }) };
}
function searchResult(value: unknown, kind: TargetType): SearchResult {
  const data = object(value);
  if (!Array.isArray(data.items)) throw new DingtalkInboxApiError('malformed');
  const complete = boolean(data.complete);
  const items = data.items.map((value: unknown): Candidate => {
    const item = object(value);
    const base = { targetType: kind, targetId: text(kind === 'person' ? item.userId : item.openConversationId), displayName: text(item.displayName) };
    const department = kind === 'person' ? optionalText(item.department) : undefined;
    return { ...base, ...(department === undefined ? {} : { department }) };
  });
  return { items, complete };
}
function activeTarget(value: unknown): ActiveTarget {
  const data = object(value);
  const activeTarget = data.activeTarget === null ? null : target(data.activeTarget);
  const subscriptionState = data.subscriptionState === null ? null : subscription(data.subscriptionState);
  if (subscriptionState !== null && (activeTarget === null || subscriptionState.targetType !== activeTarget.targetType || subscriptionState.targetId !== activeTarget.targetId)) {
    throw new DingtalkInboxApiError('malformed');
  }
  return { activeTarget, subscriptionState, listeningDesired: boolean(data.listeningDesired) };
}
async function request(path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/dingtalk-inbox${path}`, {
      ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new DingtalkInboxApiError('network');
  }
  if (!response.ok) throw new DingtalkInboxApiError(response.status === 401 || response.status === 403 ? 'auth'
    : response.status === 400 || response.status === 409 ? 'rejected' : 'unavailable');
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new DingtalkInboxApiError('malformed');
  try {
    const data: unknown = await response.json();
    return data;
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new DingtalkInboxApiError('malformed');
  }
}
export const dingtalkInboxApi = {
  async capability(signal: AbortSignal): Promise<Capability> {
    return capability(await request('/capability', { signal }));
  },
  async search(kind: TargetType, query: string, signal: AbortSignal): Promise<SearchResult> {
    const route = kind === 'person' ? 'people' : 'groups';
    return searchResult(await request(`/${route}/search?${new URLSearchParams({ query })}`, { signal }), kind);
  },
  async activeTarget(signal: AbortSignal): Promise<ActiveTarget> {
    return activeTarget(await request('/active-target', { signal }));
  },
  async select(selected: Target, signal: AbortSignal): Promise<SubscriptionState> {
    const dto = target(selected);
    const result = subscription(await request('/active-target', { method: 'PUT', signal, body: JSON.stringify(dto) }));
    if (result.targetType !== dto.targetType || result.targetId !== dto.targetId) throw new DingtalkInboxApiError('malformed');
    return result;
  },
};
export type DingtalkInboxApi = typeof dingtalkInboxApi;
