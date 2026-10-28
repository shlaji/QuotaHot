# 任务：OpenCode 会话完成群通知

**输入**：`/specs/003-opencode-session-notify/` 中的设计文档

**前置条件**：`plan.md`、`spec.md`、`research.md`、`data-model.md`、`contracts/opencode-dingtalk-notification.md`、`quickstart.md`

**测试**：规格要求可测试的验收行为；所有外部调用使用 fake OpenCode client 和 fake `dws`，自动化测试不得向真实群发送消息。

**组织方式**：按用户故事划分阶段；任务 ID 按执行顺序连续编号。

## 阶段 1：初始化

**目的**：确认 hook 包现有插件入口与测试/构建约定。

- [X] T001 阅读并记录 `hooks/src/opencode-plugin-template.js`、`hooks/src/index.ts`、`hooks/src/install.ts`、`hooks/package.json` 的现有插件导出、CLI 和测试构建契约；在 `specs/003-opencode-session-notify/research.md` 记录 DWS v1.0.64 与 OpenCode 1.19.3 运行时证据

## 阶段 2：基础门禁与共享能力

**目的**：在用户故事实现前验证外部运行时契约并建立共用 schema；本阶段门禁失败时停止后续故事实施。

- [X] T002 验证目标 DWS v1.0.64 在用户明确授权后能以 `--yes` 向精确目标发送；记录成功回执和 status 查询结果，明确失败/未知回执 schema 与幂等保证未发布，并规定非明确成功一律归 unknown 且不自动重试；证据见 `specs/003-opencode-session-notify/research.md`
- [X] T003 依用户授权在指定测试群顺序发送两条各 1024 字节 ASCII 合成分段并查询回执；记录两段 `SUCCESS`，采用 1024 UTF-8 字节作为客户端上限但不宣称为 DWS 服务端最大值，证据见 `specs/003-opencode-session-notify/research.md`
- [X] T004 核对 OpenCode 1.19.3 版本化源码中的 `session.idle`、部分取消/错误/删除路径顺序，以及 session messages 的 `info`/`parts`/completed/error 字段；记录全局顺序未保证和保守筛选规则到 `specs/003-opencode-session-notify/research.md`
- [X] T005 [P] 在 `hooks/test/notification-schema.test.ts` 先写并运行 Zod v4 配置、目标、ledger、DWS 成功/预发送校验回执与 OpenCode session-message schema 测试；确认测试在对应 schema 缺失时失败
- [X] T006 在 `hooks/package.json` 与 `hooks/package-lock.json` 增加 Zod v4 运行依赖，在 `hooks/src/notification-schema.ts` 定义配置、目标、会话消息、ledger 与发送回执 schema/推导类型，并移除被替代的 `hooks/src/notification-types.ts`；通过 T005 测试

**门禁检查点**：T002–T004 的证据已记录。T003 只证明当前环境接受 1024 UTF-8 字节客户端上限，不证明 DWS 服务端最大值或全局到达顺序。未知投递状态不得自动重试。

## 阶段 3：用户故事 1 - 配置通知群（优先级：P1）

**目标**：使用者可用精确群标识配置并查看已确认的唯一目标；未配置、未启用或身份无法确认时不发送。

**独立测试**：在临时 `QUOTAHOT_DATA_DIR` 中配置唯一有效群后读回相同 ID 和核验名称；无效、缺失、匹配不唯一或未授权时保持禁用且不调用发送器。

### 用户故事 1 测试

- [X] T007 [P] [US1] 在 `hooks/test/notification-config.test.ts` 覆盖未配置默认禁用、有效配置持久化、schema 错误拒绝、CLI 确认群身份/显式启用、用法错误退出码和无副作用，以及临时目录隔离
- [X] T008 [P] [US1] 在 `hooks/test/notification-target.test.ts` 用 fake DWS 覆盖精确 `openConversationId` 核验、名称回读、ID 不匹配和 DWS 失败

### 用户故事 1 实现

