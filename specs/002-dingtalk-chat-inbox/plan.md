# DingTalk 消息收件箱实施计划

**分支**: `dingtalk-chat` | **日期**: 2026-10-21 | **规格**: [spec.md](./spec.md)

**输入**: 功能规格 `specs/002-dingtalk-chat-inbox/spec.md`

## 概要

新增独立部署的 DingTalk Inbox 服务，支持搜索用户与群、明确选择单一目标、订阅实时消息事件、按会话路由展示及文本回复。服务通过受支持的 `dws` CLI 子进程执行搜索、事件消费和发送，并独立拥有其数据、配置和生命周期；消息持久化并保留 30 天，服务重启后按持久化监听意图重建订阅。QuotaHot 是可选 REST/SSE 客户端，不构建或运行该服务、不承载业务状态。不把 Agent Skill 当作服务 API，也不直接依赖其内部 Go SDK。

**运行时方案已选定；实现前与完成前验收分阶段进行**：DWS 仓库提供宿主子进程契约，可据此完成设计。实现前须验证独立包可脱离 QuotaHot 构建/启动/存储，并在已授权 profile 下验证搜索、目标订阅 ready 和发送回执。独立服务的监听意图恢复依赖服务自己的持久化和生命周期代码，须在 US2 实现后立即作为强制集成门禁验证，不能作为实现前置条件。用户于 2026-10-22 明确要求基于当前唯一专用 profile 和指定非生产目标继续实现；此前 CLI 搜索/监听/发送证据见 `quickstart.md`。该指令允许进入实现，不代表独立服务 OS 配置、私有目录权限或重启恢复已验证。未通过剩余验收前不得宣称可部署，也不得降级到轮询或联系人/会话模式。

## 全局约束

- 独立服务使用自有 Node.js 24+ TypeScript 包、Hono、SQLite、依赖锁、测试/构建入口和发布版本；不得导入 QuotaHot 源码、共享其数据库/凭证/配置或要求其包参与构建。部署必须显式提供经契约验证的 `dws` 可执行程序。
- QuotaHot Web 集成是可选消费者，通过版本化 REST/SSE 契约访问独立服务；独立服务无需 QuotaHot 存在即可工作。
- 新增规划文档及代码注释使用中文；命令、路径、代码标识符、API 名称和原始错误保持原文。
- 搜索、事件消费和发送仅可在当前授权及组织权限内执行；令牌不得进入 DTO、界面、日志或错误文本。
- 仅对唯一明确选择的用户或群操作；不依据名称相似度、搜索顺序或历史使用记录选定目标。
- 实时消息按可验证的会话身份路由；无法确认归属的事件不得展示到任一会话。
- 保留事件的真实投递状态语义；发送失败或结果未知不得显示为成功。未验证运行时能力时失败关闭，不静默切换到轮询或联系人/会话模式。
- 实现必须有自动化行为测试；API、持久化和权限边界必须有契约/集成测试。

## 技术上下文

**语言/版本**: TypeScript 5.9；Node.js 24+

**主要依赖**: 独立服务自有 Hono、Node.js 内置 SQLite；部署侧 DWS CLI 子进程（`DINGTALK_INBOX_DWS_BIN`、专用 profile）。QuotaHot React/Hono 仅为可选客户端。

**存储**: 收件箱状态及入站/出站消息使用独立服务自有数据目录中的 SQLite；消息按本地持久化时间保留 30 天并自动删除；当前目标和监听意图持久化，进程句柄不持久化。DWS 原生 profile 使用服务专属 `DWS_CONFIG_DIR`，profile 名称由 `DINGTALK_INBOX_DWS_PROFILE` 显式指定。不得读取 `QUOTAHOT_DATA_DIR`；认证秘密不得进入普通消息/会话记录

**测试**: `npm run typecheck`、`npm test`；模拟 DingTalk 边界覆盖单元及集成行为，另须在获授权的非生产组织验证运行时连接、事件及收发

**目标平台**: 独立 DingTalk Inbox 服务及部署主机（Node.js 24+，服务 OS 身份可执行 DWS）；QuotaHot 可在另一进程/主机作为客户端运行

**项目类型**: Hono Web 服务 + React Web 界面

**性能目标**: 规格要求已就绪监听时至少 95% 测试消息在 5 秒内展示；服务端事件与 UI 推送需能持续工作，当前规格未给出并发规模或 p95 搜索时延

