# 阶段 0 研究：DingTalk Message Inbox

**功能**: [spec.md](spec.md)  
**日期**: 2026-10-21

## 研究决策

### R5. 消息持久化与保留

**Decision**: 入站及出站消息持久化于独立 DingTalk Inbox 服务自有数据目录，服务重启及重新打开聊天视图后可恢复；消息按本地持久化时间保留 30 天，过期后自动删除。QuotaHot 不拥有或访问该数据库。

**Rationale**: 规格要求恢复已保存消息并明确 30 天保留期。以本地持久化时间为统一期限起点，可避免上游消息时间缺失或过旧导致新收到的消息立即过期。消息正文仍须避免进入常规日志。

**Alternatives considered**:
- 仅在内存或页面会话中保留：不能满足服务重启或页面重新打开后恢复的要求。
- 永久保留或由用户手工删除：不符合已确认的 30 天自动删除要求。

### R6. 服务重启后的监听恢复

**Decision**: 独立服务持久化当前目标及监听意图。该服务重启时不复用旧进程句柄或 `ready` 状态；若重启前监听意图仍有效，则自动启动新的目标范围 DWS consumer，并且只在新 consumer 输出匹配的 ready marker 后标记为 `ready`。使用者显式停止后，重启不得恢复该订阅。QuotaHot 重启与该生命周期无关。

**Rationale**: 规格要求独立服务重启后自动恢复此前监听，同时要求未就绪或失败时如实显示状态。现有 DWS 子进程契约提供 ready marker，但不承诺 consumer 自身断线自动重连；因此恢复定义为独立服务启动时创建新的 consumer，而不是宣称 DWS stream 自动恢复。

**Alternatives considered**:
- 将所有重启后的监听保持为中断并要求手动启动：与已澄清的规格冲突。
- 复用旧订阅状态或未验证的 DWS reconnect 行为：没有可验证的 ready 证据，不采纳。

### R7. 发送状态含义

**Decision**: `accepted` 表示 DWS 明确报告 DingTalk 已接受发送请求，不表示收件人已收到或已读；明确失败为 `failed`，无法确认是否接受为 `unknown`，不得将 `unknown` 伪装为成功或自动重发。

**Rationale**: 现有发送命令的 JSON 回执可在目标部署版本预检后归一化，但不应把请求提交或本地子进程启动等同于上游接受。该语义使界面承诺不超过可验证回执。

**Alternatives considered**:
- 将 `accepted` 显示成对方已收到：没有相应投递回执证据，不采纳。
- 对 `unknown` 自动重发：可能造成重复投递，不采纳。

### R1. 运行时接入边界

**Decision**: 独立 DingTalk Inbox 服务拥有查询、监听、消息持久化和发送的业务生命周期，通过固定参数的 `dws` 子进程调用 DingTalk；服务须有独立包清单、构建/测试入口、配置、数据目录和发布生命周期。QuotaHot 是可选 HTTP/SSE 客户端，不导入服务代码、不启动 DWS 子进程、不共享数据库或凭证。不将 Agent skill 文件当成 Web API、Go SDK 或嵌入式库。

**Rationale**: 最新架构约束要求运行时与 QuotaHot 解耦。DWS 仓库公开 `dws` CLI，并为 `dws event consume` 定义稳定的宿主子进程契约；该契约提供就绪信号、NDJSON 输出、优雅停止和订阅清理，适合作为独立服务内部 adapter 的边界。独立服务经版本化 HTTP/REST 与 SSE 向任意客户端提供消息能力，避免 QuotaHot 的构建、进程或数据成为运行前提。

**Evidence**:
- `dingtalk-workspace-cli/skills/multi/dingtalk-chat/SKILL.md` 将能力入口定义为 `dws` 命令；搜索用户、搜索群、发送文本均有明确入口。
- `dingtalk-workspace-cli/skills/multi/dingtalk-event/SKILL.md` 定义目标用户/群消息监听入口，并要求同一 profile 贯穿解析、监听、状态和停止。
- `dingtalk-workspace-cli/docs/event-subprocess-contract.md` 定义 `event consume` 的 ready marker、stdin EOF/SIGTERM 退出、退出状态、清理和 host runtime-token 传递契约。
- QuotaHot `src/server/wechat-inbox/routes.ts`、`service.ts`、`store.ts` 与 `src/server/main.ts` 只作为可选 Web 客户端代理的参考，不作为独立服务的运行时依赖；`src/web/wechat-inbox/api.ts`、`src/web/api.ts` 提供 same-origin API 与 SSE 范例。
- QuotaHot `package.json` 没有 DingTalk SDK 依赖；DWS 仓库的 `go.mod` 依赖 `dingtalk-stream-sdk-go`，但该依赖属于独立 DWS 可执行程序，不是 QuotaHot 可直接导入的 API。

