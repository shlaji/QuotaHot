---
description: "DingTalk 消息收件箱独立服务实施任务清单"
---

# Tasks: DingTalk Message Inbox 独立服务

**Input**: `specs/002-dingtalk-chat-inbox/` 中的 spec、plan、research、data model、contracts 与 quickstart

**Architecture**: 业务服务必须实现为独立 `services/dingtalk-inbox/` 包，自有依赖、构建、存储、配置和生命周期。QuotaHot 只提供可选 HTTP/SSE 代理与 UI；不得由 QuotaHot 导入或启动独立服务，也不得共享其数据目录或凭证。

**测试要求**: 规格要求自动化行为测试，API、持久化和权限边界必须有契约/集成测试。先编写测试并确认失败，再实现。fake DWS 测试不替代授权非生产部署验收。

**部署门禁状态**: T001-T005 独立服务骨架已通过本地构建/健康/SQLite smoke。用户确认当前唯一选中 profile 是专用 profile，并授权在指定个人与非生产测试群操作；群搜索完整、三种目标监听 ready、两条限定测试发送的 `sendStatus` 为 `SUCCESS`，证据见 `quickstart.md`。用户于 2026-10-22 明确再次要求继续实现。T006 据此记录门禁顺序：代码实现可继续；服务重启恢复改为 US2 后的强制验收门，未通过前不得宣称功能完成或可部署。T007/T008 的 CLI 能力部分通过，但当前 `~/.dws` 目录权限为 `0775`，不符合专用目录私有权限要求；独立服务使用该 OS profile 的配置权限、服务生命周期清理、重启恢复及发送失败/unknown 仍未验证。`chat +messages-send` Schema 为 `confirmation: user_required`，每次实际发送仍须显式授权，不能绕过确认；此前一次性测试授权不构成未来发送授权。

## 格式及路径约定

- 每项任务使用 `- [ ] Tnnn [P?] [USn?] 描述和准确路径`；编号连续，故事任务必须带故事标签。
- 独立服务路径均位于 `services/dingtalk-inbox/`；QuotaHot 可选客户端路径位于根包 `src/server/dingtalk-inbox-proxy/` 与 `src/web/dingtalk-inbox/`。
- 新增文档及代码注释使用中文。不得把消息正文、令牌、DWS credential、原始 stdout/stderr 写入日志或 DTO。

## Phase 1: 独立服务骨架与部署门禁

**目的**: 先证明独立服务包不依赖 QuotaHot，并核验真实 DWS 能力；不在此阶段实现收件箱用户故事。

**独立验收**: 在不安装、不启动 QuotaHot 的环境中，独立服务可安装、类型检查、构建、启动、写入自有 SQLite 并通过健康检查；授权目标服务身份及专用 profile 的 DWS 搜索、事件和发送能力有逐项真实验收记录。任何缺项均阻塞功能实现。

