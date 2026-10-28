# 实施计划：微信多用户直连消息

**分支**：`001-wechat-user-list` | **日期**：2026-10-21 | **规格**：[spec.md](./spec.md)

**输入**：功能规格来自 `/specs/001-wechat-user-list/spec.md`

## 摘要

在当前多账号 QR 绑定与 iLink 收件箱基础上，改为由操作者直接选择一个 QR 绑定用户，并查看与该用户对应的消息、手动向该用户发送消息。移除绑定账号下的联系人列表和联系人会话选择。当前实现通过 `from_user_id` 和入站 `context_token` 建立外部联系人会话；该行为不能作为新产品模型继续暴露或隐式回退。

绑定用户必须先向平台发送消息，系统核验入站 owner 与该绑定一致，并从该入站取得服务端私有 `context_token` 后才能回复或发送 typing；QR 授权本身不会提供该上下文。上下文缺失、为空白或归属不确定时返回 context-required，不借用其他身份或客户端提供的 token。2026-10-24 用户批准移除独立 readiness、Gate 0 和生产验收前置条件；终端实收只作为有日期的观察证据，不控制发送或发布。

2026-10-25 用户批准移除持久 QR 浏览器会话、顶部会话和退出 UI，以及逐绑定 QR 核验功能。二维码入口、流程状态及逐绑定解除集中在绑定列表；扫码确认只保存绑定，不签发 `quotahot_wechat`。短期 `quotahot_wechat_flow` 仅保护扫码轮询与取消；所有管理和消息接口沿用全局 Web `accessGuard` 与同源/跨站保护，不以扫码登录会话作为访问门槛。

**历史源码复核（2026-10-25，核验取消前）**：当时复核记录了绑定 ID 核验/解除路径、QR 成功仅确认绑定及旧持久会话读写移除，不能作为取消核验后的契约或运行时通过证据。当前目标仅保留逐绑定解除及二维码新增/重新授权；实现验证记录见快速入门。

**核验移除理由（2026-10-25）**：旧流程重新轮询扫码确认后保留的 QR capability，该能力仅在进程内存中，重启后消失，不能作为持久绑定的运行时状态依据。移除确认后长期保留的能力及核验 API/UI，不持久化它，也不引入替代核验或伪健康端点。保留 owner generation、drain、绑定启停和 QR 确认失败回滚；回滚恢复已停止的 poller/worker 不得依赖该能力缓存。收件箱继续依据实际 `connectionState`、`relogin_required`、`replyContextState` 和 `canSend` 展示连接、只读及发送行为。

**解除回执对齐（2026-10-25）**：源码复核发现后端解除路由曾返回 `status: reconfirm_required`，而列表 UI 契约需要表达“指定本地绑定已解除”。后端现统一返回 `status: unlinked`，OpenAPI 对应 `UnlinkResult`，前端仅接受该状态；已添加实际 HTTP 回归和 OpenAPI 响应验证。此回执仅说明本地绑定解除，不代表微信上游授权撤销。

## 全局约束

