# iLink Bot 客户端协议参考

**用途**：为绑定用户直连消息的适配器设计和验收提供证据边界。本文不是微信/iLink 服务端完整规范。

## 来源

- Tencent `openclaw-weixin` 固定提交 `cef0bfc390393f716903e16d50408118047f87e0`：[`protocol.md`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/docs/protocol.md)、[`types.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts)、[`send.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/send.ts)、[`inbound.ts`](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/inbound.ts)。
- QuotaHot 当前适配器与旧规格可用于确认现有实现行为，但联系人会话行为不是新产品契约。

固定客户端源码和协议文档描述客户端观察，不保证服务端支持特定收件人关系、上下文可选性、媒体类型、大小限制、幂等性或最终送达。

## QR 身份和凭证

QuotaHot 当前 Gateway QR 确认流程返回 `bot_token`、`ilink_bot_id`、`ilink_user_id` 和 `baseurl`，其中 `ilink_user_id` 是新产品中绑定用户的唯一消息目标。已有 Gateway QR 流程保持不变，不把 Gateway AppID/Secret-Key 签名混用于 iLink bot 请求。

每个 iLink 请求使用对应绑定记录中的 Bearer bot token、`AuthorizationType: ilink_bot_token`、`X-WECHAT-UIN`、`iLink-App-*` 头和 `base_info`。这些凭证只由服务端持有。协议版本 `2.2.0` / 客户端版本 `131584` 是当前 QuotaHot 常量，应继续与 QuotaHot npm 版本分离；非生产验收记录服务器实际接受情况。

## 入站：`getupdates`

客户端按绑定用户独立轮询 `getupdates`，携带该绑定游标并读取 `msgs` 与新的 `get_updates_buf`。现有解析观察到 `message_id`、`from_user_id`、`to_user_id`、`message_type`、`item_list` 和可选 `context_token`。

Tencent 客户端将 `message_type=USER` 的 `from_user_id` 作为会话的对端身份，并在后续处理上下文中保留该消息的 `context_token`；这描述的是客户端会话模型，不证明该对端等于 QR `ilink_user_id`。直接用户模型须逐条核验入站 owner 与所选绑定一致，才可将消息及其上下文归属到该绑定。不同身份或无法解释的结构不能推断为该绑定用户，也不能创建用户列表的新条目；不依赖全局非生产验收或 readiness 状态。

本地游标只可在一批消息和附件元数据成功持久化后推进；重复投递应按绑定 ID 与远端消息 ID 去重。游标和消息提交失败时保留旧游标。

## 出站：`sendmessage`

QuotaHot 请求包装为 `{ msg: message }`。`msg.from_user_id: ""`、`msg.to_user_id: <当前绑定用户 ilink_user_id>`；每条发送生成新的唯一 `msg.client_id`，它是逐消息 ID，不是跨消息共用的 bot/app 常量。当前 `sender.ts` 已逐次生成 `randomUUID()`，`IlinkBotClient.sendMessage` 已包装 `{ msg: message }`，保留此行为；需将联系人目标解析改为绑定解析，不接受 Web 覆盖目标或 ID。

Tencent `send.ts` 按调用者提供的目标构造 `to_user_id`，并在有值时带 `context_token`；消息类型、消息状态和 `item_list` 也由 sender 填入。客户端允许省略 `context_token`，仅能证明客户端可以构造该请求，**不能证明服务端会接受、建立通信或把消息交付到绑定用户终端**。本功能的回复前提是绑定用户先向平台发送消息，并由服务端验证该入站身份属于当前绑定；回复只使用对应入站消息提供的私有 `context_token`。QR 授权本身不提供该上下文，缺少或无法验证上下文归属时不得发送。

协议文档建议回复时使用对应入站消息的 `context_token`。目前没有证据证明 QR 授权本身会产生可用于给绑定用户发消息的上下文，也没有证据证明 `getconfig` 返回的 typing ticket 可替代该 token。

因此：

