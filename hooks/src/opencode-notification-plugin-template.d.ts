import type { NotificationChunkResultValue, NotificationSendInput } from './notification-schema.js';

export type NotificationPluginClient = {
  readonly session: {
    messages(input: { readonly path: { readonly id: string } }): Promise<unknown>;
  };
  readonly tui?: {
    showToast?(input: { readonly body: { readonly message: string; readonly variant: string } }): Promise<unknown>;
  };
  readonly app?: {
    log?(input: { readonly body: { readonly service: string; readonly level: string; readonly message: string } }): Promise<unknown>;
  };
};

export type SessionNotificationPluginOptions = {
  readonly client: NotificationPluginClient;
  readonly send?: (payload: NotificationSendInput) => Promise<NotificationChunkResultValue>;
};

export type SessionNotificationPlugin = {
  event(input: { readonly event: unknown }): Promise<void>;
  dispose(): void;
};

export function createSessionNotificationPlugin(options: SessionNotificationPluginOptions): SessionNotificationPlugin;
export const SessionNotification: (options: SessionNotificationPluginOptions) => Promise<SessionNotificationPlugin>;
export default SessionNotification;