- 根应用使用 Node.js 24+、TypeScript、Hono、React 和内置 SQLite；不得新增运行时依赖。
- 文档与代码注释使用中文；技术标识符、API 名称、命令和原始日志保持原文。
- QR `ilink_user_id` 是消息目标和历史归属的唯一产品身份；不得提供联系人、联系人会话或替代收件人选择。
- iLink 出站 `msg.from_user_id` 为空字符串，`msg.to_user_id` 为当前选中的 QR `ilink_user_id`；每条发送生成新的唯一 `msg.client_id`，请求包装为 `{ msg: message }`。当前 sender 已逐次生成 UUID，保留该行为。
- 任何 Web 请求不得覆盖服务端从所选绑定解析出的目标；bot token、`context_token`、AES key、CDN 签名参数不进入 Web DTO、DOM、URL、日志或普通错误。
- 发送内容由平台使用者手动撰写，不调用 AI；请求结果未知时不自动重发；`accepted` 不代表已送达或已读。
- 新直连消息/附件无限期保存，跨正常重启可读；批次消息与游标原子持久化；UI 向上滚动触发更早历史的游标分页，不只提供手动按钮。
- 用户授权首次切换时直接删除 `wechat/conversations.db` 的 `wechat_conversations`、`wechat_messages`，以及 `wechat/inbox.db` 的旧 `inbox_contacts`、`inbox_messages`、`inbox_contexts`、`inbox_attachments`、`inbox_items`、`inbox_chunks`；不迁移旧 schema、不保留旧历史、不重映射旧消息。
- 保留 `inbox_bindings`、`inbox_cursors`、所有当前 `inbox_binding_*` 表及数据和 `wechat/wechat.db` 中的 QR 凭证；既有 `wechat_sessions` 哈希表及旧行惰性保留，不读取、续期、新建或接受旧会话。不删除数据库文件，不清理 `state.db`、`tasks.db` 或无关文件。重置只执行一次；不校验旧表列结构，也不因无关未知表而拒绝重置；后续启动不得清除新数据。沿用已有 version 1 完成标记，不因实现变更重新触发已完成的重置。
- 绑定列表、解除、消息、typing 和附件统一受全局 Web `accessGuard`、按部署配置启用的 Basic Auth 及同源/跨站保护约束；不签发或要求持久 `quotahot_wechat` cookie。仅扫码轮询和取消额外校验短期 `quotahot_wechat_flow`，流程结束不停止已有绑定。
- 本次适配文本、图片、文件、视频及既有入站语音处理；语音出站维持禁用，不启用或新增专项工作。
- 不设置全局 readiness 状态、DTO 或验收开关；发送和 typing 按所选绑定自身已验证入站上下文判断。无需生产验收，不得把模拟测试或上游接受称为终端实收。

## 技术上下文

**语言/版本**：TypeScript 5.9，Node.js 24+（内置 `node:sqlite`）

**主要依赖**：现有 Hono、React、SQLite、Node.js crypto/stream；不增加运行时依赖

**存储**：保留 QR 凭证、绑定及传输游标；在 `wechat/inbox.db` 增加绑定直接消息存储边界。首次切换时仅按 FR-019 名单直接删除旧历史表，并创建缺失的当前结构；不解析、验证或迁移旧 schema，不保留旧历史或重映射身份。

**测试**：`npm run typecheck`、`npm test`；使用模拟 iLink/CDN、临时 SQLite、模拟时钟和浏览器测试；可选授权非生产 iLink 联调单独记录终端观察，不作发送或发布前置条件

**目标平台**：当前 QuotaHot Node.js Web 服务（Node 24+，默认回环监听；远程访问沿用现有 Web 认证、HTTPS 和同源保护）

**项目类型**：Hono 服务端 + React Web 应用 + SQLite 持久化

**性能目标**：复用现有按绑定账号运行的长轮询行为；分页读取消息；媒体分块读写。规格未定义新增吞吐量 SLA。

**约束**：入站 owner 须与所选 QR 绑定一致；iLink 客户端请求形状不视为服务器保证；连接状态不得替代绑定自身入站上下文校验；消息内容和认证秘密必须隔离；旧联系人数据不自动转换。

**规模/范围**：至少 10 个独立 QR 绑定用户；每个用户有独立授权、收件轮询、消息历史、媒体和私有入站上下文；不支持次级消息对象列表。

## 项目章程检查

### 阶段 0 准入检查

- **I. 可预期且可见的界面交互**: PASS。绑定列表区分授权、连接和该绑定回复上下文摘要；缺少有效上下文不得发送，API 接受不得显示为已送达。
- **II. 按功能组织且职责分层的代码结构**: PASS。继续复用 `src/server/wechat-inbox/`、`src/web/wechat-inbox/` 和 `src/shared/wechat-inbox.ts` 功能边界；服务端负责身份解析和私有协议状态。
- **III. 契约与行为可验证**: PASS。自动化覆盖绑定隔离、目标解析、收件身份、持久化、发送未知、媒体和 UI；上游直连行为单独做授权非生产实收验证。
- **IV. 凭证与额度操作安全**: PASS。遵循现有 `accessGuard` 与同源保护；凭证与上下文仅留服务端；未确认目标时失败关闭。
- **V. 控制复杂度并保持可维护性**: PASS。复用现有模块和依赖；按 FR-019 名单直接删除旧历史表，不增加旧 schema 迁移或身份重映射机制，不保留 Contact 或独立本地 Conversation 产品层。
- **VI. 中文文档与代码注释**: PASS。新增规划文档使用中文，协议字段和来源名称保留原文。

