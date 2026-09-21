/** 对后端 API 的轻量封装。 */
import type {
  AppConfig,
  AutoRefreshResult,
  ForceRefreshResult,
  ImportCandidate,
  ImportResult,
  LoginMode,
  LoginStart,
  LoginStatus,
  ModelCatalog,
  LogEntry,
  Provider,
  RequestLogPage,
  SchedulerStatus,
  SendNowResult,
  ServerEvent,
  SourcePathResult,
  StateResponse,
  SyncToClientResult,
  UsageResult,
} from '../shared/types.js';
import type { QoderClient, QoderClientTarget, QoderSwitchResult } from '../shared/qoder.js';
import type { GatewayStatus } from '../shared/gateway.js';
import type { AccountOrder } from '../shared/account-order.js';

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(input, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${resp.status}`);
  return body as T;
}

export const api = {
  state: () => json<StateResponse>('/api/state'),
  saveConfig: (cfg: AppConfig) =>
    json<AppConfig>('/api/config', { method: 'PUT', body: JSON.stringify(cfg) }),
  setAccountOrder: (provider: string, ids: string[]) =>
    json<{ accountOrder: AccountOrder }>('/api/account-order', {
      method: 'PUT',
      body: JSON.stringify({ provider, ids }),
    }),
  /** 启动调度；ids 为空表示纳入全部可保活账户。 */
  start: (ids: string[] = []) =>
    json<SchedulerStatus>('/api/scheduler/start', { method: 'POST', body: JSON.stringify({ ids }) }),
  stop: () => json<SchedulerStatus>('/api/scheduler/stop', { method: 'POST' }),
  sendNow: (id: string) =>
    json<SendNowResult>(`/api/accounts/${encodeURIComponent(id)}/send-now`, {
      method: 'POST',
    }),
  /** 批量测试；ids 为空表示全部账户。 */
  sendNowMany: (ids: string[]) =>
    json<SendNowResult[]>('/api/send-now', { method: 'POST', body: JSON.stringify({ ids }) }),
  accountRequests: (id: string, limit = 50) =>
    json<RequestLogPage>(`/api/accounts/${encodeURIComponent(id)}/requests?limit=${limit}`),
  sources: () => json<ImportCandidate[]>('/api/accounts/sources'),
  /** 改这个来源读哪个路径；path 传空串表示恢复默认位置。 */
  setSourcePath: (source: string, path: string) =>
    json<SourcePathResult>(`/api/accounts/sources/${encodeURIComponent(source)}/path`, {
      method: 'PUT',
      body: JSON.stringify({ path }),
    }),
  importAccounts: (sources: string[]) =>
    json<ImportResult>('/api/accounts/import', {
      method: 'POST',
      body: JSON.stringify({ sources }),
    }),
  importTokenFiles: async (files: readonly File[]): Promise<ImportResult> => {
    const form = new FormData();
    for (const file of files) form.append('files', file);
    const resp = await fetch('/api/accounts/import-files', { method: 'POST', body: form });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${resp.status}`);
    return body as ImportResult;
  },
  qoderClients: (id: string) =>
    json<QoderClientTarget[]>(`/api/accounts/${encodeURIComponent(id)}/qoder-clients`),
  qoderSwitch: (id: string, client: QoderClient) =>
    json<QoderSwitchResult>(`/api/accounts/${encodeURIComponent(id)}/qoder-switch`, {
      method: 'POST',
      body: JSON.stringify({ client, confirm: true }),
    }),
  /** 无条件换一份新 token；只对自动刷新的账户有效。 */
  forceRefresh: (id: string) =>
    json<ForceRefreshResult>(`/api/accounts/${encodeURIComponent(id)}/refresh-token`, {
      method: 'POST',
    }),
  /** 把当前 token 写回该账户对应的客户端配置文件；Codex 会同时写两个文件，故按文件返回一组结果。 */
  syncToClient: (id: string) =>
    json<SyncToClientResult[]>(`/api/accounts/${encodeURIComponent(id)}/sync-to-client`, {
      method: 'POST',
    }),
  /**
   * 切换续期方式：false 即跟随原客户端，本程序只同步不刷新。
   * 两个方向都会先核对本机客户端登录的是不是同一个账户，结论在 note 里，改为跟随时对不上会报错。
   */
  setAutoRefresh: (id: string, autoRefresh: boolean) =>
    json<AutoRefreshResult>(`/api/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ autoRefresh }),
    }),
  removeAccount: (id: string) =>
    json<{ removed: string }>(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  loginStart: (provider: Provider, mode: LoginMode = 'redirect') =>
    json<LoginStart>('/api/login/start', {
      method: 'POST',
      body: JSON.stringify({ provider, mode }),
    }),
  loginCancel: (loginId: string) =>
    json<{ ok: boolean }>('/api/login/cancel', {
      method: 'POST',
      body: JSON.stringify({ loginId }),
    }),
  loginStatus: (loginId: string) =>
    json<LoginStatus>(`/api/login/status?loginId=${encodeURIComponent(loginId)}`),
  loginComplete: (loginId: string, input: string) =>
    json<{ accountId: string }>('/api/login/complete', {
      method: 'POST',
      body: JSON.stringify({ loginId, input }),
    }),
  models: (refresh = false) => json<ModelCatalog>(`/api/models${refresh ? '?refresh=1' : ''}`),
  /** 只读额度查询；ids 为空表示全部账户。 */
  usage: (ids: string[] = []) =>
    json<UsageResult[]>('/api/usage', { method: 'POST', body: JSON.stringify({ ids }) }),
  accountUsage: (id: string) =>
    json<UsageResult>(`/api/accounts/${encodeURIComponent(id)}/usage`, { method: 'POST' }),
  logs: (limit = 200) => json<LogEntry[]>(`/api/logs?limit=${limit}`),
  /** API 服务的整体状态：接到哪里、要不要带 key、此刻有几个账户能接活。 */
  gateway: () => json<GatewayStatus>('/api/gateway'),
  /** 改某个账户的转发设置。只传要改的那一项，另一项保持不动。 */
  setAccountGateway: (id: string, patch: { enabled?: boolean; priority?: number }) =>
    json<{ ok: boolean }>(`/api/accounts/${encodeURIComponent(id)}/gateway`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  /**
   * 批量把一组账户加入或退出 API 服务；ids 为空表示全部账户。
   * 语义和单个的 setAccountGateway 一致，只改 enabled。
   */
  setAccountGatewayMany: (ids: string[], enabled: boolean) =>
    json<{ ok: boolean; changed: number }>('/api/accounts/gateway/bulk', {
      method: 'POST',
      body: JSON.stringify({ ids, enabled }),
    }),
  /** 让一个在冷却里的账户立刻归队。 */
  resetAccountGateway: (id: string) =>
    json<{ ok: boolean }>(`/api/accounts/${encodeURIComponent(id)}/gateway/reset`, {
      method: 'POST',
    }),
  /**
   * 设置或清空某个账户的 Qoder PAT；传空串表示清除。
   * 服务端会先拿它去 Qoder 换一次令牌校验，换不出来就不落库并返回错误。
   */
  setAccountPat: (id: string, pat: string) =>
    json<{ ok: boolean; hasPat: boolean; uid?: string }>(
      `/api/accounts/${encodeURIComponent(id)}/gateway/pat`,
      { method: 'PUT', body: JSON.stringify({ pat }) },
    ),
};

/** 订阅 SSE，返回一个取消订阅函数。 */
export function subscribeEvents(
  onEvent: (e: ServerEvent) => void,
  onStatusChange: (connected: boolean) => void,
): () => void {
  const source = new EventSource('/api/events');
  source.onopen = () => onStatusChange(true);
  source.onerror = () => onStatusChange(false); // EventSource 会自行重连
  source.onmessage = (ev) => {
    if (!ev.data) return;
    try {
      onEvent(JSON.parse(ev.data) as ServerEvent);
    } catch {
      /* 忽略心跳帧和其他非 JSON 数据帧 */
    }
  };
  return () => source.close();
}
