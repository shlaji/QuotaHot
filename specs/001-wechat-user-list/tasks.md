# 任务：微信多用户直连消息

**输入**：`/specs/001-wechat-user-list/` 中的设计文档

**前置条件**：`plan.md`、`spec.md`、`research.md`、`data-model.md`、`contracts/`、`quickstart.md`

**组织方式**：按 spec 用户故事及优先级分组。章程要求对可观察业务、HTTP 和持久化边界提供自动化验证；各故事任务内包含相应回归测试。

## 阶段 1：初始化（共享基础设施）

**用途**：确认现有微信收件箱模块和验证入口作为本功能实施基线，不新增运行时依赖。

- [X] T001 在 `src/server/wechat-inbox/`、`src/web/wechat-inbox/` 与 `src/shared/wechat-inbox.ts` 中沿用现有功能目录和职责边界
- [X] T002 [P] 在 `specs/001-wechat-user-list/quickstart.md` 中保留自动化验证、真实非生产观察及其限制的区分

---

## 阶段 2：基础工作（阻塞性前置任务）

**用途**：建立所有故事共用的 owner 身份、私有上下文及数据重置安全边界。

- [X] T003 在 `src/server/wechat-inbox/migrate.ts` 与 `store-schema.ts` 中实现按 FR-019 名单的一次性旧历史清理、每库独立事务及 version 1 完成标记，并在 inbox 事务内仅创建缺失的当前结构
- [X] T004 [P] 在 `test/wechat-inbox-binding-store.test.ts` 中验证清理不读取旧 schema、保留绑定/游标/当前 `inbox_binding_*` 数据及无关表，并覆盖外键保护、事务回滚和重复启动
- [X] T005 在 `src/shared/wechat-inbox.ts` 中定义仅含绑定用户安全摘要、owner-scoped 消息和发送状态的共享契约，不暴露 token 或独立 readiness

**检查点**：身份与持久化边界确定后开始故事阶段。

---

## 阶段 3：用户故事 1 - 绑定并管理多个微信用户（优先级：P1）🎯 MVP

**目标**：新增二维码授权不影响既有绑定；身份相同则更新原条目，身份不同则新增条目。

**独立测试**：使用模拟 QR 响应新增 A、保留 A 时新增 B、重复授权 A，并模拟取消、过期、身份缺失和凭证保存失败；确认只有有效身份及凭证成功保存后才写入绑定。

### 用户故事 1 的测试

- [X] T006 [P] [US1] 在 `test/wechat-login-service.test.ts` 中覆盖并发确认、重复授权、无效身份与凭证保存失败时绑定状态不变
- [X] T007 [P] [US1] 在 `test/wechat-pane.test.ts` 与 `test/wechat-qr-loader.test.ts` 中验证已有绑定时仍可独立开始新增 QR 授权，且取消/失败不退出或覆盖原绑定

### 用户故事 1 的实现

- [X] T008 [US1] 在 `src/server/wechat-login-service.ts` 中确保授权仅在有效 `ownerIlinkUserId` 和凭证持久化成功后按身份新增或更新绑定
- [X] T009 [US1] 在 `src/server/wechat-session-store.ts` 中保持绑定凭证按身份隔离，并移除持久浏览器会话写入
- [X] T010 [US1] 在 `src/web/components/WechatPane.tsx` 与 `src/web/wechat-inbox/InboxPane.tsx` 中展示新增二维码授权入口、全部绑定用户和空状态

**检查点**：授权新用户和重复授权均可独立验证，其他绑定不受影响。

---

## 阶段 4：用户故事 2 - 选择绑定用户并直接收发消息（优先级：P1）

**目标**：所选 QR 绑定是唯一目标；只有该绑定自身经过验证的非空入站 `context_token` 可用于发送和 typing；无联系人或独立 Conversation。

**独立测试**：两个合成 owner 分别入站并产生上下文，验证消息、目标与上下文隔离；缺失/空白/归属不明上下文均拒绝且不发外部请求。检查 accepted、failed、unknown 语义和媒体类型。

### 用户故事 2 的测试