**设计前准入检查结果**：规划阶段通过。2026-10-24 修订后不再设置 Gate 0 或生产验收阻断。多绑定隔离由自动化合成测试验证；真实单绑定终端观察见 `research.md`，不声称真实多绑定投递已测试。

## 阶段 0：研究决策

证据、决策和验收标准见 [research.md](./research.md)；iLink 客户端字段与服务端保证边界见 [contracts/ilink-client-reference.md](./contracts/ilink-client-reference.md)。

1. **直接身份**：新消息流和 UI 的唯一目标为选中绑定的 `ilink_user_id`；不得从联系人或请求体选择其他目标。
2. **回复前提**：回复和 typing 前必须等待绑定用户主动发来消息；Tencent 客户端建议回复携带对应入站消息的 `context_token`，而 QR 授权不提供该上下文。真实终端联调记录实际收件范围，不能替代每次请求的身份和上下文校验。
3. **上下文**：只允许使用身份已验证且归属于当前绑定用户的入站消息所提供的服务端私有 `context_token`。未收到该绑定入站消息、上下文缺失、为空白或来源无法验证时返回 context-required，不复用其他用户或客户端提供的上下文。
4. **持久化切换**：仅对 FR-019 列出的旧历史表执行一次性直接删除；不要求旧列结构可识别，不迁移或保留旧历史。保留绑定、游标、当前 `inbox_binding_*` 表和数据、QR 凭证及所有非目标表；既有 `wechat_sessions` 表及旧行只惰性保留，不参与认证，不读取、续期或新建会话。未知或不相关表不触发全库拒绝。缺失的当前 inbox 表按当前 schema 创建，后续启动不得清除新历史。
5. **收发语义**：只有 iLink 接受时标记 `accepted`；不声称已送达/已读。未知结果不自动重发。AI 回复不在范围内。
6. **媒体**：适配既有非语音出站能力和入站处理；语音出站保持禁用，不在本次工作范围。
7. **出站身份**：`msg.from_user_id: ""`、`msg.to_user_id: selected ownerIlinkUserId`；保留当前每条发送生成新 UUID 并包装 `{ msg }` 的行为。本地消息 UUID 可与上游逐消息 ID 不同，不推定上游幂等或 echo 保证。

## 项目结构

### 文档（本功能）

```text
specs/001-wechat-user-list/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── operator-inbox.openapi.yaml
│   └── ilink-client-reference.md
└── checklists/requirements.md
```

### 源码（仓库根目录）

```text
src/
├── shared/
│   └── wechat-inbox.ts                 # 绑定摘要、消息 DTO 和收发状态
├── server/
│   ├── wechat-inbox/
│   │   ├── client-response.ts          # 保留发送者/接收者原始语义并校验绑定归属
│   │   ├── client.ts                   # iLink 传输层；目标由服务端业务层提供
│   │   ├── service.ts                  # 绑定用户摘要、入站归属与消息查询编排
│   │   ├── sender.ts                   # 只向所属绑定解析出的身份发送
│   │   ├── poller.ts                   # 继续按绑定用户隔离轮询与游标
│   │   ├── store-schema.ts             # 绑定消息存储及一次性旧数据清理
│   │   ├── store*.ts                   # 直接消息、附件和事务读写
│   │   ├── media*.ts                   # 媒体暂存、CDN、分块读写
│   │   ├── typing.ts                   # 所选绑定用户的辅助输入状态
│   │   └── routes.ts                   # 绑定用户级 API，不含联系人路由
│   ├── wechat-session-store.ts         # QR 绑定凭证；旧会话数据仅惰性保留
│   ├── wechat-login-service.ts         # 既有 QR 授权及重复身份更新
│   └── main.ts                         # 现有工作线程、守卫和路由挂载
├── web/
│   └── wechat-inbox/
│       ├── api.ts                      # 绑定用户级同源 API
│       ├── loader.ts                   # 单一绑定选择及历史滚动游标分页
│       ├── InboxPane.tsx               # 单层绑定用户列表和消息区域
│       ├── Messages.tsx                # 文本和媒体消息展示
│       └── Composer.tsx                # 当前绑定用户的手动消息编辑器
└── test/
    ├── wechat-inbox-client*.test.ts
    ├── wechat-inbox-binding.test.ts
    ├── wechat-inbox-service*.test.ts
    ├── wechat-inbox-sender.test.ts
    ├── wechat-inbox-store*.test.ts
    ├── wechat-inbox-routes.test.ts
    ├── wechat-inbox-web-*.test.ts
    ├── wechat-inbox-media*.test.ts
    └── main.test.ts
```

