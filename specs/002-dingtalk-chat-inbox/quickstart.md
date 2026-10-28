# Quickstart：DingTalk Message Inbox

本指南验证独立 DingTalk Inbox 服务经 DWS 子进程搜索人员/群、接收目标事件并发送文本，并验证 QuotaHot 仅作为可选 HTTP/SSE 客户端。线上步骤须使用已授权测试账号与测试群；禁止用生产群或未获授权的用户做写入验收。

## 前置条件

1. Node.js 24 或更高版本及 `services/dingtalk-inbox/` 独立服务依赖已安装；不要求 QuotaHot 包或源码参与构建与运行。
2. 目标服务器已安装经过版本核验的 `dws`，且独立服务 OS 用户可以执行它。
3. 运维人员已在独立服务 OS 用户下完成 DWS 专用 profile 授权。DWS 配置目录应位于独立服务私有数据目录，不能复制开发者 HOME 的 profile 或使用 QuotaHot 数据目录。
4. 使用仅含测试数据的人员/群；确认当前 profile 有人员搜索、群搜索、单聊/群事件订阅和文本发送权限。
5. `DINGTALK_INBOX_DWS_BIN`、`DINGTALK_INBOX_DWS_PROFILE` 与 `DWS_CONFIG_DIR` 已配置；profile 必须显式指定，缺失任一项时预期能力状态不可用，不执行发送。

## 本地 DWS 预检记录

**2026-10-22：部分完成，部署门禁未通过。** 本次只读取本机 DWS CLI Schema 和服务配置，没有执行人员/群搜索、创建订阅、发送消息或重启服务。

- 本机可找到 DWS 可执行文件 `/home/ll/.local/bin/dws`；尚未确认目标独立服务使用的 binary 版本。
- 当前 shell 未设置 `DINGTALK_INBOX_DWS_BIN`、`DINGTALK_INBOX_DWS_PROFILE` 或 `DWS_CONFIG_DIR`；当前用户服务管理器中没有已加载或运行的 `dingtalk-inbox.service`。没有读取 DWS 凭据。
- `aisearch person` Schema 确认 `query` 必填，`dimension` 支持 `name`；`chat +chat-search` 支持 `query`/`keyword` 搜索和 `page-all`。
- `event consume` Schema 确认支持 `user`/`group` 目标、`flatten` 和 NDJSON 输出；需要 event key 或已有 `subscribe-id`。
- `chat +messages-send` Schema 确认 user 身份支持 person/group 稳定 ID、纯文本及幂等键；`confirmation` 为 `user_required`。须在目标版本预检中验证独立服务如何满足此确认契约，不得自行追加 `--yes` 或绕过确认。
- 当前工作树尚无 `services/dingtalk-inbox/`，因此独立服务构建、启动及数据隔离也尚未验证。

Schema 读取只证明本机 CLI 提供相应参数，不代表目标服务身份、profile、组织权限、事件订阅、发送回执、服务重启恢复或停止清理已验证。T001/T002 仍阻塞；所有真实操作须在独立服务专用 profile 配置完成并安排授权非生产测试窗口后进行。

**2026-10-22：交互式 DWS 目标订阅冒烟（部分完成，不解除部署门禁）。** `dws profile list` 返回一个 `isOrgCurrent=true` 的当前 profile；未记录 profile 名称或用户显示名。对用户提供的三个精确目标分别单独执行了 10 秒有界 `event consume`（NDJSON/flatten）：`user_im_message_receive_group` + 提供的 `openConversationId`、`user_im_message_receive_o2o` + 提供的 `userId`、以及相同 EventKey + 提供的 `openDingtalkId`。三次均收到匹配 EventKey 的 ready marker、退出码为 0，stdout 消息行数为 0。

**订阅清理观察**：duration 到期后，`dws event status` 仍将本次群订阅列为 active，因此按用户确认对本次创建的群订阅执行了 `event stop`。另两条个人测试订阅也经用户单独确认后执行 `event stop`；DWS 返回已取消，但因 personal bus 当时已停止，停止本地 consumer 检查产生了 bus socket 不存在的 warning。最终 `dws event status` 显示 Bus `not_running`、`Consumers: none`，列表中仅剩测试前已有的其他群订阅。不得仅凭 duration 到期推断远端订阅已清理；需在独立服务验收中验证 SIGTERM/EOF 清理。

该监听冒烟使用当前交互式 DWS profile，不是独立服务 OS 身份下启动的服务；没有验证独立服务配置目录/权限、持续事件正文、独立服务托管 SIGTERM 清理或实现后的服务重启恢复。此时尚未发送消息。其后经用户另行确认的查询/发送结果见下节；实现门禁仍未全部通过。

**2026-10-22：获用户确认的查询/发送验证（部分完成）。** 用户说明当前选中的单一 profile 是专用 profile，并明确限定可发送对象为上述个人与 `痕迹告警-TEST` 测试群；个人目标经单独确认后使用 `openDingTalkId`。群搜索返回 `complete=true`、`failedCount=0`、`partial=false`，精确测试群候选的 `openConversationId` 与用户提供值一致；查询同时返回另一个名称相似的候选，因此不可按搜索顺序自动选择。

