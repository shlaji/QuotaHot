# 数据模型：微信绑定用户直连消息

**功能规格**：[spec.md](./spec.md) · **实施计划**：[plan.md](./plan.md) · **研究记录**：[research.md](./research.md)

## 身份边界

1. **平台使用者**：访问 QuotaHot 的操作者，沿用全局 Web `accessGuard`、按部署配置启用的 Basic Auth 和同源/跨站保护；不以 QR 绑定身份作为浏览器登录身份。
2. **绑定用户**：二维码授权返回的 `ilink_user_id`，是用户列表中的唯一身份，也是新直连消息的唯一产品目标。
3. **消息**：平台使用者与该绑定用户之间的入站或出站记录。它直接归属绑定用户，不存在 Contact 或独立本地 Conversation 实体、UI、API，也没有另一个可选择收件人。

选择绑定用户后，读取其消息或发送消息不再要求提供第二个用户标识。API 请求体不得接受 `from_user_id`、`to_user_id`、联系人 ID 或上下文 token。

解除的目标由 `DELETE /api/wechat/bindings/{bindingId}` 的路径指定，成功返回 `status: unlinked`；列表、解除、消息、typing 及附件不要求持久 `quotahot_wechat` cookie。运行时行为仍须独立验证。

**核验移除决定（2026-10-25）**：旧逐绑定核验依赖扫码确认后保留的 QR 轮询 capability，仅存在于进程内存，重启后消失，不能表示持久绑定的运行时状态。因此移除该能力及其状态模型，不持久化 QR capability，也不新增替代核验或伪健康端点。扫码尝试仍保留自身短期内存状态和 flow-cookie 保护；实际通信使用持久绑定凭证及收件箱生命周期。

## 持久化边界

- 现有微信绑定存储继续持有 QR 绑定身份和私有 bot 凭证；密钥仅供服务端使用。
- 新直连消息及其媒体、每绑定用户的游标和经过验证的私有传输上下文保存在 QuotaHot 私有数据目录中，跨正常重启保留且不自动过期。
- 在同一 `inbox.db` 中建立 owner-scoped 的 `inbox_binding_contexts`、`inbox_binding_messages`、`inbox_binding_items`、`inbox_binding_attachments` 和 `inbox_binding_chunks`；绑定表及每 owner 游标可复用现有安全存储。当前结构表缺失时创建，已存在时保留其数据。新表只使用绑定用户归属，不对旧联系人消息做数据迁移。
- 首次切换时直接删除旧历史表：`wechat/conversations.db` 中的 `wechat_conversations`、`wechat_messages`；`wechat/inbox.db` 中的 `inbox_contacts`、`inbox_messages`、`inbox_contexts`、`inbox_attachments`、`inbox_items`、`inbox_chunks`。不读取、迁移、复制或恢复旧 schema/历史内容，也不重建整个数据库文件。
- 必须保留 `inbox_bindings`、入站传输游标 `inbox_cursors`、所有当前 `inbox_binding_*` 表及其数据，以及 `wechat/wechat.db` 中的 QR 凭证；既有 `wechat_sessions` 哈希表及旧行仅惰性保留，不读取、续期、新建或接受旧会话，不再作为有效实体或访问凭证。未知或不相关表和数据保持不变。不得清理 `state.db`、`tasks.db` 或任何无关文件。
- 一次性重置状态由各数据库自己的 version 1 完成标记表示：`inbox.db` 使用 `wechat_inbox_migrations`，`conversations.db` 使用 `wechat_local_migrations`。已有完成标记表示旧表清理已结束，后续启动不得再次删除新直连消息或附件；不得仅因重置实现变更而升级标记并重做清理。
- 每库重置在独立事务中进行。inbox 库在同一事务内删除允许的旧表、创建缺失的当前结构并写入完成标记；会话库删除允许的旧表并写入完成标记。失败时回滚该库的删表和标记，重启后可重试；两库不承诺跨文件单一原子事务。
- 删除前检查是否存在从非目标表指向待删除表的外键关系。若删除会触发对保护数据的级联或破坏非目标表引用，则回滚该库并报告初始化失败；不通过关闭外键强行删除。仅存在无关未知表或旧表列结构不同，不构成拒绝重置的理由。
- 附件使用本地持久化标识和有界分块读取；外部 CDN 地址、加密参数和 AES key 不作为用户可见字段。
- 数据文件沿用现有私有目录访问权限；对 Web/API 只返回安全摘要和消息内容。