- [X] T001 在 `services/dingtalk-inbox/package.json`、`services/dingtalk-inbox/package-lock.json` 与 `services/dingtalk-inbox/tsconfig.json` 建立 Node.js 24+ 独立 TypeScript/Hono 包、独立依赖锁及 typecheck/test/build/start 脚本；不得引用根包工作区或 QuotaHot 源码
- [X] T002 [P] 在 `services/dingtalk-inbox/test/bootstrap.test.ts` 编写独立包启动/健康检查及 QuotaHot 缺席场景测试，验证服务能使用自身配置和临时数据目录
- [X] T003 在 `services/dingtalk-inbox/src/main.ts` 与 `services/dingtalk-inbox/src/http/server.ts` 实现最小独立服务入口、健康检查和优雅关闭；本任务不启动 DWS、不提供 Inbox 业务端点
- [X] T004 在 `services/dingtalk-inbox/src/inbox/store.ts` 与 `services/dingtalk-inbox/test/bootstrap.test.ts` 实现并验证服务自有 SQLite 文件初始化和一次最小读写；不得读取 `QUOTAHOT_DATA_DIR` 或 QuotaHot 数据库
- [X] T005 在 `specs/002-dingtalk-chat-inbox/quickstart.md` 记录不安装/不启动 QuotaHot 时独立包的安装、typecheck、build、start、健康检查及自有存储实测结果
- [X] T006 在 `specs/002-dingtalk-chat-inbox/plan.md`、`specs/002-dingtalk-chat-inbox/tasks.md` 与 `specs/002-dingtalk-chat-inbox/quickstart.md` 记录用户再次明确的实现指令所授权的门禁时序：代码实现可继续，服务监听恢复须在 US2 后执行并通过强制集成验收；未实际通过前不得宣称功能完成或可部署
- [ ] T007 在获授权的目标独立服务 OS 身份和专用 profile 下，按 `specs/002-dingtalk-chat-inbox/quickstart.md` 验证目标 DWS binary 版本、`DINGTALK_INBOX_DWS_BIN`、`DINGTALK_INBOX_DWS_PROFILE`、私有 `DWS_CONFIG_DIR` 权限及 search/event/send Schema，并记录脱敏实测结果到 `specs/002-dingtalk-chat-inbox/quickstart.md`
- [ ] T008 在获授权非生产组织按 `specs/002-dingtalk-chat-inbox/quickstart.md` 验证人员/群搜索、两种目标事件 ready/字段、发送 accepted/failed/unknown 回执及 SIGTERM 清理；仅在明确授权与 DWS 确认契约满足后发送，记录每项真实结果到 `specs/002-dingtalk-chat-inbox/quickstart.md`

**检查点**: T005、T006 已完成。用户授权 profile 上的 CLI 搜索/监听/发送部分证据见 quickstart；独立服务配置权限及自身生命周期证据未完成。用户已明确要求开始实现，因此 Phase 2 可推进；部署可用性与 US2 后恢复仍不得伪标通过。

---

## Phase 2: Foundational 独立服务基础设施

**Purpose**: 在门禁通过后，为全部用户故事建立独立服务类型、DWS adapter、存储生命周期和认证 API。

**前置条件**: T005、T006 已通过；T007/T008 的 CLI 行为证据见 quickstart。独立服务 OS 配置私有性及服务生命周期尚未验证，保留为后续部署/完成门禁。

- [X] T009 [P] 在 `services/dingtalk-inbox/src/shared/types.ts` 定义目标、候选、订阅、消息、能力和错误 DTO，枚举/可空语义逐项遵循 `specs/002-dingtalk-chat-inbox/data-model.md`
- [X] T010 [P] 在 `services/dingtalk-inbox/src/inbox/store-schema.ts` 定义独立 SQLite schema，落实 `(profileKey, targetType, targetId)` 唯一键、订阅代次、消息去重索引及入站/出站消息字段
- [X] T011 [P] 在 `services/dingtalk-inbox/test/dws-runner.test.ts` 编写 fake 子进程契约测试，覆盖 argv 固定、profile 传递、ready marker、NDJSON 分片、stderr 脱敏、非零退出和 SIGTERM 清理
- [X] T012 在 `services/dingtalk-inbox/src/dws/runner.ts` 实现无 shell 的 DWS 子进程 adapter，固定使用 `DINGTALK_INBOX_DWS_BIN`、`DINGTALK_INBOX_DWS_PROFILE` 与独立 `DWS_CONFIG_DIR`，并发读取 stdout/stderr、增量解析 NDJSON、仅在匹配 ready marker 后就绪、关闭时优雅清理
- [X] T013 在 `services/dingtalk-inbox/src/inbox/store.ts` 实现独立服务数据库接口，持久化目标、监听意图、订阅代次及消息，并实现按 `storedAt` 保留 30 天、稳定去重、目标分页查询
- [X] T014 在 `services/dingtalk-inbox/test/store.test.ts` 编写存储测试，覆盖目标唯一性、person/group ID 域隔离、消息去重排序、30 天删除及重启后 pending 不得推断为 accepted
- [X] T015 在 `services/dingtalk-inbox/src/inbox/service.ts` 建立独立业务 service 接口及订阅事件广播抽象；不导入 QuotaHot 模块，不把浏览器连接作为 DWS 生命周期所有者
- [X] T016 在 `services/dingtalk-inbox/src/http/auth.ts` 与 `services/dingtalk-inbox/test/auth.test.ts` 实现并测试服务端 Bearer 认证，确保 token 不进入错误文本、日志或 API DTO
- [X] T017 在 `services/dingtalk-inbox/src/http/routes.ts` 建立版本化 `/api/v1` Hono 路由装配，并验证所有业务请求经过独立服务认证

