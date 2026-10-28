# Implementation Plan: OpenCode Session Group Notification

**Branch**: `003-opencode-session-notify` | **Date**: 2026-10-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-opencode-session-notify/spec.md`

## 概要

在独立的 `hooks/` 包中增加单独安装的 OpenCode 通知插件。确认会话候选完成后，通过 OpenCode client 读取最后一条面向使用者的 assistant 消息；按用户授权的 1024 UTF-8 字节本地上限拆分为带顺序标识的 DingTalk 群消息，并通过插件 UI 报告投递状态。保持现有额度切换插件及恢复行为不变。DWS 不公开服务端最大长度或 exactly-once 语义；实现不得宣称这些未验证保证。

## 技术上下文

**语言/版本**：`hooks/` CLI 使用 TypeScript ESM，插件模板使用 JavaScript；Node.js `>=24`。

**主要依赖**：现有 `quotahot-hook` 包、Zod v4（本地配置和 DWS JSON 边界解析）、运行时注入的 OpenCode plugin client 和已安装的 `dws` CLI；不新增 OpenCode 或 DWS SDK。

**存储**：在 `QUOTAHOT_DATA_DIR` 下独立保存通知配置和投递记录；不得将通知状态写入根应用的 `config.json` 或凭证文件。

**测试**：运行 `cd hooks && npm run typecheck && npm test && npm run build`；单元与集成测试使用伪造的 OpenCode client 和 `dws` 可执行文件。自动化测试不得向真实群发送消息。

**目标平台**：Node.js 24+ 上的 OpenCode plugin runtime；安装沿用现有 Linux/macOS shell 流程，Windows 使用 Node CLI。

**项目类型**：包含已安装 OpenCode 插件模板的独立 Node CLI。

**性能目标**：规格未定义数值延迟目标。通知处理必须有界，避免 DWS 卡住后无限阻塞 OpenCode 事件回调；须在验证支持的 DWS 调用方式后确定超时值。

**约束**：只使用精确的 `openConversationId`；不回退到其他收件人或渠道；持续发送前必须由用户显式启用；日志不得包含凭证或完整令牌；本地重复处理不得再次提交已知发送；每段含标记不超过 1024 UTF-8 字节；所有分段都成功才算完整送达。

**规模/范围**：每个本地 hook 安装仅配置一个群；并发会话互相隔离。不增加根应用 Web UI、多群路由或根服务依赖。

## 章程检查

*门禁：阶段 0 研究前必须通过，阶段 1 设计完成后重新检查。*

- **I. 可预期且可见的界面交互**：通过。OpenCode 插件 UI 显示已配置群身份，并区分 sent、failed、unknown 等结果。
- **II. 按功能组织且职责分层的代码结构**：通过。通知配置、消息分段、投递和插件事件集成放在职责清晰的 `hooks/` 模块中；不导入根应用。
- **III. 契约与行为可验证**：通过。为完成状态分类、最终消息选择、分段顺序、重复事件、DWS 结果和失败路径增加测试。
- **IV. 凭证与额度操作安全**：附带运行时门禁通过。只使用配置的精确群 ID，要求用户显式启用，避免暴露凭证，且不得绕过 DWS 运行时确认策略。用户已于 2026-10-22 授权持续发送。
- **V. 控制复杂度并保持可维护性**：通过。复用现有插件入口和本地 hook 包；未经证实的需要不新增服务或 SDK。
- **VI. 中文文档与代码注释**：通过。新增项目文档和代码注释使用中文；技术标识符和原始 API 名称保持原文。

**门禁条件**：DWS v1.0.64 中用户明确授权后使用 `--yes` 的非交互发送已通过短消息和两段各 1024 字节 UTF-8 的手动测试；每段状态查询均为 `SUCCESS`。这只证明所测环境和大小，不证明服务端长度上限、全局到达顺序或 exactly-once。实现必须要求显式配置授权、逐段串行查询状态、非明确成功归 `unknown` 且不自动重试。

## 项目结构

### 设计文档

```text
specs/003-opencode-session-notify/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── opencode-dingtalk-notification.md
└── checklists/
    └── requirements.md
```

### 源码（仓库根目录）

```text
hooks/src/
├── notification-schema.ts        # Zod v4 schema 与推导类型
├── notification-config.ts       # 通知配置与群身份
├── notification-delivery.ts     # DWS 调用、分段顺序与投递结果
├── notification-ledger.ts       # 会话/消息级去重状态
├── opencode-notification-plugin.ts # 独立通知插件生命周期与 UI 反馈
├── index.ts                     # 配置/状态 CLI 入口
└── install.ts                   # 插件安装归属

hooks/scripts/build.mjs          # 通知插件 ESM bundle 与 release 打包

hooks/test/
├── notification-config.test.ts
├── notification-delivery.test.ts
├── notification-ledger.test.ts
└── plugin-notification.test.ts
```

**结构决策**：在现有独立 `hooks/` 包中实现，使用 TypeScript entry 单独打包为 ESM `quotahot-session-notify.js` 并安装，不向已有超长 `opencode-plugin-template.js`（额度切换与恢复）追加通知逻辑。通知配置和 ledger 独立保存在 `QUOTAHOT_DATA_DIR` 下；Zod 与 schema 随 CLI/plugin bundles 打包，不要求 OpenCode 插件目录有 `node_modules`。

## 复杂度记录

无章程违规；不计划增加服务、数据库迁移或根应用集成。

## 阶段 0/1 设计文档

- 研究与决策：[research.md](research.md)
- 实体与状态转换：[data-model.md](data-model.md)
- OpenCode/DWS 与本地配置契约：[contracts/opencode-dingtalk-notification.md](contracts/opencode-dingtalk-notification.md)
- 手动验证：[quickstart.md](quickstart.md)