- 三种目标范围监听均已收到正确 EventKey 的 ready marker；未收到事件正文。
- 受限 `aisearch person --dimension name` 查询返回 1 个候选及 `searchEvidence.returnedCandidateCount=1`，但没有 `complete`、`hasMore` 或 `paginationKnown` 终态；该响应明确说明候选集不证明唯一性。独立服务必须将此类人员搜索结果标为 `complete=false` 并禁止选中，直至 DWS 能提供可验证完整性证据；不回退到 Contact 搜索。
- 经用户确认，两条纯文本测试消息（个人 1 条、测试群 1 条）分别通过 `dws chat +messages-send --as user` 发送；两次 `dws chat +messages-query-send-status` 都返回 `sendStatus=SUCCESS` 及真实消息引用。此状态只代表 DingTalk 接受发送请求，不代表收件人已收到或已读。
- 没有测试发送失败或结果未知的上游回执；没有向任何其他人或群发送。
- 本次 CLI 使用当前选中 profile，独立服务尚无专用环境变量/OS 服务配置；未验证独立服务的启动、数据隔离、搜索调用、发送确认机制、consumer 自身 SIGTERM 行为或重启恢复。故目标独立服务的 T007/T008 gate 仍未全部通过。
- 当前已安装 DWS 的 `chat +messages-send` Schema 未发布 `wait-delivery` 参数；`chat +messages-query-send-status` 可按真实 `openTaskId` 查询状态。独立服务须按目标版本 Schema 使用发送回执与该状态查询接口，不得直接假设源码仓库中未发布的 flag 可用；查询耗尽或无法确认时保留 `unknown` 且不重发。

**门禁时序决定（2026-10-22）**：用户在补充当前专用 profile、测试目标及 DWS 调用实现参考后，再次明确请求执行 `/speckit.implement`。据此继续代码实现；DWS 外部目标能力的已测证据支持开发 CLI adapter。计划中依赖独立服务自身持久化和生命周期的“重启后恢复监听”无法在无服务实现时验证，已明确移至 US2 完成后的强制集成门禁。该时序决定不代表门禁测试已通过；US2 实际停止/重启、消息去重及新代次 ready 必须在完成前取得新证据。当前 `~/.dws` 目录 mode 为 `0775`，不符合服务专属配置目录私有权限要求；未擅自 chmod 或复制凭证，须在独立服务部署验收前解决。

## 本地自动化验证

```bash
cd services/dingtalk-inbox
npm install
npm run typecheck
npm test
npm run build
```

使用 fake `dws` 子进程及可控时间的测试需覆盖：独立构建不依赖 QuotaHot 包/源码/数据；REST 服务认证；ready marker 先于 stdout、NDJSON 分片和逐行解析、无 ready/非零退出、错误事件不泄漏、用户单聊与群订阅使用各自 ID 域、优雅 SIGTERM 清理、目标切换时迟到消息归属旧目标、重复事件不重复入库、消息重启/重开恢复、30 天保留与过期删除、独立服务重启后按监听意图创建新订阅、显式停止后不自动恢复，以及发送失败/未知状态不自动重试。只有明确 DWS 接受的结果显示 `accepted`，且不宣称对方已收到。

预期结果：所有自动化测试不需要 DWS 登录或线上租户；独立服务可以单独构建和运行；错误/未知状态在服务 API 与可选 UI 保持一致。

## 独立服务骨架验收

**2026-10-22：T001-T005 已完成。** 仅在 `services/dingtalk-inbox/` 工作目录安装独立依赖并执行 `npm run typecheck`、`npm test`、`npm run build`；随后直接运行打包入口 `node dist/main.js`，不安装、不启动或导入 QuotaHot。

- 健康检查 `GET /health` 返回 HTTP 200 与 `{"status":"ok"}`。
- `DINGTALK_INBOX_DATA_DIR` 指向临时目录，服务启动后创建自己的 `inbox.db`；测试验证独立 store 可读写。
- 移除 `QUOTAHOT_DATA_DIR`、DWS profile 和 binary 环境变量后服务仍可启动；SIGTERM 后以退出码 0 关闭。
- 该结果只验证独立包骨架、健康端点及本地存储，不验证真实 DWS binary/profile、组织权限、搜索、事件、发送或监听恢复，不解除 T006-T008 部署门禁。

## 授权的线上冒烟验收

在部署验收窗口中，以专用 profile 手工执行以下步骤；先通过 DWS `--dry-run`/Schema 检查命令参数，再使用真实测试对象。生产部署流程不得把正文或认证信息复制到日志。

1. 按姓名查询测试人员。检查候选数与 `userId`；多候选时在 Web UI 明确选择，不默认取第一项。
2. 按关键词搜索测试群。检查分页完整性和 `openConversationId`；选择目标群。
3. 选择人员并启动监听。确认状态仅在 DWS ready marker 后成为 `ready`；发一条测试私聊并确认它只进入该人员聊天框。
4. 选择群并启动监听。确认先前订阅已干净停止；发一条测试群消息并确认它只进入群聊天框，发送者身份可辨认。
5. 在两个目标各发送一条短文本。确认 person 用 `userId`、group 用 `openConversationId` 路由；明确接受回执显示为“发送成功”而非“已送达”，超时结果显示 `unknown`/“待确认”且不自动重发。
6. 在监听就绪后重启或停止 QuotaHot，确认独立服务及 DWS consumer 不受影响、消息持续进入服务存储。随后重启独立服务，确认其为此前活动目标创建新的 DWS consumer；旧代次不复用为就绪，只有新代次 ready marker 到达后 API 才显示 `ready`。再显式停止独立服务订阅并重启，确认不会恢复订阅。
7. 断开客户端页面/QuotaHot 代理再重新连接，检查 SSE 可重连且从独立服务消息记录恢复视图；确认页面重连不会额外创建 DWS consumer。验证入站与出站消息在 `storedAt` 超过 30 天后自动删除。

## 验收结果

按 [规格成功标准](spec.md#success-criteria-mandatory) 记录操作耗时、消息到达耗时、目标路由正确率、发送状态和使用者无指导任务完成率。目标权限或事件不支持时记录为部署门禁失败，停止真实验收；不得改用轮询或联系人/会话列表继续。