**检查点**: 独立服务依赖树、数据目录、配置和认证均与 QuotaHot 分离；fake 子进程与存储测试通过。

---

## Phase 3: User Story 1 - 搜索并选择消息对象 (Priority: P1)

**Goal**: 使用者能搜索人员/群并明确选择唯一目标，展示可辨认的目标类型与身份。

**Independent Test**: fake DWS 下分别搜索 person/group；零结果、多候选、缺稳定 ID、结果不完整或运行时不可用均不得自动选择或启动监听。

### Tests

- [X] T018 [P] [US1] 在 `services/dingtalk-inbox/test/search.test.ts` 编写搜索 adapter/service 测试，覆盖姓名候选 `userId`、群候选 `openConversationId`、完整性、零/多命中及同 profile 隔离
- [X] T019 [P] [US1] 在 `services/dingtalk-inbox/test/search-api.test.ts` 编写 `GET /api/v1/people/search`、`GET /api/v1/groups/search` 与认证契约测试，确认只返回安全候选 DTO
- [X] T020 [US1] 在 `services/dingtalk-inbox/src/dws/runner.ts` 和 `services/dingtalk-inbox/src/dws/search.ts` 实现 `aisearch person` 与 `chat +chat-search` 固定 argv 搜索，按当前解析器可识别的完整性证据标注候选并只投影契约字段；真实群响应结构适配仍由 T051 跟进
- [ ] T021 [US1] 在 `services/dingtalk-inbox/src/inbox/service.ts` 实现候选校验及明确目标选择，仅接受同 profile 搜索返回的 person `userId` 或 group `openConversationId`
- [ ] T022 [US1] 在 `services/dingtalk-inbox/src/http/routes.ts` 实现 OpenAPI 规定的 capability、人员/群搜索和活动目标读/选 API，返回运行时不可用原因且不隐式选择
- [X] T023 [P] [US1] 在 `src/server/dingtalk-inbox-proxy/routes.ts` 实现可选 QuotaHot 同源 REST 代理，仅转发独立服务 API 并应用现有 Web 认证/同源保护，不导入服务源码
- [X] T024 [P] [US1] 在 `test/dingtalk-inbox-web-api.test.ts` 验证搜索/目标客户端契约，并在 `src/web/dingtalk-inbox/api.ts` 实现同源可选代理 API 客户端
- [X] T025 [US1] 在 `test/dingtalk-inbox-web-pane.test.tsx` 验证加载/空/多候选/不完整/错误/明确选择行为，并在 `src/web/dingtalk-inbox/loader.ts` 与 `src/web/dingtalk-inbox/InboxPane.tsx` 实现搜索及目标选择 UI，持续显示目标类型和身份

**Checkpoint**: US1 可独立验证，不含自动选择，不依赖 QuotaHot 才能使用独立服务 API。

---

## Phase 4: User Story 2 - 接收并查看实时消息 (Priority: P1)

**Goal**: 独立服务拥有目标 consumer，将身份确认的实时消息持久化并路由至正确会话，服务重启后按监听意图恢复。

**Independent Test**: fake consumer 注入 person/group、重复、乱序、迟到和错误归属事件；验证 ready marker、持久化后发布、SSE 重连校准及重启新代次恢复。

### Tests