**Alternatives considered**:
- 在 QuotaHot 中自行实现 DingTalk REST/事件客户端：缺少已验证的目标消息事件、权限和事件连接契约，不采纳。
- 将业务服务嵌入 QuotaHot Web 服务：违反独立部署及无代码耦合约束，不采纳。
- 由浏览器或 Agent skill 直接连接 DingTalk：不满足独立服务端身份和凭证保护要求，不采纳。
- 联系人/会话列表或定时轮询：目标身份和实时性不同于规格要求，明确禁止。

### R2. 人员、群和目标身份

**Decision**: 人员搜索使用 `dws aisearch person`，唯一选择后以同 profile 下返回的 `userId` 作为单聊目标；群搜索使用 `dws chat +chat-search`，唯一选择后以 `openConversationId` 作为群目标。姓名或群名仅用于搜索及展示，不作发送或订阅路由键。

**Rationale**: 人员与群使用不同 ID 域。DWS `event +listen-im` 的 `sender` 范围包含该用户在单聊和群聊中的消息；规格中的用户目标定义为该用户的一对一聊天，因此订阅使用 `user_im_message_receive_o2o`，而不是把发送者在其他群中的消息归入私聊。群使用 `user_im_message_receive_group`。

**Evidence**:
- `dingtalk-workspace-cli/skills/multi/dingtalk-contact/SKILL.md` 将姓名模糊搜索路由至 `dws aisearch person`，并禁止从多候选中自动取第一项。
- `dingtalk-workspace-cli/skills/multi/dingtalk-aisearch/SKILL.md` 给出 `person --query ... --dimension name` 路由及 `userId` 的稳定身份用法。
- `dingtalk-workspace-cli/skills/multi/dingtalk-chat/references/chat/group-discovery.md` 规定 `+chat-search` 搜索群，目标 ID 使用 `openConversationId`，多候选不得默认选择。
- `dingtalk-workspace-cli/skills/multi/dingtalk-event/references/event-im-keys.md` 区分 `user_im_message_receive_o2o`（指定单聊）、`user_im_message_receive_group`（指定群）和 `user_im_message_receive_user`（某发送人在单聊/群聊中的消息）。
- `dingtalk-workspace-cli/internal/shortcut/chat/unified_send.go` 声明 `+messages-send --user` 接收 `userId`，`--group`/`--chat-id` 接收群 `openConversationId`，并支持 `--text`。

**Alternatives considered**:
- 将目标设为“某用户在所有会话中的发言”：可能把群消息显示在用户单聊并导致回复错投，不采纳。
- 以名称作为目标 ID：名称可能重复且可变，不采纳。

### R3. 事件处理、发送结果和故障

**Decision**: 每个当前选中目标只运行一个目标范围的 `dws event consume` 子进程；先在 stderr 等待完整 ready marker，再消费逐行 NDJSON。切换目标时先向旧进程发送 SIGTERM/关闭 stdin，等待旧订阅清理后再启动新目标。发送超时或无法确认的结果标记为未知，不自动重发。子进程异常退出显示失败，不改走轮询。

**Rationale**: 这符合 DWS 文档化的订阅所有权与退出行为，并避免以静默恢复掩盖服务端订阅状态。DWS `event consume` 的重连韧性明确不在子进程契约范围内，功能必须向使用者反映中断。