**结构决策**：继续使用现有微信 inbox server/web/shared 目录。QR 登录继续由现有 `wechat-login-service.ts` 和 `wechat-routes.ts` 负责。Inbox API、DTO、UI 从绑定-联系人两级变为绑定用户单层；移除 Contact 和独立本地 Conversation 实体、UI、API。两库只删除 FR-019 授权的旧历史表，不删除数据库文件；inbox 数据库创建缺失的当前结构并保留已存在的当前表数据。用一次性完成状态避免后续启动重删新历史，不引入旧 schema 迁移或历史数据恢复。

**新增授权设计约束**：已有绑定时仍从绑定列表内直接开始独立 QR 授权；新增授权流程不得先退出或解绑现有身份。只有取得有效身份且凭证持久化成功后才创建或更新该身份；取消、过期、身份无法确认或持久化失败时，既有绑定、凭证、授权状态及消息历史保持不变。成功绑定新身份只新增该条目，不覆盖其他绑定。保留二维码启动、轮询和取消路径及临时流程校验，移除持久浏览器会话和旧 `/session`、单数 `/binding` 管理入口；解除使用 `DELETE /api/wechat/bindings/{bindingId}`，成功返回 `status: unlinked`。不沿用会话过期 DTO 表达绑定成功。

## 实施顺序

按 TDD 和模拟传输层实施，发送和 typing 只检查所选绑定自身的有效入站上下文，不增加独立 readiness 或生产验收条件。真实终端证据与自动化隔离结果分别记录，不创建联系人回退。旧历史表重置只在首次切换时执行，随后初始化必须保留新结构中的消息和附件。

### 可选非生产联调与证据记录

1. 使用一个专用且获授权的非生产绑定，可沿用现有绑定；由该用户先主动向平台发送文本，此前只可查看、不可回复。
2. 核验入站身份与该绑定 owner 一致，并确认服务端保存了该用户自己的可用 `context_token`；使用同一绑定手动回复，在该用户终端确认实际收到。
3. 自动化用两个或更多合成 owner 验证发送、入站、上下文、目标及历史隔离；第二个真实绑定仅可补强证据，不作要求。
4. 每条真实回复均检查 `msg.from_user_id` 为空、`msg.to_user_id` 等于当前绑定 ID、`msg.client_id` 新生成且唯一；不借用其他身份上下文。
5. 图片、文件和视频各自记录实际验证范围；语音出站维持禁用。
6. 入站归属不明、上下文缺失、为空白或不属于当前绑定时，以 context-required 拒绝发送和 typing。终端未实收或无法确认时只记录该次观察，不设全局发送或发布阻断；不改成联系人模式，也不重试结果未知的发送。

### 任务 1：绑定用户消息数据与一次性旧数据清理

**文件**：`src/server/wechat-login-service.ts`、`src/server/wechat-session-store.ts`、`src/server/wechat-inbox/store-schema.ts`、`store.ts`、`store-rows.ts`、`store-items.ts`、`store-types.ts`、`test/wechat-inbox-binding.test.ts`、`test/wechat-login-service.test.ts`、相关 `test/wechat-inbox-store*.test.ts`。