- 产品目标的 `to_user_id` 是选中的 `ilink_user_id`，不能取自另一个来信 ID，也不能由浏览器请求体覆盖。
- 每个请求的 `msg.from_user_id` 都是空字符串，`msg.client_id` 每条新生成且唯一，不放在请求根级；本地消息 UUID 可与上游 ID 不同。
- 逐消息唯一不代表上游幂等保证；BOT echo 的实际字段、owner 隔离及可验证关联方式仍须经非生产测试确认。
- 发送与 typing 只使用所选绑定自身已验证入站消息提供的服务端私有 `context_token`。上下文缺失、为空白或归属不确定时返回 context-required，不发起对应上游请求；不接受客户端 token，不借用其他绑定或身份的上下文。不设置全局 readiness、Gate 0 或生产验收前置条件。
- 仅凭 `ret: 0` 记录上游 `accepted`；不能标记“已送达/已读”。网络结果不明标记 `unknown` 且不自动重试。
- 绑定用户须先发来入站消息才能取得回复上下文，这不是联系人回退。入站身份或上下文归属不明时拒绝对应请求；回复未实收或终端结果无法确认时如实记录该次观察，不创建全局发送或发布阻断。不得自动加入联系人/联系人会话或改用其他 ID。

## 媒体

协议客户端定义文本、图片、语音、文件、视频 item，并观察到 `getuploadurl`/CDN 与加密字段。客户端字段不构成服务端能力保证；本次对文本、图片、文件、视频的绑定适配逐类记录实际结果，沿用既有入站语音处理，不新增语音工作。未经确认的 URL、key 编码和文件上限不得猜测或承诺。

语音出站保持当前禁用状态，明确不在本次实现、启用或专项验收范围。所有媒体的 bot token、AES key、签名上传 URL 与 CDN 加密参数只在服务端处理。

## 配置与生命周期

`getconfig`、`sendtyping`、`notifystart`、`notifystop` 属于辅助能力。其调用参数与 typing ticket/上下文之间的关系须按固定客户端形状和已记录的非生产结果核对；typing ticket 不能替代该绑定自身已验证的非空白入站上下文，缺失或归属不确定时 typing 返回 context-required。typing 或生命周期通知失败不得阻止用户手动收发，也不得改动收件人身份。

## 可选非生产联调与历史证据

1. 用一个获授权非生产 QR 绑定（可沿用现有绑定），由该用户先主动发文本，核验入站 owner 并由服务端保存其自身可用上下文，再人工回复同一绑定并在其终端确认实际收到。
2. 回复及 typing 上下文必须来自当前绑定自身已验证的入站消息；不得借用其他绑定、身份或客户端的 `context_token`。上下文缺失、为空白或入站归属无法验证时以 context-required 拒绝对应请求。
3. 多绑定隔离由自动化合成 owner 测试验证发送、入站、上下文和历史；第二个真实绑定仅可选补强，不声称真实多绑定投递已测试。
4. 每条出站使用新生成的唯一 `msg.client_id`；文本、图片、文件、视频分别记录请求和终端结果，语音出站不在范围。
5. 仅记录脱敏步骤、状态和错误类别；不得保存令牌、用户私密内容或签名 URL。

**历史结论（截至 2026-10-22）**：当时 Gate 0 为 **BLOCKED**。2026-10-21 固定 `client_id: ilink_bot_1` 的手动文本尝试得到 `upstream_failure`，未确认终端实收或入站身份，也未证明两个绑定隔离；该观察不能验证修正后的逐消息 ID 契约。2026-10-22 使用当时唯一可发送绑定和新生成的 `msg.client_id` 无上下文尝试直发，客户端返回 `invalid_response`，未确认终端实收或入站归属，未测试真实双绑定投递。BrowserSkill 标签借用等待确认超时，未重试。

**后续观察（2026-10-23）**：操作者确认唯一标记文本已在终端实收，但当时使用联系人级路由且 HTTP 504、UI 结果未知，未核验 owner 或上下文归属；这不构成 API 成功或绑定直连契约证据。

**后续观察（2026-10-24）**：一个获授权非生产绑定已核验 owner-scoped 入站及自身上下文；操作者确认人工回复的文本标记收到，并在同一对话回复“已收到”。首个合成小 PNG 显示空白，随后以用户提供的 `logo.jpeg` 重测且终端显示正确；文件内容正确；用户提供的 MP4 收到且可播放。完整证据、当次旧 gate 注入方式和限制见 [research.md](../research.md)。真实多绑定投递未测试，API 未返回独立送达或已读状态。T003/T036/T046 已完成记录；旧 Gate 0/readiness 结论已由 2026-10-24 用户批准的移除决定取代，不再作为发送或发布条件。不以联系人或独立本地 Conversation 流程替代。