- [ ] T026 [P] [US2] 在 `services/dingtalk-inbox/test/events.test.ts` 编写目标事件测试，验证 person/group EventKey、订阅代次归属、会话校验、重复去重、时间排序和未知身份隔离
- [ ] T027 [P] [US2] 在 `services/dingtalk-inbox/test/recovery.test.ts` 编写服务重启测试，验证旧 ready 不复用、profile 不匹配不恢复、监听意图恢复新代次、显式停止不恢复及 pending 不伪造成 accepted
- [ ] T028 [P] [US2] 在 `services/dingtalk-inbox/test/sse.test.ts` 编写 REST/SSE 契约测试，验证持久化后广播、订阅状态脱敏、客户端重连不创建第二个 consumer

### Implementation

- [ ] T029 [US2] 在 `services/dingtalk-inbox/src/dws/runner.ts` 实现目标范围 `event consume` 命令，person 使用 `user_im_message_receive_o2o --user <userId>`，group 使用 `user_im_message_receive_group --group <openConversationId>`，按 NDJSON 校验 ready 和消息字段
- [ ] T030 [US2] 在 `services/dingtalk-inbox/src/inbox/service.ts` 实现单活动目标启停/切换、停止旧 consumer 后再启动新 consumer、代次隔离、事件身份校验、消息持久化后广播及服务启动恢复
- [ ] T031 [US2] 在 `services/dingtalk-inbox/src/http/routes.ts` 实现 `PUT/DELETE /api/v1/active-target`、`GET /api/v1/messages` 及 `GET /api/v1/events` SSE，依 OpenAPI/SSE 契约限权并路由消息
- [ ] T032 [P] [US2] 在 `src/server/dingtalk-inbox-proxy/routes.ts` 实现可选 QuotaHot SSE 透明流代理，不缓冲、不拥有 DWS consumer 生命周期
- [ ] T033 [P] [US2] 在 `src/web/dingtalk-inbox/api.ts` 与 `src/web/dingtalk-inbox/loader.ts` 实现 SSE 订阅、断线重连、活动目标/历史消息校准和按目标分区的前端状态
- [ ] T034 [US2] 在 `src/web/dingtalk-inbox/InboxPane.tsx` 展示启动中、就绪、停止中、已停止、失败状态及消息发送者/时间；未收到 ready marker 前不得显示监听成功
- [ ] T035 [US2] 在 `services/dingtalk-inbox/src/main.ts` 装配服务 store、业务 service、HTTP server 与启动/关闭恢复流程；QuotaHot 代理的停止/重启不得停止或重建此服务 consumer

**Checkpoint**: 真实归属消息只在成功持久化后展示；新代次收到 ready marker 后才就绪。依 T006 的维护者决策完成并记录本阶段重启验收。

---

## Phase 5: User Story 3 - 回复收到的消息 (Priority: P2)

**Goal**: 在对应聊天视图发文本到已确认 person/group 目标，且准确呈现 accepted、failed、unknown。

**Independent Test**: fake DWS 验证两类稳定目标、过期目标拒绝、pending 持久化、回执归一、unknown 不自动重发，accepted 不宣称已送达。

### Tests

- [ ] T036 [P] [US3] 在 `services/dingtalk-inbox/test/send.test.ts` 编写发送 service/adapter 测试，覆盖 person/group argv、目标身份、确认契约、accepted/failed/unknown 及不重试
- [ ] T037 [P] [US3] 在 `services/dingtalk-inbox/test/send-api.test.ts` 编写 `POST /api/v1/messages` API 测试，验证 Bearer auth、活动目标冲突、pending 先持久化及 clientMessageId 状态关联
- [ ] T038 [P] [US3] 在 `src/web/dingtalk-inbox/InboxPane.test.tsx` 编写发送 UI 状态测试，验证明确 accepted、failed、unknown 待确认且无自动重发

### Implementation