1. 先新增绑定回归测试：10 个不同 QR 身份独立存在，同一身份连续重新授权 10 次仍只有一条绑定，并覆盖并发确认、缺失身份、凭证保存失败和状态不误报。
2. 覆盖按绑定 ID 解除时仅停止目标用户、保留历史且不影响其他绑定，以及相同身份重新授权恢复通信。覆盖无持久 cookie 可操作、旧 cookie 不被接受、扫码确认不签发持久 cookie、旧 `wechat_sessions` 数据不读取/续期/新建且原样保留；扫码轮询和取消仍拒绝缺失或不匹配的 flow cookie。关闭页面或取消流程不得暂停绑定。
3. 先为旧列结构不匹配、目标表缺失/部分存在、无关未知表、已有当前表数据、外键依赖和重复启动编写回归测试；再按 FR-019 名单直接删除旧表，不读取旧历史内容、不校验旧列或迁移数据。只创建缺失的当前表，既有 `inbox_binding_*` 表及消息、上下文、附件元数据和分块必须保留。每库在独立事务内完成定向删表、当前结构初始化（inbox 库）和完成标记；沿用已存在的 version 1 标记，不升级后重删数据。操作失败时回滚当前库且不记录完成，允许重试；无关表保持不变，若外键会导致保护数据级联删除则回滚当前库。
4. 为新消息定义按 owner 的唯一性、顺序、附件和分块引用；每条使用本地唯一消息 ID 和新的上游 `msg.client_id`，连续/并发发送不覆盖或误合并。
5. 新增绑定用户级游标分页、去重和附件访问；同一远端 ID 只在相同 owner 范围内去重；新消息和附件不自动过期。
6. 覆盖消息/附件/游标同时提交和失败回滚，以及正常重启后绑定列表与消息历史恢复。

**完成标准**：新消息只按 owner 查询；名单内旧历史表直接删除、不迁移且不保留；缺失的当前结构可建立，已存在的当前消息、上下文、附件及分块不丢失；绑定、游标、凭证、既有惰性 `wechat_sessions` 表及旧行、未知/无关表及其他文件不变。旧会话不再参与运行时认证。未知旧列结构不阻止清理；失败后可重试，重复启动不再清除新历史；事务、分页、附件及重启测试通过。

### 任务 2：iLink 入站身份校验与游标生命周期

**文件**：`src/server/wechat-inbox/client-response.ts`、`service.ts`、`poller.ts`、`test/wechat-inbox-client-updates.test.ts`、`test/wechat-inbox-service*.test.ts`、`test/wechat-inbox-poller*.test.ts`。

1. 先添加失败测试：消息 sender 身份与绑定 owner 相同、不同、缺失、畸形时分别按经过验证的策略处理；不匹配消息不能建立可选用户或污染该 owner 正常消息流。
2. 保留 `from_user_id`、`to_user_id` 与 `context_token` 的传输层区分，不再将 sender 自动转换成联系人。
3. 只把入站 owner 与目标绑定一致的消息存进该 owner 消息流；未知/不匹配项作为不含敏感原文的安全协议失败处理。
4. 保持每绑定用户单 worker、停止/重新授权行为、`notifystart`/`notifystop` 辅助通知和游标批次原子性；生命周期通知失败不得中断手动收发。

**完成标准**：用户消息只归属已校验的绑定用户；错误身份不串线；重复轮询、事务失败和重启恢复行为有测试锁定。

### 任务 3：直连发送和私有上下文

**文件**：`src/server/wechat-inbox/sender.ts`、`typing.ts`、`service.ts`、`src/shared/wechat-inbox.ts`、`test/wechat-inbox-sender.test.ts`、`test/wechat-inbox-store-context.test.ts`。

1. 先添加失败测试，确认请求路径的 owner 是唯一目标，Web 不能覆盖收件人或上下文；所选绑定自身上下文缺失、为空白或归属不确定时，发送和 typing 返回 context-required 且没有对应外部请求。
2. 删除从联系人记录推导收件人的流程；使用 `{ msg: message }`，其中 `msg.from_user_id: ""`、`msg.to_user_id: binding.ownerIlinkUserId`，保留每条发送生成新的唯一 `msg.client_id`。
3. 使用独立本地消息 UUID 保存每条出站；连续/并发发送的本地 ID 和上游 ID 各自唯一。保留 owner 范围关联校验；只有非生产证据证明的 echo 关系才可用于合并，不推定上游幂等。
4. 只存放入站 owner 与该 binding 一致的私有上下文；不得拿其他 owner、不同 sender 或客户端提供的上下文替代。
5. 分开维护授权状态、连接状态和绑定回复上下文摘要；连接正常不产生上下文，不维护独立 readiness 状态。
6. 保持 accepted/failed/unknown 语义；unknown 不自动重发；typing 失败不阻断人工消息。
7. 语音出站维持当前禁用状态，本次不新增实现或启用工作。