**Evidence**:
- `dingtalk-workspace-cli/docs/event-subprocess-contract.md` 规定 stderr ready marker 先于 stdout 事件、stdin EOF/SIGTERM 干净停止、退出原因和新建订阅在干净退出时取消；明确提示不可使用 `kill -9`。
- `dingtalk-workspace-cli/skills/multi/dingtalk-event/references/event-im-lifecycle.md` 要求宿主持续读取 stdout/stderr、按 NDJSON 行解析；不能把 pipe chunk 当事件边界。
- 同一契约明确 reconnect resilience 另行追踪、不属于当前承诺。
- `dingtalk-workspace-cli/skills/multi/dingtalk-event/references/event-im-output.md` 给出消息 `event_id`、`message_id`、`conversation_id`、`sender_open_dingtalk_id` 等字段以及群/用户回复目标的不同映射。

**Alternatives considered**:
- `--quiet` 并以启动延迟推断就绪：没有 ready 证据，不采纳。
- 轮询或启动失败后降级到会话列表：改变实时事件语义，违反 FR-010，不采纳。
- 结果未知时自动重试发送：可能重复投递，DWS 发送 idempotency 不作通用成功保证，不采纳。

### R4. 认证与部署

**Decision**: 只允许独立 DingTalk Inbox 服务 OS 身份下的专用 DWS profile；通过 `DWS_CONFIG_DIR` 将 DWS 原生管理的认证状态隔离在该服务私有数据目录内。查询、事件和发送固定使用同一个 profile。部署前由运维人员完成一次 DWS 授权及能力验证；Web UI 不收集或展示 token。

**Rationale**: 让独立运行时具备受限且可审计的身份，同时避免复制个人开发环境凭证或让每个浏览器会话管理一份账户。DWS 自己管理 profile 格式，Inbox 服务不解析或改写其认证文件；QuotaHot 不接触该目录。

**Evidence**: DWS event 文档要求各阶段使用同一 `--profile`；`event-subprocess-contract.md` 规定 DWS 配置目录和订阅保护状态的权限边界。QuotaHot Constitution IV 要求凭证受宿主应用私有数据目录保护，不得复用或改写其他客户端凭证。采用独立服务后，需维护者审查该原则对新服务自身数据目录的适用范围，不应把凭证塞入 QuotaHot 目录以满足表面路径要求。

**Alternatives considered**:
- 复用开发者 HOME 中现有 DWS profile：部署身份不可控，且不应拷贝开发环境凭证，不采纳。
- 将 token 放入命令日志、环境变量或前端：会扩大暴露面，不采纳。

## 部署可行性门禁

DWS 提供了可设计和测试的子进程调用契约，因此可以完成离线接口和数据设计；它不等于目标部署环境的 DingTalk 权限已经开通。开始实现前，必须在目标服务器的服务 OS 身份和专用 profile 下验证：

1. 指定人员及群可以被搜索，结果包含可用于后续命令的稳定 ID；空结果、多候选和权限不足可被区分。
2. `user_im_message_receive_o2o` 与 `user_im_message_receive_group` 均可为单一真实目标建订阅并输出预期事件字段。
3. 对每种目标均可使用其稳定 ID 发送一条授权测试文本，且返回结果可归一为成功、失败或未知。
4. 服务重启时能基于持久化的目标和监听意图创建新消费进程；该目标仅在新进程 ready marker 到达后显示为就绪。SIGTERM 能使正常停止的消费进程清理其拥有的订阅；DWS binary 不存在、授权失效、权限拒绝和运行中断均能被 QuotaHot 如实显示。
5. 消费进程连续运行时 stdout/stderr 被持续读取，消息正文不写入应用日志，profile 文件仅服务 OS 身份可读。

任何一项不成立即阻止真实租户启用；不得以联系人/会话选择、全部事件订阅或轮询替代。该门禁是实现前的部署验收，不伪称已通过线上验证。

## 可选 Web 客户端参考模式

- `src/server/wechat-inbox/routes.ts` 与 `src/web/wechat-inbox/api.ts` 可参考用于实现 QuotaHot 内的可选 API/SSE 代理，但代理只做认证、转发和流透传，不实现消息业务规则或 DWS 生命周期。
- 独立服务自身的实体、存储和 DTO 必须由其公开契约定义；QuotaHot 客户端可以基于该契约生成客户端类型，但不得引用服务源码。
- 测试使用 Node `node:test`/`tsx`，DWS 进程由 fake child-process seam 驱动，不要求测试访问钉钉线上租户。
