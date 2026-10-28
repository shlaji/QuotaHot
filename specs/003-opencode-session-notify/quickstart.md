# 快速验证

## 前置条件

- Node.js 24 或更高版本。
- 已核对的版本为 OpenCode `1.19.3` 和 DWS CLI `v1.0.64`。历史授权实测的范围见 [research.md](research.md)，不代表其他版本已验证兼容。
- 隔离测试不需要真实 DingTalk 身份或群。真实群验收才需要用户安装并登录 `dws`，且 OpenCode 插件进程的 `PATH` 能找到它。
- 真实发送前，用户必须指定精确的 `openConversationId`，核对群身份并明确授权持续通知。当前 DWS Schema 仍标记 `confirmation=user_required`，不能将 `--yes` 理解为免授权；版本或确认策略不匹配时停止，不尝试发送。

## 安装与检查

在仓库根目录执行：

```bash
cd hooks
npm install
npm run typecheck
npm test
npm run build
```

不要在测试中执行 shell 安装脚本或覆盖真实用户配置。顶层 `quotahot-hook install` 管理额度切换插件；通知插件使用独立的 `notify install` / `notify uninstall`。从源码构建后，可在 `hooks/` 目录用 `node dist/quotahot-hook` 代替已安装的 `quotahot-hook`；通知模板 `dist/opencode-notification-plugin-template.js` 须与 bundle 同目录，不能假定 shell 安装脚本已将它安装到目标位置。

## fake-DWS 隔离验证

在 `hooks/` 目录运行通知相关测试，不启动真实 OpenCode，也不调用真实 DWS：

```bash
node --import tsx --test --experimental-test-module-mocks \
  test/notification-schema.test.ts \
  test/notification-target.test.ts \
  test/notification-config.test.ts \
  test/notification-delivery.test.ts \
  test/notification-ledger.test.ts \
  test/notification-send-cli.test.ts \
  test/plugin-notification.test.ts
```

`test/notification-cli-fixture.ts` 为 CLI 测试创建临时 `HOME`、`QUOTAHOT_DATA_DIR` 和置于 `PATH` 首位的 fake `dws`，记录调用参数并返回合成群身份、受理和状态响应；其他测试使用注入的 DWS 调用器或 mock OpenCode client。需要扩展场景时沿用这些夹具，不读取真实凭证，不填入真实目标，不回退到系统 `dws`。涉及安装路径时也应将 `XDG_CONFIG_HOME` 指向临时目录。

检查测试输出与断言，验收范围包括：

1. 默认关闭；配置仅接受核验后的精确群 ID，并显示合成群名称；`enable --yes` 才启用持续发送，`disable` 后不再发起发送。
2. mock session 包含多条 assistant、user 和工具消息时，只选最新用户消息之后最终已完成、无错误的 assistant 可见正文。取消、错误、空正文或读取失败时不发送。
3. 用 ASCII、中文和 emoji 长正文检查分段：每段含 `i/n ` 前缀及空格最多 1024 UTF-8 字节，只在 Unicode code point 边界切分。该值是保守客户端上限，不是服务端最大长度。
4. 记录各段调用顺序及目标：只有上一段状态查询明确返回 `SUCCESS` 且目标匹配，才发送下一段；仅受理成功或取得 `openTaskId` 不算投递成功。模拟失败、超时、缺字段和未知状态后，后续分段必须停止，未知片段不自动重发。已有成功片段时可能显示 `partial`，不能据此认为其余片段已送达。
5. 重放同一 session/message、跨进程重放及并发场景检查本地 ledger 去重；重启遗留的 `in_progress` 按 unknown 处理。该机制不是服务端 exactly-once 保证，也不保证全局到达顺序。

隔离测试仅验证本地选择、路由、分段、状态处理和去重逻辑，不证明真实账号权限、群可用性或实际送达。不要把这些测试结果写成真实群验收通过。

## 用户操作的真实群手动验收

本节仅供用户在隔离测试通过后亲自执行，不属于自动化测试或代理代发步骤。消息可能包含敏感信息，先确认群成员可见范围，并准备无敏感内容的专用测试会话。

1. 用户确认本机版本与上述已核对版本一致、DWS 已登录、持续发送授权仍有效，并确认通知模板与可执行文件同目录。
2. 用户先预览并安装独立通知插件，再核验自己指定的精确目标。以下占位符须由用户替换，不要原样粘贴到 shell：

   ```bash
   quotahot-hook notify install --print
   quotahot-hook notify install
   quotahot-hook notify configure --group <openConversationId>
   quotahot-hook notify status
   ```

3. 用户核对输出的群名称和 ID。`configure` 后仍关闭；确认无误后，用户执行以下命令，明确授权未来符合条件的会话持续自动发送到该群，然后重启或重新加载 OpenCode：

   ```bash
   quotahot-hook notify enable --yes
   quotahot-hook notify status
   ```

4. 用户在专用会话中生成一次含唯一测试标记、足以分段的无敏感最终答复，亲自在目标群核对正文完整性、`1/n ... n/n` 顺序及有无重复，并检查可观察范围内的其他群/私聊是否误收。结合插件结果记录本次实测结论；`sent` 表示所有片段的 DWS 状态均已确认成功，不等于成员已读或服务端 exactly-once 保证。出现 `partial`、`failed` 或 `unknown` 时停止验收，不自动补发。
5. 用户验收后停用通知，并按需卸载独立插件：

   ```bash
   quotahot-hook notify disable
   quotahot-hook notify status
   quotahot-hook notify uninstall
   ```

`disable` 保留群配置；`notify uninstall` 只移除带有 QuotaHot 通知所有权标记的插件文件，不代替停用配置。不要在项目文档中保存真实群、消息、任务 ID 或凭证。没有完成上述用户手动步骤时，真实群验收应记录为未执行。

详细数据状态见 [data-model.md](data-model.md)，接口与运行时门禁见 [contracts/opencode-dingtalk-notification.md](contracts/opencode-dingtalk-notification.md)。