**完成标准**：有效发送目标只能来自所选 QR 绑定身份；自身上下文校验失败时拒绝发送和 typing；秘密不进入 DTO/日志；发送状态及 typing 边界有测试。

### 任务 4：绑定用户级操作者 API 和契约

**文件**：`src/server/wechat-routes.ts`、`src/server/wechat-login-service.ts`、`src/server/wechat-session-store.ts`、`src/server/wechat-inbox/routes.ts`、`src/shared/wechat-inbox.ts`、`specs/001-wechat-user-list/contracts/operator-inbox.openapi.yaml`、相关微信路由/登录测试、`test/wechat-inbox-routes.test.ts`、`test/helpers/wechat-inbox-contract.ts`、`test/main.test.ts`。

1. 先对照已有仅面向绑定的 OpenAPI 添加失败测试，再使运行时匹配 `/bindings/{bindingId}/messages` 与 `/bindings/{bindingId}/typing`，删除 contacts 和独立本地 Conversation 路由；无需重复修改已匹配目标的 OpenAPI。
2. 绑定列表返回授权/连接/该绑定回复上下文的安全摘要，不返回独立 readiness 字段。
3. 查询和发送以路径 `bindingId` 作为唯一业务目标；请求 DTO 不接受 sender、recipient、contact、conversation 或 context；删除联系人及独立本地 Conversation API。
4. 发送和 typing 的绑定上下文缺失、为空白或归属不确定时返回稳定 context-required 错误；响应 no-store 并沿用全局 `accessGuard` 和同源校验。
5. 确认文件附件始终关联绑定用户消息，并且旧联系人数据不能通过新路由读取。
6. 解除使用 `DELETE /api/wechat/bindings/{bindingId}` 并返回 `status: unlinked`；目标仅来自路径，不再从浏览器 cookie 推导。移除逐绑定 QR 核验及持久会话签发与旧会话/单数绑定 API；验证全局 Web 认证及跨站拦截仍覆盖列表、解除和消息。解除不撤销上游授权、不删历史，QR 确认失败须恢复此前停止的目标 poller/worker，其他绑定不受影响。

**完成标准**：OpenAPI 与运行时契约测试一致；不存在公开联系人路由或用户可控目标字段；错误和安全头稳定。

### 任务 5：单层绑定用户 Web 收件箱

**文件**：`src/web/components/WechatPane.tsx`、`src/web/wechat-api.ts`、`src/web/wechat-loader.ts`、`src/web/wechat-qr-loader.ts`、`src/web/wechat-inbox/api.ts`、`parse.ts`、`loader.ts`、`InboxPane.tsx`、`BindingControls.tsx`、`Composer.tsx`、`Messages.tsx`、`test/wechat-inbox-web-*.test.ts`、相关 UI 测试。

1. 先添加浏览器/DOM 失败测试：点击绑定用户即可打开其消息；界面和可访问名称不出现联系人/第二消息对象选择。
2. 将 loader 状态从 binding + contact 双键改为单一 binding ID；绑定切换取消旧请求并清除另一人的可见内容。
3. 展示最新消息和手动 composer；向上滚动到历史边界自动按游标加载更早消息并保持阅读位置，覆盖多页无遗漏/重复及切换时丢弃旧结果，不仅提供手动按钮；缺少所选绑定自身有效入站上下文时禁用发送和 typing，并提示先由该用户发来消息，不展示独立 readiness。
4. 展示 accepted、failed、unknown 的区别；unknown 明示先核实，不提供自动重发。
5. 验证空/加载/错误/只读状态、媒体和切换竞态；将添加用户、二维码状态与取消放入列表区，每个绑定提供自身解除操作及解除确认；移除逐绑定 QR 核验按钮及其专用状态、顶部微信会话、退出操作、持久登录状态依赖和独立本地 Conversation UI。保留收件箱实际连接与回复上下文状态；切离页面仅取消待完成扫码，成功后刷新列表，不进入浏览器登录态。

