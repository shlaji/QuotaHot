/** 同一 Qoder 身份下的三种独立客户端会话，不跨客户端复用令牌。 */
export type QoderClient = 'qoder-cli' | 'qoder-desktop' | 'qoder-ide';

export interface QoderClientTarget {
  readonly client: QoderClient;
  readonly label: string;
  readonly path: string;
  readonly available: boolean;
  readonly reason: string;
  readonly current: boolean;
}

export interface QoderSwitchResult {
  readonly client: QoderClient;
  readonly label: string;
  readonly accountId: string;
  readonly backupPath: string;
  readonly restarted: boolean;
  readonly note: string;
}

export function isQoderClient(value: unknown): value is QoderClient {
  return value === 'qoder-cli' || value === 'qoder-desktop' || value === 'qoder-ide';
}
