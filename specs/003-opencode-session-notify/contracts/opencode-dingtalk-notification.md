# OpenCode 与 DingTalk 通知契约

## 配置

建议由 `quotahot-hook` 提供显式配置命令或交互入口，写入 `$QUOTAHOT_DATA_DIR/session-notify.json`：
文件缺失时等同于 `enabled=false`、`target=null`、`authorizedAt=null`，不会发送。

```json
{
  "version": 1,
  "enabled": true,
  "target": {
    "openConversationId": "<经用户指定并核验的群 ID>",
    "displayName": "<核验后的群名称>"
  },
  "authorizedAt": "<ISO-8601>"
}
```

配置时必须回显并让用户确认群身份，以及该配置会使未来符合条件的 OpenCode 会话自动发送最终答复。未启用或无法重新核实群身份时关闭发送。

## OpenCode 插件事件

- 输入：OpenCode 插件 `event` 回调提供的事件对象和 session ID。
- 候选触发：`session.idle`。
- 处理：使用 OpenCode client 查询该 session 的消息，按创建时间和消息完成状态选择最终面向使用者的 assistant 消息；忽略 user/tool 消息和未完成消息。
- 取消/错误/删除事件：不发送；实现须按实际支持版本验证事件顺序与终态语义。
- 空正文或无可发送正文：不调用 DWS，在插件运行结果报告原因。

## DingTalk 发送

- 唯一路由键：配置中核验的 `openConversationId`。
- DWS 接口：`dws chat +send-to-group --group <openConversationId> --content <chunk> --yes --format json`；每次返回 `openTaskId` 后用 `dws chat +messages-query-send-status --open-task-id <openTaskId> --format json` 核验。以上路径已在 DWS v1.0.64 通过用户授权的短消息与 1 KiB 分段实测。
- 用户已明确授权该配置目标的持续自动发送；仅配置文件明确 `enabled=true` 且用户已启用后，插件才为该固定目标附加 `--yes`。不得把授权扩展到其他群或私聊。
- 返回处理必须区分明确成功、明确失败与未知；不能只以进程退出码或 JSON 存在宣称成功。
- 每段（含 `i/n` 标记）最多 1024 UTF-8 字节；此值是当前环境已验证可投递的客户端上限，不声称为 DWS 服务端最大值。仅在 Unicode code point 边界切分。
- 超长消息按序分段为 `i/n`；仅在前一段状态查询明确为 `SUCCESS` 后发送下一段；只有全部片段明确成功时返回整体成功。DWS 未公开全局到达顺序保证。
- DWS 幂等键仅在当前 Schema 明确支持且语义已验证时使用；不能声称 exactly-once。未知投递状态不自动重试。

## 用户可见结果

通过 OpenCode 插件 UI 呈现 `sent`、`partial`、`failed`、`unknown` 和未发送原因。消息正文、认证信息、访问令牌不得进入插件日志或可见错误。完成消息可以由用户在目标群看到；本地错误信息只保留必要状态与脱敏原因。
