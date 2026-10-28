# 研究与决策

## OpenCode 会话完成事件

- Decision: 在 OpenCode `1.19.3` 中只把 `session.idle` 作为候选触发信号。通知前重新查询消息；仅当最新 user 消息之后存在一条已设置 `time.completed`、未设置 `error` 的 assistant 消息，且包含可发送文本时才继续。取消、错误、缺少最终消息、读取失败、session 删除或状态不一致时不发送。
- Rationale: 官方插件通知示例将 `session.idle` 用作完成通知示例，但 v1.19.3 源码中它表示进入 idle，不保证成功完成，也不包含最终正文。SDK 的 session messages 返回 `info` 和 `parts`，可以检查消息角色、完成时间、错误及文本片段；SDK 类型没有承诺列表最后一项必然是成功的最终答复。
- Event-order constraint: v1.19.3 的 `SessionStatus.set` 在 idle 时先发布 `session.status` 再发布 `session.idle`；部分错误路径先发 `session.error` 后转 idle，删除实现先发 deleted 再移除事件。但全局错误/取消/删除顺序未承诺，且插件 dispatcher 不等待异步 event hook 完成。实现必须在消息查询返回时重新核对最新 user/assistant 状态，不依赖全局事件顺序。
- Alternatives considered: 仅靠 idle 会把取消或失败误认为成功；仅靠 `message.updated` 会把中间 assistant 输出当最终答复；无条件取最后 assistant 会在新 user turn 尚未完成时转发上一轮答复。
- Evidence: [v1.19.3 session-status-event.ts](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/schema/src/session-status-event.ts); [status.ts](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/session/status.ts); [processor.ts](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/session/processor.ts); [session.ts](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/session/session.ts); [SDK generated types](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/sdk/js/src/v2/gen/types.gen.ts); [官方通知示例](https://opencode.ai/docs/plugins/#send-notifications); [仓库当前插件消息读取](../../hooks/src/opencode-plugin-template.js)。

## DingTalk 群发送与授权

- Decision: 唯一目标是配置时核验过的精确 `openConversationId`。用户于 2026-10-22 明确授权已配置群持续自动直发；只有配置明确启用后，插件才使用 DWS `--yes`。
- Runtime evidence: 已安装 DWS CLI `v1.0.64`（commit `e2c0cdf97e016ee76687d9c26986c23a26a84738`）。按用户指示，精确单聊和群聊的短测试命令带 `--yes` 执行，均返回 `success=true` 与 `openTaskId`，后续 `chat +messages-query-send-status` 均返回 `sendStatus=SUCCESS`。收件人、群、消息及任务 ID 未写入项目文档。
- Constraints: 当前两个 send Schema 仍为 `confirmation=user_required`；用户的产品级持续授权由通知配置明确记录。`chat +messages-send` 的 `idempotency=unknown`；`uuid`/`idempotency-key` 参数存在，但没有承诺 exactly-once；`result` 和 `data_schema` 未发布。实测仅覆盖成功结果；所有错误、超时、缺字段或未知状态按 unknown 处理，不能自动重试。随机无效 task ID 查询返回 `PARAM_ERROR/openTaskId解密失败`，不代表有效任务的 unknown 状态。
- Alternatives considered: 每条通知交互确认不符合用户已确认的持续自动发送行为；Webhook/Bot 需额外身份与权限，不在规格范围；按群名称路由会带来歧义，违反精确目标约束。

## 长消息分段

- Decision: 每段（含 `i/n` 标识）最多 1024 UTF-8 字节，只在 Unicode code point 边界切分。逐段串行发送，只有上一段状态明确为 `SUCCESS` 才发送下一段；所有分段都成功才记整体 sent。明确失败记 partial/failed；未知状态记 unknown 且不重发未知片段。
- Rationale: 用户授权在指定测试群顺序发送两段各 1024 字节 ASCII 合成消息；两段均经 status 查询得到 `SUCCESS`。因此 1024 UTF-8 字节是当前环境已验证可用的保守客户端上限。
- Limitation: DWS v1.0.64 Schema 未发布服务端最大长度、长度计量单位、Markdown 计数规则、全局到达顺序或分段幂等保证。1024 字节不是服务端最大值，顺序策略依靠等待前一段成功后再发下一段。
- Alternatives considered: 截断违背完整传递意图；使用未经验证的服务端上限或对 unknown 自动重试可能导致漏发/重复，均不采用。

## 幂等与存储

- Decision: 本地 ledger 以 session ID 与最终 assistant message ID 构成 completion key；发送前原子记录 in-progress，明确成功后记 sent，明确失败记 failed/partial，超时或结果不完整记 unknown。并发同键仅一个发送者进入。
- Rationale: 规格要求同一会话同一次完成不重复通知；DWS 不保证服务端幂等，不能声称 exactly-once。重启时遗留的 in-progress 转为 unknown，不自动重发。
- Alternatives considered: 仅内存状态无法覆盖 reload/restart；发送后才落库有并发重复窗口；发送前直接标 sent 会在崩溃时误报成功。

## 插件边界

- Decision: 通知安装为独立 `quotahot-session-notify.js` OpenCode 插件，复用 `hooks/` 安装路径但不修改既有 `opencode-plugin-template.js`。
- Rationale: 现有 quota 插件模板超过 600 行且负责切换/恢复；独立通知插件避免扩大其职责与体积。hook 包不导入根 Web 应用。
- Evidence: [Hook package README](../../hooks/README.md); [quota plugin template](../../hooks/src/opencode-plugin-template.js); [hook installer](../../hooks/src/install.ts); [hook tests](../../hooks/test/plugin-events.test.ts)。
