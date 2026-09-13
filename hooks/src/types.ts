export type Provider = 'claude' | 'codex' | 'qoder';

export type Window = {
  readonly name: string;
  readonly resetAt: number;
  readonly usedPercent: number | null;
  readonly windowMinutes: number | null;
  readonly source: string;
};

export type Account = {
  readonly id: string;
  readonly provider: Provider;
  readonly email: string;
  readonly path: string;
  accountId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  readonly disabled: boolean;
  readonly plan: string;
  readonly subscriptionEndsAt: number;
  readonly userId: string;
  readonly source: string;
  readonly autoRefresh: boolean;
  readonly syncPath: string;
  readonly syncSource: string;
  idToken: string;
};

export type UsageResult = {
  readonly accountId: string;
  readonly provider: Provider;
  readonly email: string;
  readonly ok: boolean;
  readonly status: number;
  readonly error: string;
  readonly plan: string;
  readonly subscriptionEndsAt: number | null;
  readonly userId: string;
  readonly quotaAvailable: boolean | null;
  readonly windows: readonly Window[];
  readonly endpoint: string;
};

export type ConfigChange = {
  readonly field: string;
  readonly before: string;
  readonly after: string;
};

export type SyncResult = {
  readonly path: string;
  readonly source: string;
  readonly label: string;
  readonly created: boolean;
  readonly backupPath: string;
  readonly changes: readonly ConfigChange[];
  readonly warning: string;
  readonly error: string;
};