- [X] T011 [P] [US2] 在 `test/wechat-inbox-sender.test.ts` 中验证 `{ msg }` 发送形状、`from_user_id: ""`、目标为所选 owner、每条新 UUID `client_id` 及 unknown 不自动重试
- [X] T012 [P] [US2] 在 `test/wechat-inbox-store-context.test.ts` 与 `test/wechat-inbox-context-access.test.ts` 中验证上下文按 owner 保存，缺失、空白、错误 owner 或客户端提供 token 时发送和 typing 均拒绝
- [X] T013 [P] [US2] 在 `test/wechat-inbox-client-updates.test.ts` 中验证仅 owner 匹配的入站消息进入正常消息流，异常身份不污染其他 owner

### 用户故事 2 的实现

- [X] T014 [US2] 在 `src/server/wechat-inbox/client-response.ts` 中保留入站 sender/recipient 原始语义并校验消息归属绑定 owner
- [X] T015 [US2] 在 `src/server/wechat-inbox/service.ts` 中仅编排绑定用户消息和其已验证私有上下文，不创建联系人或独立 Conversation
- [X] T016 [US2] 在 `src/server/wechat-inbox/sender.ts` 中仅从选中绑定解析目标与上下文，保存逐条独立本地消息并区分 accepted、failed、unknown
- [X] T017 [US2] 在 `src/server/wechat-inbox/typing.ts` 中复用所选绑定自身上下文校验，缺失时返回 context-required
- [X] T018 [US2] 在 `src/server/wechat-inbox/media*.ts` 中沿用并适配图片、文件、视频的绑定目标传输，保持语音出站禁用

**检查点**：两个 owner 的入站、文本及媒体收发不串线，且无联系人目标回退。

---

## 阶段 5：用户故事 3 - 重启后继续查看消息记录（优先级：P1）

**目标**：消息、附件及游标按绑定用户持久化、不自动过期；批次原子保存、分页去重，UI 向上滚动自动加载历史。

**独立测试**：两个 owner 各有超过两页消息与附件，重启后滚动读取，重复投递不重复显示；事务失败不推进游标，切换绑定不混入过期请求结果。

### 用户故事 3 的测试

- [X] T019 [P] [US3] 在 `test/wechat-inbox-store.test.ts` 中验证 owner-scoped 消息/附件/分块、同 owner 去重、批次与游标原子提交、失败回滚及重启恢复
- [X] T020 [P] [US3] 在 `test/wechat-inbox-web-loader.test.ts` 与 `test/wechat-inbox-web-dom.test.ts` 中验证向上滚动游标分页、阅读位置保持、多页无重复/遗漏及切换时丢弃旧请求

### 用户故事 3 的实现

- [X] T021 [US3] 在 `src/server/wechat-inbox/store*.ts` 中实现 owner-scoped 消息、附件和分块的持久化、游标分页及原子批次写入
- [X] T022 [US3] 在 `src/server/wechat-inbox/poller.ts` 中保持每绑定独立 worker、游标恢复及消息/附件成功提交后推进游标
- [X] T023 [US3] 在 `src/server/wechat-inbox/media*.ts` 中实现附件本地持久化标识和有界分块读写，不向 DTO 暴露 CDN 签名参数
- [X] T024 [US3] 在 `src/web/wechat-inbox/loader.ts` 中实现单 binding 状态、游标历史加载、请求取消与阅读位置保持
- [X] T025 [US3] 在 `src/web/wechat-inbox/Messages.tsx` 中实现滚动到历史边界时自动加载更早消息并展示绑定消息及媒体

**检查点**：重启、重复轮询和连续滚动均保持 owner 隔离及完整历史。

---

## 阶段 6：用户故事 4 - 识别授权与收发状态（优先级：P2）

**目标**：区分绑定授权、连接及消息结果；单个绑定错误不影响其他绑定，且界面不泄露秘密。

**独立测试**：模拟一个绑定失败、另一个正常收发，验证状态独立；检查 DTO、DOM、日志和错误不含认证秘密，accepted 不显示为送达。

### 用户故事 4 的测试

