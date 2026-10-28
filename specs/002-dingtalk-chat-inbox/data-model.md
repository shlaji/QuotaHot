# DingTalk Message Inbox 数据模型

## 范围

模型描述一个独立 DingTalk Inbox 服务实例中由同一个服务端 DWS profile 管理的消息目标、订阅及消息。QuotaHot 是可选客户端，不拥有该模型或数据库。人员 ID 与群会话 ID 是不同身份域，不可互换。第一版同时只有一个当前活动目标；切换目标时旧订阅先被干净停止。当前目标及监听意图持久化，独立服务重启后自动为该目标创建新的订阅代次。

## 实体

### 消息目标 `DingtalkTarget`

| 字段 | 类型 | 约束与用途 |
|---|---|---|
| `targetType` | `person \| group` | 目标类别，决定稳定 ID 域及 DWS 命令 |
| `targetId` | string | person 为当前 profile 下的 `userId`；group 为 `openConversationId` |
| `displayName` | string | 来源于同次真实搜索结果，仅用于界面展示，不能用于订阅或发送路由 |
| `profileKey` | string | 当前专用 DWS profile 的内部非敏感身份键，不保存认证材料 |
| `listeningDesired` | boolean | 持久化的监听意图；显式停止或切换目标时清除，服务关闭/重启不清除 |
| `createdAt` | RFC 3339 | 目标首次进入本地记录的时间 |
| `updatedAt` | RFC 3339 | 最近一次身份/展示名确认时间 |

**唯一性**：`(profileKey, targetType, targetId)` 唯一。不同 `targetType` 下即使 ID 字符串相同也不得合并。

### 事件订阅 `DingtalkSubscription`

| 字段 | 类型 | 约束与用途 |
|---|---|---|
| `subscriptionId` | string | 独立服务生成的订阅代次 ID，用于隔离切换前后的迟到事件 |
| `targetType` / `targetId` | string | 指向唯一目标，启动后不可变 |
| `eventKey` | string | person 私聊固定 `user_im_message_receive_o2o`；group 固定 `user_im_message_receive_group` |
| `state` | enum | `starting`、`ready`、`stopping`、`stopped`、`failed`、`interrupted` |
| `startedAt` / `endedAt` | RFC 3339? | 当前进程生命周期的起止时间 |
| `failureCode` / `failureMessage` | string? | 结构化错误类别和经脱敏的用户提示；不得含 token 或原始敏感事件正文 |
| `processHandle` | 运行时引用 | 仅进程内保存，不持久化到 SQLite 或 API 响应 |

状态转换：`starting -> ready -> stopping -> stopped`；`starting/ready/stopping -> failed`。服务重启时，旧订阅代次变为 `interrupted`，不得复用持久化的 `ready` 状态；若目标的 `listeningDesired` 为 true，服务自动创建新代次并从 `starting` 开始，仅在收到该代次的 DWS ready marker 后进入 `ready`。运行时不可用或启动失败时保持非就绪状态并报告原因。显式停止将 `listeningDesired` 置为 false，因此重启后不恢复该订阅。停止旧目标并收尾其已读取事件后才创建新目标订阅。

### 消息 `DingtalkMessage`

| 字段 | 类型 | 约束与用途 |
|---|---|---|
| `localId` | string | 独立服务本地消息键 |
| `profileKey` | string | 消息来源 profile |
| `targetType` / `targetId` | string | 消息归属目标，必须从拥有该事件的订阅上下文确定 |
| `conversationId` | string | DWS 事件中的真实 `conversation_id`，用于会话隔离和审计 |
| `eventId` | string? | DWS 事件 ID，用于事件重复投递去重 |
| `messageId` | string? | DWS 消息 ID，用于消息级去重及交叉核验 |
| `senderId` / `senderName` | string? | 发送者稳定 ID 及显示名 |
| `direction` | `inbound \| outbound` | 入站或本平台发出 |
| `contentType` | `text` | 第一版只承诺文本 |
| `content` | string | 正文；不写入常规日志 |
| `sourceTime` | RFC 3339? | 上游提供的消息时间 |
| `receivedAt` | RFC 3339 | 本地接收时间 |
| `storedAt` | RFC 3339 | 本地持久化时间；作为 30 天保留期限的统一起算时间 |
| `sendState` | `not_applicable \| pending \| accepted \| failed \| unknown` | 出站结果；`accepted` 仅表示 DWS 明确接受请求，不代表对方已收到或已读；不能确认的结果为 `unknown` |

**去重键**：优先使用 `(profileKey, conversationId, messageId)`；若上游缺少 `messageId`，用事件 ID `(profileKey, eventId)`；若两者均缺失则不猜测去重键，并在诊断状态中记录缺字段。事件流中的消息归属使用订阅启动时绑定的 `targetType/targetId`，不得取浏览器当前选中项覆盖。

## 关系与生命周期

- 一个目标可有多条历史订阅记录，但同一独立服务实例任一时刻最多一条 `starting/ready/stopping` 订阅。
- 目标可有多条消息；每条消息只属于一个目标和一个 `conversationId`。
- 收到事件后先按订阅代次校验并持久化/去重，再发布浏览器 SSE；持久化失败不得发布为已保存消息。
- 目标及 `listeningDesired` 跨独立服务重启持久化；旧订阅记录保留为 `interrupted`，恢复监听时创建新 `subscriptionId`，不复用进程内句柄或旧就绪状态。QuotaHot 客户端重启不得影响该状态。
- 仅当持久化目标的 `profileKey` 与当前显式配置的 DWS profile 匹配时才自动恢复；profile 不匹配或不可用时保持非就绪状态并要求重新搜索/授权，不将旧 profile 的 ID 用于订阅。
- 入站及出站消息均持久化，并在聊天视图重新打开后恢复。消息按 `storedAt` 起算保留 30 天，过期后自动删除；重启期间未解决的出站 `pending` 结果不得推断为 `accepted`。
- 消息存于独立服务专属数据目录的服务数据库，不能包含 profile token、refresh token、AppSecret 或 DWS 原始 credential 文件内容。QuotaHot 不打开、挂载或共享此数据库。

## 校验规则

- `person` 只能携带同 profile 搜索返回的 `userId`；`group` 只能携带同 profile 群搜索返回的 `openConversationId`。
- 搜索零命中、多候选、结果不完整或没有稳定 ID 时禁止启动订阅和发送。
- person 目标只接收一对一消息事件；群内该用户的消息不属于 person 目标。
- 发送请求的目标必须与当前活动目标一致；目标切换期间拒绝过期目标提交。
- `accepted` 仅表示 DWS 明确回报已接受发送请求，不表示对方已收到或已读；无法确认的结果必须保持 `unknown`。
- 不将 DWS 二进制输出、认证信息或未经解析的完整事件 envelope 返回浏览器。