- [ ] T039 [US3] 在 `services/dingtalk-inbox/src/dws/runner.ts` 实现 `chat +messages-send --as user` person/group 文本发送与 JSON 回执读取；遵循已核准的 user confirmation 机制，不能自行绕过 DWS 确认
- [ ] T040 [US3] 在 `services/dingtalk-inbox/src/inbox/service.ts` 实现活动目标校验、出站消息 pending/最终状态持久化与发送结果广播；发送回执缺少 messageRef 但含 `openTaskId` 时使用 `chat +messages-query-send-status` 查询，不重发发送命令，无法确认则保存 `unknown`
- [ ] T041 [US3] 在 `services/dingtalk-inbox/src/http/routes.ts` 实现 `POST /api/v1/messages`，校验目标与 `clientMessageId` 并依 OpenAPI 返回结果
- [ ] T042 [US3] 在 `src/web/dingtalk-inbox/InboxPane.tsx` 实现文本撰写及发送状态呈现；accepted 文案明确不代表送达，unknown 显示待确认

**Checkpoint**: 人员和群回复均按界面目标发送，未确认/失败状态不伪装成成功。

---

## Phase 6: 完善与横切验证

**Purpose**: 完成保留清理、可选客户端装配、安全、独立构建及全量验收。

- [ ] T043 [P] 在 `services/dingtalk-inbox/test/retention.test.ts` 编写可控时钟测试，验证入站/出站消息按 `storedAt` 超过 30 天删除
- [ ] T044 [P] 在 `services/dingtalk-inbox/test/security.test.ts` 编写安全测试，验证 DWS token、credential、正文及原始 stdout/stderr 不进入 API、应用日志或失败信息
- [ ] T045 在 `src/server/main.ts` 将可选 REST/SSE 代理装入 QuotaHot，并验证服务缺席时 QuotaHot 仍可启动、停止或重启不会触发独立服务生命周期
- [ ] T046 在 `src/web/` 现有导航/路由中接入可选 DingTalk UI，验证不改变 `001-wechat-user-list` 微信行为
- [ ] T047 在 `specs/002-dingtalk-chat-inbox/quickstart.md` 记录最终独立服务构建、QuotaHot 缺席验证、DWS 专用 profile、目标权限、重启、清理与 API/SSE 集成步骤和真实验收结果
- [ ] T048 在 `services/dingtalk-inbox/` 执行 `npm run typecheck`、`npm test`、`npm run build` 与 quickstart 本地验证；在根目录运行可选客户端的相关类型检查/测试，记录实际输出
- [ ] T049 在获授权非生产组织按 `specs/002-dingtalk-chat-inbox/quickstart.md` 完成最终验收，验证 SC-001 至 SC-007；不得用 schema 或 fake 测试代替真实部署结果

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 的独立服务骨架已证明不依赖 QuotaHot；用户再次明确要求实现，按 T006 决定继续功能代码。服务监听恢复须在 US2 后强制验收。
- T007/T008 尚未通过的独立服务 DWS 目录权限及服务生命周期/失败回执是完成/部署门禁。任何真实发送仍须满足 DWS `user_required` confirmation 和逐次用户授权。
- US1 先建立搜索与目标选择。US2 依赖 US1 确认的目标身份。US3 依赖 US1 的当前目标，并使用 US2 的持久化/SSE 状态。
- 最终阶段依赖三个故事完成；T049 要求授权非生产组织和验收窗口。

### User Story Dependencies

- **US1 (P1)**: Phase 1/2 通过后独立实现。
- **US2 (P1)**: 依赖 US1 的明确目标选择；事件 consumer/store 本身由独立服务拥有。
- **US3 (P2)**: 依赖 US1 目标身份及 Phase 2 service/send adapter；发送状态复用消息存储/SSE。

### Parallel Opportunities

- Phase 1 的 package skeleton 与 DWS Schema 资料复核使用不同文件/目标，可并行；实际测试需等专用 profile 与授权窗口。
- Phase 2 的 DTO、schema、fake 子进程测试涉及不同文件，可在门禁通过后并行；adapter/store/service 的同文件修改串行。
- 每个故事阶段中 `[P]` 测试可并行编写；服务端与 Web 端在接口定型后可并行，但同一文件不可并发编辑。
- US1/US2/US3 按依赖串行验收，不把用户故事当作相互独立的部署单元。

## Parallel Examples