**约束**: 单一当前目标、服务端持续消费、身份隔离、事件去重及时间排序；服务重启后依持久化监听意图创建新订阅代次，须等待对应 DWS ready marker 后标记就绪；以 SIGTERM/关闭 stdin 清理正常停止的订阅。DWS 不承诺 stream 自动重连或停机期间事件补发，失败需如实展示，不使用轮询回退。`accepted` 只表示 DingTalk 明确接受发送请求，不代表收件人已收到；发送结果未知不得自动重试

**规模/范围**: 第一版关键词搜索用户/群，选定一个当前聊天目标，实时展示文本消息并发送文本；不含多目标并行监听、富媒体、历史消息补拉或群管理

## 章程检查

### 阶段 0：研究前门禁

- **I. 可预期且可见的界面交互**: PASS（设计约束）。搜索、订阅启动/就绪/停止/失败、发送成功/失败/未知均须分别呈现；未经 ready 不显示监听成功。
- **II. 职责分层**: 需维护者审查例外。独立服务不位于章程规定的 QuotaHot `src/server/`；服务边界通过版本化 HTTP 契约实现。QuotaHot 可选代理只认证和转发，不承载业务或 DWS 生命周期。
- **III. 契约与行为可验证**: PASS（设计约束）。DWS 子进程、OpenAPI、SSE 及测试场景见 `contracts/` 与 [quickstart.md](./quickstart.md)；尚无真实部署 profile 验收证据。
- **IV. 凭证与额度操作安全**: 需维护者审查例外。DWS profile 与数据库归独立服务私有目录所有，不得放入 QuotaHot 数据目录；服务 API 独立认证，服务端到服务端凭证不下发浏览器。
- **V. 控制复杂度**: PASS（设计约束）。独立服务只增加 DWS 子进程 adapter、服务自有 SQLite 和必要的 REST/SSE 契约；不移植 Go SDK、不增加轮询回退或同步发布机制。
- **VI. 中文文档与代码注释**: PASS。规划文档为中文，API 字段与技术标识保持原文。

**阶段 0 结果**: DWS CLI 子进程是已文档化的独立服务集成边界，服务隔离架构决策明确。用户授权后已在唯一专用 profile 上验证群搜索完整性、三种目标监听 ready 以及限定个人/测试群的文本发送状态；证据与边界见 `quickstart.md`。独立服务运行环境的 DWS 配置目录权限尚未通过；服务自身的启动/停止清理和重启恢复须在实现后验收。章程规定的 QuotaHot 源码与数据目录适用范围仍需维护者审查，未静默宣称合规。

## 阶段 0：研究决策

证据、替代方案及限制见 [research.md](./research.md)。本阶段决策如下：

1. **运行时能力**：由独立 DingTalk Inbox 服务启动 DWS 子进程；使用现有业务 CLI，不将 skill markdown 或 DWS 内部 Go SDK 视为调用 API。子进程通过 ready marker、stdout NDJSON、stderr 生命周期状态及 SIGTERM/EOF 清理与服务协作。
2. **搜索及身份**：人员使用 `dws aisearch person --dimension name`，候选中的 `userId` 是 person 稳定目标；群使用 `dws chat +chat-search`，`openConversationId` 是 group 稳定目标。多候选需用户明确选择，profile 间 ID 不复用。
3. **目标事件**：person 私聊使用 `user_im_message_receive_o2o --user <userId>`；group 使用 `user_im_message_receive_group --group <openConversationId>`。不使用会覆盖该用户群聊发言的 `user_im_message_receive_user`，也不订阅 all-event key。
4. **回复与失败语义**：通过 `dws chat +messages-send --as user` 和已选目标稳定 ID 发送纯文本。明确成功回执记为 `accepted`；失败记为 `failed`；超时/断连且无法确认时记为 `unknown`，不自动重试。
5. **部署验收**：真实服务 profile、授权范围、DWS 版本与子进程行为必须按 [quickstart.md](./quickstart.md) 验证；这不是设计文档声称已通过的线上验证。
6. **禁止的替代**：不以定时轮询伪装实时事件，不把 Agent 侧 skill 当运行时，不从联系人/会话列表推断目标，也不把未知发送结果标为成功。
7. **消息持久化与保留**：入站及出站消息持久化，浏览器重开和服务重启后可恢复，按本地 `storedAt` 保留 30 天并自动删除。
8. **服务重启**：持久化当前目标和监听意图；重启时创建新的 DWS consumer 代次，不复用旧 `ready` 状态，只有收到匹配 ready marker 后才显示就绪。显式停止后不自动恢复。
9. **发送结果**：仅明确的 DingTalk 接受回执归为 `accepted`，不代表对方已收到或已读；无法确认的结果为 `unknown`，不自动重发。