- [X] T026 [P] [US4] 在 `test/wechat-inbox-service.test.ts` 中验证授权/连接状态隔离、辅助生命周期通知失败不阻断手动收发
- [X] T027 [P] [US4] 在 `test/wechat-inbox-routes.test.ts` 中验证绑定级消息/typing 契约、context-required、认证/同源保护及 no-store
- [X] T028 [P] [US4] 在 `test/wechat-inbox-web-pane.test.ts` 与 `test/wechat-inbox-web-dom.test.ts` 中验证授权/连接/accepted/failed/unknown 的可见状态及秘密不进入 DOM

### 用户故事 4 的实现

- [X] T029 [US4] 在 `src/server/wechat-inbox/routes.ts` 中提供仅按 bindingId 操作的路由，删除 contacts 和独立本地 Conversation 路由并维持安全响应
- [X] T030 [US4] 在 `specs/001-wechat-user-list/contracts/operator-inbox.openapi.yaml` 中保持绑定级消息和 typing 契约与运行时一致，禁止客户端指定目标或上下文
- [X] T031 [US4] 在 `src/web/wechat-inbox/api.ts` 与 `src/web/wechat-inbox/Composer.tsx` 中实现手动发送、上下文缺失禁用和 accepted/failed/unknown 提示
- [X] T032 [US4] 在 `src/web/wechat-inbox/InboxPane.tsx` 中展示独立授权/连接/上下文摘要并移除联系人及独立本地 Conversation 选择界面

**检查点**：一个绑定的失败不会覆盖其他绑定状态，操作者可辨识真实发送结果。

---

## 阶段 7：完善与横切关注点

**用途**：执行整体验证并确认交付说明符合实际验证范围。

- [X] T033 在 `test/main.test.ts` 中验证全局 Web 守卫挂载、按绑定解除仅停止目标收发及重新授权恢复且保留历史
- [X] T034 [P] 在 `specs/001-wechat-user-list/quickstart.md` 中记录自动化隔离、数据库一次性清理和可选非生产观察步骤及限制
- [X] T035 在 `specs/001-wechat-user-list/quickstart.md` 中执行并记录 `npm run typecheck`、`npm test`、`npm run build` 及本地 UI/上下文安全验证结果

---

## 依赖关系与执行顺序

### 阶段依赖

- 初始化（阶段 1）无依赖。
- 基础工作（阶段 2）依赖初始化；完成后各用户故事可启动。
- 用户故事之间按身份/数据契约存在实现协作，但验收独立；建议按 P1 优先顺序完成 US1、US2、US3，再完成 P2 的 US4。
- 完善阶段依赖所有计划交付的故事。

### 用户故事依赖

- US1（P1）：依赖阶段 2；为后续选择绑定提供可管理的绑定列表。
- US2（P1）：依赖阶段 2 的 owner/context 边界；运行时依赖所选绑定，但可用合成绑定独立测试。
- US3（P1）：依赖阶段 2 的存储边界；与 US2 共享 owner 消息契约，可独立验证存储、恢复和分页。
- US4（P2）：依赖各故事产生的授权/连接/消息结果，但路由、DTO 和状态展示可用模拟结果独立测试。

### 可并行执行的工作

- 阶段 2：T004 与 T005 可并行；T003 属于 schema 修改，应与 T004 测试先后协调。
- US1：T006 与 T007 可并行。
- US2：T011、T012、T013 可并行；T014、T017 在文件不同且依赖契约明确后可并行。
- US3：T019 与 T020 可并行；T024 与 T025 在 loader 接口明确后可并行。
- US4：T026、T027、T028 可并行；T030 与不冲突的 Web 状态任务可并行。
- 各用户故事的数据契约稳定后可由不同人员并行，但共享 `service.ts`、`InboxPane.tsx` 和 store 文件应避免并发编辑。

### 各故事并行执行示例

```text
US1：并行编写 test/wechat-login-service.test.ts 与 test/wechat-pane.test.ts / test/wechat-qr-loader.test.ts。
US2：并行编写 sender、context store、client update 三组互不冲突的测试。
US3：并行编写 store 持久化测试与 Web 历史滚动测试。
US4：并行编写 service 状态、routes 契约与 Web 状态测试。
```

## 实施策略

