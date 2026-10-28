export type SendOutcome = 'accepted' | 'failed' | 'unknown';
export type InboxConflictCode = 'wechat_inbox_context_required' | 'wechat_inbox_binding_read_only';

export class InboxApiError extends Error {
  constructor(readonly status: number, readonly outcome: 'failed' | 'unknown' = 'failed', readonly code?: InboxConflictCode) {
    super(status === 401 ? '访问认证已失效，请重新认证后刷新。'
      : code === 'wechat_inbox_context_required' ? '当前绑定尚无自己的入站消息上下文，请先让该用户发送消息。'
        : status === 409 ? '当前绑定暂不能发送，请刷新绑定状态。'
        : status === 404 ? '绑定用户或附件已不可用，请刷新列表。'
          : status === 400 ? '请求内容不受支持，请检查消息或附件。'
            : '请求未完成，请检查网络或服务状态。');
  }
}
