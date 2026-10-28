# Web SSE 契约

服务接口：`GET /api/v1/events`，Bearer 服务认证，响应 `Content-Type: text/event-stream`。QuotaHot 可选代理至同源 `/api/dingtalk-inbox/events`；代理须原样流式转发，不缓冲事件，且不得拥有或控制 DWS consumer 生命周期。

客户端断开只移除该客户端的 SSE 连接，不停止独立服务拥有的 DWS 订阅。客户端重连后先读取 `GET /active-target` 与 `GET /messages` 校准本地视图；不得据此创建第二个 DWS consumer。QuotaHot 代理重启或停止不得改变该订阅。

所有事件的 JSON data 均包含 `occurredAt`。入站消息事件必须包含 `targetType`、`targetId`、`subscriptionId`，不能依赖浏览器当前选中项决定归属。出站消息状态使用 `targetType`、`targetId` 和 `clientMessageId` 关联，不要求虚构订阅代次。

## `subscription.state`

```json
{
  "subscriptionId": "local-generation-id",
  "targetType": "person",
  "targetId": "dws-user-id",
  "state": "ready",
  "occurredAt": "2026-10-21T00:00:00Z"
}
```

`state` 取值：`starting`、`ready`、`stopping`、`stopped`、`failed`、`interrupted`。失败事件可有经脱敏的 `failureCode`、`failureMessage`；不得包含 token、原始 stdout/stderr 或正文。

## `message.received`

```json
{
  "targetType": "group",
  "targetId": "open-conversation-id",
  "subscriptionId": "local-generation-id",
  "message": {
    "localId": "local-message-id",
    "conversationId": "open-conversation-id",
    "eventId": "event-id",
    "messageId": "message-id",
    "senderId": "sender-id",
    "senderName": "显示名",
    "direction": "inbound",
    "contentType": "text",
    "content": "消息正文",
    "sourceTime": "2026-10-21T00:00:00Z",
    "receivedAt": "2026-10-21T00:00:01Z",
    "storedAt": "2026-10-21T00:00:01Z",
    "sendState": "not_applicable"
  },
  "occurredAt": "2026-10-21T00:00:01Z"
}
```

服务端先校验目标和去重，再持久化消息，最后发此事件。重复消息不再广播。没有稳定消息归属或身份矛盾时仅发诊断状态，不向聊天窗展示正文。

## `message.send-state`

包含 `targetType`、`targetId`、`clientMessageId`、`message` 与 `occurredAt`；`message.sendState` 只能是 `pending`、`accepted`、`failed`、`unknown`。`accepted` 表示 DingTalk 明确接受发送请求，不代表对方已收到或已读；`unknown` 表示无法确认上游是否接受。消息状态先持久化再广播，浏览器重连后以消息查询恢复状态，不自动重新发送 `unknown` 消息。

## 持久化与重连

消息事件只在消息成功持久化后发布。客户端断开期间收到或更新的消息可通过 `GET /messages` 恢复；独立服务重启后旧订阅代次不能继续报告 `ready`，若监听意图仍有效则为当前目标创建新代次，并等待其 ready marker。SSE 不承诺事件重放或补回 DWS 停机期间未收到的消息。代理错误或断连不改变独立服务状态。
