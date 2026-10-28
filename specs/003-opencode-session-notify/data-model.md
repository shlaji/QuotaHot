# 数据模型

## 通知配置

- `version`: literal `1`，配置结构版本。
- `enabled`: boolean，用户是否明确启用持续自动通知；缺少配置文件时默认 false。
- `target`: `NotificationTarget | null`；未配置目标时为 null。
- `authorizedAt`: ISO-8601 时间或 null；仅用户显式启用自动发送后记录。

约束：`enabled=true` 时 `target` 与 `authorizedAt` 必填；配置独立存放于 `$QUOTAHOT_DATA_DIR/session-notify.json`，不包含凭证或访问令牌。读取群资料失败、身份不匹配或未启用时不得发送。

## 通知目标

- `openConversationId`: string，精确群身份；必填，不允许使用名称相似度回退。
- `displayName`: string，保存配置时通过 DWS 群资料读取并展示的确认名称；仅作识别，不作为路由键。

## 会话完成通知

- `sessionId`: string，OpenCode 会话标识。
- `assistantMessageId`: string，最终面向使用者的 assistant 消息标识。
- `completionKey`: string，由会话标识与最终消息标识构成的稳定去重键。
- `messageDigest`: string，最终正文的本地摘要，用于检测同一键正文意外变化，不保存完整消息正文。
- `partCount`: positive integer，分段总数。
- `state`: `in_progress | sent | partial | failed | unknown`。
- `ownerPid`: positive integer，当前持有该发送尝试的 `quotahot-hook` 进程 ID；仅 `in_progress` 状态需要。
- `sentParts`: integer array，已收到成功回执的片段序号，从 1 开始。
- `updatedAt`: ISO-8601 时间。
- `reason`: optional string，脱敏后的失败/未知原因。

## 状态转换

`in_progress` 可转为 `sent`、`partial`、`failed` 或 `unknown`。重复完成事件发现同一记录仍由存活进程持有时不重复发送；若 owner PID 已退出，则转为 `unknown`，不假设上游未收到。`unknown` 不自动转回发送中；需由用户检查目标群后显式重试或标记已处理。`sent` 是终态，不重复发送。

同一 `completionKey` 的并发和重复事件必须共用一条 ledger 记录。不同 session 或不同最终消息不得共享发送状态。

## 分段策略

- 客户端每段上限固定为 1024 UTF-8 字节，包含 `i/n` 顺序标记；该值是当前 DWS v1.0.64 环境中已验证可投递的保守本地上限，不代表服务端最大值。
- 只在 Unicode code point 边界切分；不得截断正文或把一个 code point 拆到相邻分段。
- 每一段获得明确的 `SUCCESS` 回执后才发送下一段；任何未知回执都会停止后续分段，不自动重试。