**完成标准**：用户只需选择绑定用户；目标和历史切换正确；无自身有效上下文不能发送或 typing；UI 不泄露协议秘密。

### 任务 6：自动化验证与非生产观察记录

**文件**：`specs/001-wechat-user-list/quickstart.md`、相关集成测试和脱敏验收记录。

1. 将模拟测试与非生产真实 iLink 验收分开；自动化测试不得依赖真实凭证。
2. 如执行可选真实联调，用一个获授权非生产绑定验证首次入站、owner 与自身上下文核验、人工回复和终端观察；自动化合成多 owner 测试证明隔离，不要求第二个真实绑定。断言 `msg.from_user_id` 为空、`msg.to_user_id` 为目标绑定 ID、每条 `msg.client_id` 新生成且唯一。
3. 验证文本、图片、文件、视频的绑定适配、游标恢复、消息/附件无限保留、历史滚动加载及安全边界；不启用或验收语音出站。
4. 如果终端不收件或无法确认，记录该次实际结果及限制，不增加全局能力或发布阻断；入站身份无法关联时拒绝使用其上下文。不得回退联系人或把 accepted 改报 delivered。
5. 运行 `npm run typecheck`、`npm test`、`npm run build`，并按 [quickstart.md](./quickstart.md) 做本地界面和上下文安全检查；真实非生产联调可选，不要求生产验收。

**完成标准**：自动化/类型检查/构建通过，语音出站仍禁用，交付说明如实声明实际验证范围；不要求生产验收或独立 readiness 状态。

## 设计后项目章程复查

- **I. 可预期且可见的界面交互**: PASS。授权、连接、绑定回复上下文、发送结果和空状态明确区分；无自身有效上下文时提示 context-required，不把 accepted 显示为已送达。
- **II. 职责分层与目录**: PASS。沿用现有微信 inbox 模块；服务端解析 owner 和秘密，shared DTO 只表达安全摘要，Web 只选 binding。
- **III. 行为可验证**: PASS。TDD 覆盖目标隔离、一次性清理及保护数据不变、批次游标、发送失败、媒体、重启和滚动加载；协议实收单独验收。
- **IV. 凭证与额度操作安全**: PASS。保留全局 Web 守卫与 no-store；不接收客户端目标覆盖；秘密只存服务端；无验证时失败关闭。
- **V. 最小复杂度与可维护性**: PASS，但需承担数据隔离成本。用独立的按所属用户隔离的直接消息边界避免误迁联系人身份；不引入新运行时依赖或自动回退。
- **VI. 中文文档与代码注释**: PASS。新增文档为中文；iLink 字段、命令和来源名保留原文。

**历史设计检查（截至 2026-10-22）**：当时用户输入 `p` 授权继续离线实施，Gate 0 结论为 **BLOCKED**。使用当前唯一可发送绑定和新生成的逐消息 `msg.client_id` 无上下文直发，客户端返回 `invalid_response`；未确认实收或入站归属，也未验证真实双绑定隔离。当次未重试发送；BrowserSkill 标签页借用等待确认超时，未再次借用。当时基线 `npm run typecheck` 通过，routes 有 14 项预存失败。后续 2026-10-23 本地测试及 2026-10-24 单绑定终端观察见 `tasks.md`、`research.md`；2026-10-24 用户批准移除 readiness 后，旧 Gate 0 结论不再作为当前发送或发布规则。

## 复杂度跟踪

| 新增项 | 必要原因 | 拒绝更简单方案的原因 |
|---|---|---|
| 绑定用户 owner-scoped 直接消息存储边界 | 旧记录按联系人身份建立，按授权一次性清理后以绑定直接保存新消息和附件。 | 复用联系人关系违反产品要求；重映射旧消息会错误归属历史。 |
| 绑定自身私有入站上下文校验 | QR 登录成功和 poller 在线均不提供回复上下文。 | 全局验收状态不能证明本次所选绑定具有自己的有效上下文，且用户已批准移除独立 readiness。 |