- [X] T009 [US1] 在 `hooks/src/notification-config.ts` 使用 `hooks/src/notification-schema.ts` 读取/校验 `$QUOTAHOT_DATA_DIR/session-notify.json`，实现原子写入和缺失配置默认禁用
- [X] T010 [US1] 在 `hooks/src/notification-target.ts` 通过只读 `dws chat +conversation-info` 核验精确群 ID，并用 `notification-schema.ts` 解析目标回执；失败时不启用目标
- [X] T011 [US1] 在 `hooks/src/cli-types.ts`、`hooks/src/cli-help.ts`、`hooks/src/notification-cli.ts` 抽离共享 flags/错误、帮助常量和通知 handler，并在 `hooks/src/index.ts` 保留统一解析/派发；支持 `notify configure/status/disable` 和 `notify enable --yes`
- [X] T012 [US1] 在 `hooks/README.md` 增加中文通知配置、查看/撤销授权、精确群路由与凭证保护说明

**检查点**：US1 完成后，用户可核验配置目标；默认未配置为禁用，且没有有效授权时没有发送路径。

## 阶段 4：用户故事 2 - 通知会话最后一条 AI 消息（优先级：P1）

**目标**：只在验证为有效完成且目标已授权时向指定群发送最后一条完整 assistant 消息；长消息按序分段，同一完成消息不重复发送。

**独立测试**：fake OpenCode 会话包含多条 assistant、user 和工具消息；触发有效完成后仅目标群收到最终 assistant 正文。重放相同完成事件或重启后不得重复发送；取消、错误、删除、无正文和无效目标均不发送。

### 用户故事 2 测试

- [X] T013 [P] [US2] 在 `hooks/test/notification-ledger.test.ts` 覆盖 completionKey 并发互斥、in-progress 崩溃恢复为 unknown、sent 终态和不同会话隔离
- [X] T014 [P] [US2] 在 `hooks/test/notification-delivery.test.ts` 用 fake DWS 覆盖目标固定、1024 UTF-8 字节分段、片段顺序/总数、全部成功、部分失败及未知结果不重试
- [X] T015 [P] [US2] 在 `hooks/test/plugin-notification.test.ts` 覆盖最终 assistant 选择与通知插件的 idle/error/delete 事件路由、并发 session 隔离及状态 toast

### 用户故事 2 实现

- [X] T016 [US2] 在 `hooks/src/notification-ledger.ts` 实现 `$QUOTAHOT_DATA_DIR/session-notify-ledger.json` 原子状态读取/更新，以 `sessionId + assistantMessageId` 为 completionKey；重启遗留 in-progress 归为 unknown
- [X] T017 [US2] 在 `hooks/src/notification-delivery.ts` 以 `dws chat +send-to-group --group <openConversationId> --content <chunk> --yes --format json` 发送；解析 `openTaskId` 并查询 `chat +messages-query-send-status`，仅 `SUCCESS` 才发送下一段，unknown 不重试
- [X] T018 [US2] 在 `hooks/src/notification-message.ts` 按 T004 已验证字段选择最新 user 消息之后、已完成且无 error 的 assistant 文本 parts；排除 user、tool、中间及未完成消息
- [X] T019 [US2] 在 `hooks/src/opencode-notification-plugin-template.js` 实现独立通知插件模板，监听候选 `session.idle`，查询 session.messages 并通过 stdin 将响应传给 `notify send-session`；不得修改 quota 插件模板
- [X] T020 [P] [US2] 在 `hooks/test/notification-config.test.ts` 为 `quotahot-session-notify.js` 独立文件 `--print`、安装/卸载所有权和 quota/foreign 插件保护编写并通过测试
- [X] T021 [US2] 在 `hooks/src/opencode-plugin.ts`、`hooks/src/install.ts` 与 `hooks/src/notification-cli.ts` 增加通知模板生成及独立安装/卸载入口，保留原有 `quotahot.js`
- [X] T022 [P] [US2] 在 `hooks/test/build.test.ts` 为通知模板分发及搬迁后 `notify install --print` 编写失败测试
- [X] T023 [US2] 在 `hooks/scripts/build.mjs` 与 `hooks/package.json` 将 `opencode-notification-plugin-template.js` 加入 dist 和 release 文件清单
- [X] T024 [US2] 在 `hooks/test/plugin-notification.test.ts` 验证生成的通知插件通过 stdin 向 hook CLI 传递 session messages，隔离 session 正文且保留 quota 插件文件
- [X] T025 [US2] 在 `hooks/src/notification-cli.ts` 实现 `notify send-session` 载荷解析、配置/目标核验、ledger claim、分段投递和状态落库
- [X] T026 [US2] 在 `hooks/test/plugin-integration.test.ts` 增加隔离通知插件安装/卸载与重复完成事件测试；确认 quota 插件切换/恢复路径不变