## 实体

### BoundUser（绑定用户）

对应一次稳定 QR 身份；同一 `ownerIlinkUserId` 至多一条有效绑定。

| 字段 | 类型 | 用途 |
|---|---|---|
| `ownerIlinkUserId` | 字符串 | QR 返回的绑定身份及应用内稳定键 |
| `botId` | 字符串 | 连接所需的非秘密展示/诊断标识 |
| `botToken`、`baseUrl` | 私有凭证 | 只供服务端发起 iLink 请求，不出现在 DTO 或日志 |
| `createdAt` / `updatedAt` | ISO-8601 | 首次绑定及最近一次成功重新授权时刻 |
| `authorizationState` | 枚举 | `active`、`relogin_required`、`unlinked` |
| `connectionState` | 枚举 | `starting`、`polling`、`backoff`、`stopped`、`unlinked` |
| `lastInboundAt` | ISO-8601/null | 最近一条已验证并保存的入站消息时刻 |

**规则**：重新授权相同 `ownerIlinkUserId` 更新其凭证并保留其直连消息历史；不同 ID 独立。保留收件箱实际 `connectionState`、授权失效的 `relogin_required`、`replyContextState` 及 `canSend` 摘要，表达当前连接、只读和发送行为，不来源于 QR 核验结果。授权成功或 poller 正在运行不能替代该绑定的入站上下文校验；不定义独立 readiness 状态、DTO 或生产验收开关。

### AuthorizationAttempt（二维码授权尝试）

授权尝试保留现有短期 QR 流程状态和内存边界，不创建持久浏览器会话实体。服务端用短期 `quotahot_wechat_flow` cookie 校验本次 attempt 的轮询和取消；仅知道 attempt ID 不足以操作流程。该 cookie 不用于绑定管理或消息鉴权；成功响应不再包含浏览器会话令牌或会话到期语义，也不签发 `quotahot_wechat`。

开始尝试不改变任何现有绑定。只有返回有效 `ownerIlinkUserId` 且对应凭证保存成功，尝试才可完成：新身份创建一条绑定，已有相同身份只更新该身份凭证。取消、切离页面、过期、上游失败、身份无法确认或凭证保存失败时，所有既有绑定的身份、凭证、授权状态及消息历史均保持不变，且不得报告绑定成功。若确认过程中已停止旧 poller/worker，确认失败后的回滚须恢复原有通信，不依赖确认后长期保留的 QR capability。二维码入口与流程状态位于绑定列表区，不维护顶部浏览器会话状态。

### Message（绑定用户消息）

一条平台与绑定用户间的消息，按绑定用户直接排序和游标分页。UI 首次读取最新页，向上滚动至历史边界自动读取更早页并保持阅读位置，不依赖手动按钮；请求及结果均限定 owner，切换绑定后丢弃过期结果。

| 字段 | 类型 | 用途 |
|---|---|---|
| `id` | UUID | 本地消息标识 |
| `clientId` | 字符串/null | 出站时生成的逐消息唯一 ID，对应 `msg.client_id`；可与本地 `id` 不同 |
| `ownerIlinkUserId` | 字符串 | 唯一所属绑定用户 |
| `remoteMessageId` | 字符串/null | 上游消息 ID；用十进制字符串保留大整数精度 |
| `direction` | 枚举 | `inbound` / `outbound` |
| `kind` | 枚举 | `text`、`image`、`voice`、`file`、`video`、`protocol_event` |
| `state` | 枚举 | `received`、`queued`、`uploading`、`sending`、`accepted`、`failed`、`unknown` |
| `sequence` | 整数 | 绑定用户消息流中的稳定顺序 |
| `createdAt` | ISO-8601 | 已验证的上游时间或本地接收/发送时间 |
| `items` | 有序列表 | 文本项或指向本地附件的媒体项 |