```text
门禁解除后：T009、T010、T011 可按不同文件并行；T012/T013 等待对应接口。
US1 测试可并行：T018、T019；Web API T024 可与服务端 adapter/service 开发分开推进。
US2 测试可并行：T026、T027、T028；透明代理 T032 与独立服务 route 可在契约固定后分开开发。
US3 测试可并行：T036、T037、T038；发送 adapter -> service -> route -> UI 按依赖实现。
```

## Implementation Strategy

### MVP

MVP 为 US1（独立服务搜索、明确选择、身份展示）和服务可脱离 QuotaHot 使用的 API。仍须先完成 Phase 1 的维护者门禁决策、服务骨架验证及授权 DWS 搜索验收；不得以本地 fake 候选当作真实运行时可用。

### Incremental Delivery

1. 建立可独立构建、启动和存储的服务骨架，记录 QuotaHot 缺席时的验收。
2. 取得门禁顺序决策并验证专用 DWS profile/权限及消息操作确认契约；不满足时停止。
3. 完成服务基础设施与 US1，再独立验证搜索和目标身份。
4. 完成 US2，验证实时路由、持久化、30 天保留及独立服务重启恢复。
5. 完成 US3，验证发送回执及 UI 状态语义。
6. 完成可选 QuotaHot 代理、独立包全量验证和获授权非生产验收。

## Notes

- 不使用联系人/会话回退、轮询、全量事件订阅或 Agent Skill 作为服务运行时；不得让 QuotaHot 代理启动或拥有独立服务进程。
- `accepted` 仅表示 DingTalk 明确接受请求，不表示对方已收到/已读；`unknown` 不自动重发。
- `chat +messages-send` Schema 当前显示 `confirmation: user_required`；在目标 CLI 版本确认独立服务的受支持确认流程前不得发送或绕过确认。
- `plan.md` 对监听恢复的实现前门禁存在时序依赖，必须按 T006 记录维护者决策；不可在任务清单中静默更改门禁含义。

## Phase 7: Convergence

**Purpose**: 追加实现检查发现、且未被现有任务具体覆盖的收敛工作。现有 Phase 1-6 的未完成任务继续按原顺序执行，不在此重复。

- [ ] T050 在 `specs/002-dingtalk-chat-inbox/plan.md` 记录维护者对独立服务超出 QuotaHot `src/server/` 布局及独立凭证/数据目录例外（Constitution II、IV）的明确批准或替代架构决定；决定前不得宣称章程例外已获批准 per Constitution II/IV (contradicts)
- [ ] T051 在 `services/dingtalk-inbox/src/dws/search.ts` 与 `services/dingtalk-inbox/test/search.test.ts` 支持真实 `chat +chat-search` 的顶层 `chats` 响应包络并添加从真实响应结构脱敏构造的回归 fixture per US1/AC2 (partial)
- [ ] T052 为 `aisearch person` 完整候选证据缺失制定经维护者批准的处理决策并记录到 `specs/002-dingtalk-chat-inbox/plan.md`；在 DWS 无法证明人员结果完整时继续返回 `complete=false` 且禁止选择，不得默认改用 Contact 搜索 per FR-001/FR-002 (partial)
- [ ] T053 在 `services/dingtalk-inbox/src/inbox/service.ts`、`services/dingtalk-inbox/src/http/routes.ts` 与相应测试中修正目标选择副作用：不得先持久化目标再返回 503；只有订阅启动请求已按 OpenAPI 接受时才返回对应响应，并在启动失败时保持一致状态 per FR-002/OpenAPI `PUT /active-target` (partial)
- [ ] T054 在 `services/dingtalk-inbox/src/main.ts` 与 `services/dingtalk-inbox/test/retention.test.ts` 增加服务空闲期间的定期过期清理，并用可控时钟验证消息超过 30 天后无需后续读写也会删除 per FR-013 (partial)
- [ ] T055 在 `services/dingtalk-inbox/src/inbox/store-schema.ts`、`services/dingtalk-inbox/src/inbox/store.ts`、`services/dingtalk-inbox/test/bootstrap.test.ts` 审查并移除或给出长期业务理由以保留仅被 bootstrap test 使用的 `bootstrap_marker` 生产表及 API per data-model entities (unrequested)