### MVP 优先

1. 完成阶段 1、2，先保障 owner 身份、上下文和数据清理边界。
2. 完成阶段 3 的 US1，独立验证多用户新增、重复授权和失败不破坏既有绑定。
3. MVP 交付范围建议为 US1；完整消息产品还需 US2 和 US3，不能将绑定列表单独宣称为直连收发完成。

### 增量交付

1. 阶段 1、2 完成后，US1、US2、US3 可在接口协作下分支实施。
2. US1 提供绑定用户选择基础；US2 增加身份校验后的直连收发；US3 增加重启持久化和滚动历史。
3. US4 补全状态可见性和安全契约，最终阶段运行完整类型检查、测试、构建及 quickstart 验证。

## 备注

- 每项任务均使用 `- [ ] Tnnn` 检查清单格式，故事阶段任务含对应 `[USn]`；仅标记不同文件且无前置依赖的并行任务 `[P]`。
- 真实终端观察是可选的有日期记录，不是发送或发布门禁；合成多 owner 测试不得描述为真实多绑定实收。
- 语音出站保持禁用；不增加全局 readiness、Gate 0、联系人回退或旧历史迁移。

---

## 阶段 8：移除持久浏览器会话并收敛逐绑定管理（2026-10-25 修订）

**用途**：移除不再需要的扫码后浏览器登录会话；短期 QR flow cookie 仅保护待完成扫码流程，绑定管理与消息 API 统一使用全局 Web 访问控制。

- [X] T036 在 `src/server/wechat-login-service.ts`、`src/server/wechat-session-store.ts` 与 `src/server/wechat-routes.ts` 中移除持久浏览器会话签发/读取/退出，保留短期扫码流程保护及绑定生命周期
- [X] T037 阶段 8 曾提供全局 Web 守卫保护的按 `bindingId` 核验/解除路由；逐绑定核验已由阶段 9 的 T042 删除，当前仅保留解除路由，并保留其他绑定及解绑历史
- [X] T038 阶段 8 将扫码和解除放入绑定列表并移除顶部会话/退出界面；逐绑定 QR 核验 UI 已由阶段 9 的 T043 删除
- [X] T039 更新 `README.md`、`DESIGN.md` 与规格/契约文档，说明旧 `wechat_sessions` 仅惰性保留、短期 flow cookie 边界和逐绑定管理
- [X] T040 在相关 QR、会话存储、主路由、绑定 API 和浏览器测试中覆盖无持久浏览器会话流程，解除回执与 OpenAPI 一致且历史保留
- [X] T041 执行 `npm run typecheck`、`npm test`、`npm run build` 与微信列表/绑定管理浏览器验证；记录全量测试 2241/2241 通过。真实微信多绑定终端投递仍未验证

---

## 阶段 9：移除仅依赖内存 QR capability 的绑定核验（2026-10-25 修订）

**用途**：移除依赖进程内 retained QR capability 的“核验”功能；保留真实 inbox 连接状态、`relogin_required`、回复上下文和 `canSend`。

- [X] T042 在 `src/server/wechat-login-service.ts` 与 `src/server/wechat-routes.ts` 中删除 retained QR capability 依赖的核验方法、专用状态及 `/bindings/{bindingId}/check` 路由；以 binding revision 保留失败确认时 poller 恢复保护
- [X] T043 在 `src/web/wechat-api.ts`、`wechat-loader.ts` 与 `BindingControls.tsx` 中删除核验请求、按钮、核验专用结果标签和状态；保留 inbox 实际连接/只读状态、回复上下文及逐绑定解除
- [X] T044 在 README、`DESIGN.md` 与 feature 规格/研究/快速入门/OpenAPI 中删除现行核验承诺，说明 QR capability 仅存内存且重启后无核验功能；旧代码观察明确标为历史
- [X] T045 验证无运行时 `/check` 路由、UI 或 `getBindingStatus`/`recheckAfterChatError` API，且解绑、QR、连接状态、回复上下文和历史均保留；最终全量测试 2303/2303（含 390px/1440px 连续 ASCII 长消息溢出回归）、`npm run typecheck` 和 `npm run build`