**关联与校验**：所有读取、发送、分页和去重均按 `ownerIlinkUserId` 限定。同一远端消息 ID 在一个绑定用户范围内去重；不同绑定之间不得合并。入站 owner 必须与该绑定一致；不匹配或无法判定时不得创建另一个可选对象、不得并入任一绑定用户的普通消息流，应记录不含敏感原始内容的安全协议失败。

每条出站消息的本地 `id` 独立且唯一。请求使用 `{ msg: message }`，其中 `msg.from_user_id` 为空字符串，`msg.to_user_id` 为当前绑定用户的 `ownerIlinkUserId`；每条发送生成新的唯一 `msg.client_id`，不得跨消息共用常量。当前 sender 已逐次生成 UUID，客户端已包装 `{ msg }`，应保留该行为。逐消息 ID 不证明上游幂等或 echo 关联语义，回显匹配仍须验证身份和真实协议证据。

### PollCursor（轮询游标）

每个绑定用户最多一个不透明游标。处理入站批次时，消息/媒体元数据和新游标须在同一事务内保存；持久化失败时回滚整批并保留旧游标。进程重启后只恢复已提交游标。

### PrivateTransportContext（私有传输上下文）

绑定用户须先向平台发送入站消息，才能取得回复所需的 `context_token`。保存最近一个通过绑定身份校验的入站消息上下文，关联键只能是该入站身份已验证对应的 `ownerIlinkUserId`。该值仅服务端可读，不下发到 Web，不用于猜测、匹配或回退到其他收件人，也不接受客户端提供的 token。发送和 typing 均须逐次校验所选绑定自己的上下文；缺失、为空白或归属无法确认时返回 context-required，不发起对应上游请求。QR 授权成功本身不产生上下文；无需全局 readiness、Gate 0 或生产验收状态。

### Attachment（附件）

通过 `attachmentId` 与一条绑定用户消息项关联，保存安全文件名、校验后的 MIME、字节长度、校验摘要及分块数据。下载通过受认证的本地附件路由读取；不依赖 CDN URL 长期有效。凭证、AES key、上传 URL、签名参数和原始异常响应不得保存在 Web DTO 或普通日志。

## 状态转换

### 授权和连接

- 授权：未绑定 → `active`；重复授权同一身份更新凭证；授权身份缺失或存储失败不得产生成功状态。
- 连接：`stopped → starting → polling ↔ backoff`；上游授权失效转为 `relogin_required`；解绑转为 `unlinked`。
- 解除仅作用于路径指定的本地有效绑定，停止该用户收发但保留消息及附件历史，不撤销微信上游授权；相同身份重新授权后可恢复通信。关闭浏览器、离开页面或旧 cookie 失效不触发绑定状态转换。
- 回复上下文：仅由该绑定 owner 匹配的入站消息提供；缺失、为空白或归属不确定时，发送和 typing 返回 context-required。连接 `polling` 不产生上下文，不维护验收驱动的消息能力状态。

### 出站消息

- 文本：`queued → sending → accepted`。
- 媒体：`queued → uploading → sending → accepted`。
- 已确认业务拒绝或上传失败转 `failed`。
- 请求超时或断连导致结果不确定时转 `unknown`，不得自动重发；`accepted` 仅表示上游接受请求，不表示送达或已读。
- 语音出站保持当前 disabled 状态，本次不启用、不新增语音实现或专项验收。

## DTO 与保密字段

绑定用户 DTO 可包含绑定 ID、非秘密显示标识、时间、授权/连接状态及该绑定回复上下文是否可用的安全摘要，不包含独立 readiness 字段。摘要不能替代发送和 typing 时的服务端上下文校验。消息 DTO 可包含本地消息 ID、方向、类型、状态、时间、文本及本地附件 ID。以下内容绝不返回：`botToken`、`context_token`、AES key、CDN 加密参数、签名 URL、远端请求原始响应或内部错误堆栈。