**检查点**：US2 完成后，fake DWS 记录只能包含配置群和最终 assistant 内容；每段发送后查询状态，未知投递不会自动重发。

## 阶段 5：用户故事 3 - 了解通知结果（优先级：P2）

**目标**：使用者可从 OpenCode 插件运行结果辨认已发送、部分发送、失败、待确认和未发送原因。

**独立测试**：分别注入明确成功、明确失败、部分片段失败、超时/回执未知及无最终消息；确认 UI 状态准确，凭证、token 和完整正文不进入错误日志。

### 用户故事 3 测试

- [X] T027 [P] [US3] 在 `hooks/test/plugin-notification.test.ts` 覆盖 sent 状态 toast、non-idle/deleted 路由和并发 session 隔离

### 用户故事 3 实现

- [X] T028 [US3] 在 `hooks/src/opencode-notification-plugin-template.js` 将通知投递状态映射到 OpenCode toast/app log，展示状态和脱敏原因，不输出 DWS 原始凭证或完整消息正文

**检查点**：US3 完成后，每种投递结果都有不误导且脱敏的 OpenCode 可见反馈。

## 阶段 6：完善与横切验证

**目的**：完成包级验证与手动集成演练，不修改用户真实配置或在自动测试中发送真实群消息。

- [X] T029 [P] 在 `specs/003-opencode-session-notify/quickstart.md` 和 `hooks/README.md` 记录已验证 DWS/OpenCode 版本、1024 字节客户端分段策略和真实群手动验收步骤
- [X] T030 运行 `cd hooks && npm run typecheck && npm test && npm run build` 并修复本功能造成的失败；确认 CLI bundle 与两个 OpenCode 插件文件一同构建
- [X] T031 在隔离 HOME、临时 `QUOTAHOT_DATA_DIR` 和 fake DWS 下执行 `specs/003-opencode-session-notify/quickstart.md` 的端到端场景；不得覆盖真实 OpenCode 配置或发送真实消息
- [X] T032 对照 `specs/003-opencode-session-notify/spec.md`、`plan.md` 和 `contracts/opencode-dingtalk-notification.md` 检查 FR-001 至 FR-009 与三个用户故事的覆盖，并在本任务文件将已完成任务标记为 `[X]`

---

## 依赖关系与执行顺序

### 阶段依赖

- 初始化（阶段 1）与运行时证据（阶段 2）已完成；先完成 schema 测试/实现后开始用户故事。
- US1 依赖通知 schema；US2 依赖 US1 的已授权配置和目标身份；US3 依赖 US2 的投递状态。
- 完善阶段依赖所有用户故事实现和测试完成。

### 用户故事依赖

- US1（P1）：依赖基础 schema；可独立验证目标设置/查看/禁用，是 US2 的配置前置条件。
- US2（P1）：依赖 US1 的有效通知目标；负责最终消息和群投递。
- US3（P2）：依赖 US2 定义的投递状态；只增加状态呈现与脱敏行为。

### 可并行机会

- T005 schema 测试可独立编写；T007 与 T008 可并行。
- US2 的 T013、T014、T015 可并行编写；T020 与 T022 可并行编写安装/构建测试。
- 不同阶段按依赖顺序执行；同一测试文件的修改必须串行。

## 实施策略

### MVP（US1）

1. 使用已完成的 T002–T004 运行时证据；先完成 T005–T006 schema 验证。
2. 完成 US1，核验精确群身份、持续授权和默认禁用；此时不得发送会话消息。
3. US1 可单独验收，但正式发送能力由 US2 增加。

### 增量交付

1. US1 提供可确认的目标配置，但未显式启用时不发送。
2. US2 添加最终消息选择、1024 字节分段、逐段状态查询和本地 ledger。
3. US3 添加成功/失败/未知状态反馈与脱敏。
4. 完成 hook 类型检查、测试、build 和隔离 quickstart 后，才由用户手动执行真实会话验收。