**研究结论**: 产品目标和子进程接入方式已明确。设计可以依赖文档化的 DWS CLI 子进程契约；真实部署 profile、上游权限及独立运行仍须在实现开始前实测，不得在文档中宣称已完成线上授权验证。规格已确认消息持久化与 30 天保留、独立服务重启自动恢复监听、QuotaHot 重启不影响监听，以及 `accepted` 不等于收件人已收到。

## 项目结构

### 本功能文档

```text
specs/002-dingtalk-chat-inbox/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── dws-runtime.md
│   ├── openapi.yaml
│   ├── sse.md
│   └── dingtalk-chat.openapi.yaml # 历史草稿；以 openapi.yaml 为准
└── spec.md
```

### 独立服务及可选客户端结构（仅门禁通过后）

```text
services/dingtalk-inbox/
├── package.json                 # 独立依赖、构建、测试和启动入口
├── tsconfig.json
├── src/
│   ├── main.ts                   # 独立服务入口及优雅关闭
│   ├── dws/runner.ts             # 固定参数搜索/发送/消费子进程
│   ├── inbox/service.ts          # 目标选择、事件归属与发送状态
│   ├── inbox/store.ts            # 服务自有目标、订阅及消息持久化
│   └── http/                     # REST/SSE 与服务认证
└── test/                         # 服务边界及 DWS adapter 测试

src/                              # QuotaHot 可选消费端，不是服务依赖
├── server/dingtalk-inbox-proxy/  # 认证、REST 转发和 SSE 透传
└── web/dingtalk-inbox/           # 搜索、选择、消息及回复界面
```

**结构决策**: 核心功能位于 `services/dingtalk-inbox/` 独立包，与现有 `wechat-inbox` 不共用账户、消息、上游身份、生命周期或数据库。OpenAPI 与 SSE 是服务和客户端之间唯一业务契约；QuotaHot 代理只负责认证、转发和流透传，不导入服务源码或管理服务进程。

## 阶段 1：设计门禁与复核

数据实体、30 天保留及订阅恢复状态见 [data-model.md](./data-model.md)；Web 边界见 [contracts/openapi.yaml](./contracts/openapi.yaml)；DWS 子进程及重启重建见 [contracts/dws-runtime.md](./contracts/dws-runtime.md)；推送事件、重连和发送状态语义见 [contracts/sse.md](./contracts/sse.md)；模拟及授权非生产验证见 [quickstart.md](./quickstart.md)。

- **I. 可预期且可见的界面交互**: PASS（候选契约区分订阅状态、发送结果与阻塞错误）。
- **II. 职责分层**: 需维护者审查例外（核心服务属于独立包，不位于章程指定的 QuotaHot `src/server/`；API 契约负责隔离）。
- **III. 契约与行为可验证**: PASS（列明搜索歧义、事件隔离/去重/排序、30 天保留、服务重启后订阅恢复与发送状态等测试场景；真实 profile 权限及重启恢复仍须目标部署验收）。
- **IV. 凭证与额度操作安全**: 需维护者审查例外（DWS profile 属于独立服务私有目录；服务 API 独立认证，QuotaHot 凭证只用于服务端代理且不暴露给浏览器）。
- **V. 控制复杂度**: PASS（复用 DWS 支持的子进程协议，不移植 Go SDK，不增加轮询回退）。
- **VI. 中文文档与代码注释**: PASS。

**阶段 1 结果**: 规划产物齐备；设计后检查已标出需维护者审查的章程适用例外。独立构建/健康/SQLite 骨架已通过本地验收；授权 profile 的 DWS 搜索、目标订阅 ready 和发送成功已取得有限实测。基于用户明确的实现指令，开始功能开发；独立服务 DWS 配置目录私有权限、服务生命周期清理及 US2 后重启恢复仍是强制验收门，不通过前不得宣称运行时可部署。

## 复杂度记录

独立包边界与章程规定的 QuotaHot 源码/数据目录布局不一致，须维护者审查并记录范围；本计划不自行修改章程。DWS CLI provider 已选定；目标环境授权、重启恢复及清理行为尚未实测，这些是实现前的可行性门禁。
