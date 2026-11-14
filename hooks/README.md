# QuotaHot Hook

`quotahot-hook` 是独立账户切换命令。默认自动触发入口是 **OpenCode 插件**：OpenCode 的 OpenAI（Codex）请求出现明确额度用尽信号时，hook 会选择可用的 Codex 账户并同步本机客户端凭证。OpenCode 的 Anthropic/Claude 额度错误不会触发自动切换；要切换 Claude 账户，请手动运行 `quotahot-hook switch --provider claude`。hook 不启动也不调用 QuotaHot Web 服务；与主程序共享的只有 `QUOTAHOT_DATA_DIR` 下的配置和账户文件。

独立 OmO Native 可单独安装 `quotahot-hook install omo` 扩展。它只在 OmO 自身的账户轮换、重试及模型 fallback 已结束，且 ChatGPT Subscription 模型最终明确报额度错误时切换 QuotaHot 的 Codex 账户；成功后重新加载 OmO 凭证并续跑一次。如果暂时没有可用账户，扩展按与 OpenCode 相同的额度恢复策略等待，并在额度恢复后续跑；用户输入、切换模型、成功完成、中止或关闭会话会取消等待。等待状态不跨重启保存。OmO 已有多个凭证槽时由 OmO 自己处理账户切换，QuotaHot 不覆盖它的账户池。扩展不处理 Claude 或单独的网络错误。

一次 Codex 切换会同步 Codex CLI、OpenCode，以及已经存在的 Pi Codex 和 OmO Native 凭证；手动切换 Claude 会同步 Claude Code 和已经存在的 Pi Claude 凭证。Codex CLI 和 Pi 不再安装 QuotaHot hook 或插件，也不会独立触发切换；安装时仅保留对可识别为 QuotaHot 自有的旧 Codex hook 条目和 Pi 扩展的清理。缺少 Pi `auth.json` 时不会创建该文件，清理也不会删除账户凭证或其他工具的 hook。

## 构建与安装

需要 Node.js 24 或更高版本：凭证锁使用 `node:sqlite`。

### 从分发包安装（Linux / macOS）

```bash
tar -xzf quotahot-hook-1.0.0.tar.gz
cd quotahot-hook-1.0.0
sh install.sh
# 仅安装独立 OmO Native 可改用：
# sh install.sh omo
export PATH="$HOME/.local/bin:$PATH"
quotahot-hook help
```

安装命令会把 bundle、`opencode-plugin-template.js` 和 `omo-plugin-template.js` 放到 `~/.local/bin/`。不带参数时同时注册 OpenCode 插件和独立 OmO Native 扩展，并清除旧版本中属于 QuotaHot 的 Codex/Pi 触发集成；`sh install.sh omo` 则只注册 OmO Native 扩展。模板必须与可执行文件保持同目录。脚本只接受可选的 `omo`，拒绝未知目标和多余参数。旧集成清理不会碰 Codex/Pi `auth.json`。

完成后重启或重新加载 OpenCode，并在 OmO 中执行 `/reload` 或重启 OmO。卸载 OpenCode 插件及可识别的旧 Codex/Pi 集成使用 `quotahot-hook uninstall`；卸载 OmO 扩展使用 `quotahot-hook uninstall omo`，都不会修改账户文件。

Windows 可解压同一压缩包，在固定目录运行 `node quotahot-hook help` 或 `node quotahot-hook install`，并将 `package.json`、插件模板与 bundle 放在一起；OmO 使用 `node quotahot-hook install omo`。shell 安装脚本仅支持 Linux/macOS。

### 从源码构建

```bash
cd hooks
npm install
npm run typecheck
npm test
npm run build
sh scripts/install.sh
# 仅安装独立 OmO Native 可改用：
# sh scripts/install.sh omo
export PATH="$HOME/.local/bin:$PATH"
quotahot-hook help
```

构建产物 `hooks/dist/quotahot-hook` 是包含依赖的 bundle；`hooks/dist/opencode-plugin-template.js` 和 `hooks/dist/omo-plugin-template.js` 是独立维护的运行时模板，须与 bundle 一起分发。`npm run build` 还会生成 `hooks/release/quotahot-hook-1.0.0.tar.gz`；打包需要系统安装 `tar`。

## 命令

```bash
quotahot-hook version
quotahot-hook install                 # 安装 OpenCode 插件并清理旧的 QuotaHot Codex/Pi 触发集成
quotahot-hook install omo             # 单独安装 OmO Native 扩展
quotahot-hook install omo --print     # 只预览 OmO 扩展
quotahot-hook uninstall omo           # 只卸载 OmO 扩展
quotahot-hook install --print         # 只预览 OpenCode 插件，不修改文件
quotahot-hook uninstall               # 移除额度切换插件及可识别的旧 Codex/Pi 触发集成
quotahot-hook status --provider codex
quotahot-hook switch --dry-run
quotahot-hook switch --no-check
quotahot-hook switch --provider claude # 手动切换 Claude 并同步 Claude Code/Pi 凭证
quotahot-hook run opencode             # OpenCode 插件使用的事件入口
quotahot-hook run omo                  # OmO Native 扩展使用的事件入口
quotahot-hook recovery-status         # 查看额度恢复轮询和等待会话
quotahot-hook recovery-status --json  # 机器可读的本地轮询状态
quotahot-hook recovery                # recovery-status 的简写
quotahot-hook recovery --json         # 机器可读的本地轮询状态
quotahot-hook install --help           # 仅打印帮助，不写文件
```

`install` 仅额外接受 `omo`，不接收 `codex`、`pi`、`all`；`run` 接受 `opencode` 和 `omo`。OmO 扩展写入 `$OMO_CODING_AGENT_DIR/extensions/quotahot.js`（未设置时为 `~/.omo/agent/extensions/quotahot.js`），只使用该 OmO agent 目录下已有的 `auth.json`，不创建登录凭证。使用项目级 OmO agent 目录时，安装和运行须指向同一目录；扩展执行时会以 OmO 当前 `ctx.agentDir` 为准。加载扩展可在 OmO 中执行 `/reload`。安装或卸载仅操作带 QuotaHot 标记的扩展文件，不会删除其他扩展或账户凭证。

OmO 多账户池中已有多个槽位时，扩展不会写回，继续使用 OmO 内置的账户轮换。单一 OAuth 槽位会连同顶层兼容字段一起更新；凭证写回备份为 `auth.json.quotahot-bak`。已经开始输出的模型请求不会被重放，续跑也不保证工具调用位置精确恢复；适配器每次真实用户输入至多自动续跑一次。

长参数提供单字母简写：`-c` 等价于 `--cache-seconds`（`status`、`switch`）；`-i` 等价于 `--min-interval-seconds`（`switch`、`run`）。两组参数的值仍以秒为单位，默认值不变；旧参数名继续支持。值可写在空格后或用等号连接，例如 `quotahot-hook switch -c=300 -i=60`。

### 自动恢复与重试边界

额度自动恢复由 OpenCode 的 OpenAI（Codex）明确配额信号，或独立 OmO Native 的 ChatGPT Subscription 最终额度错误建立等待。额度可用且会话空闲后，插件至多提交一次续跑；客户端仍在内部重试时不会重放任务。这不是从工具指令位置断点恢复，模型须核对已完成的工具动作，避免重复执行。

两端的额度查询使用同一套频率规则：

- 有新鲜额度数据时，只在最早重置时间加一分钟后再查询；没有未来重置时间就等待 `switch-state.json` 中的额度或查询回执发生变化。
- 缺少新鲜数据时，普通查询失败按 10、20、40、80 分钟退避；网络失败从 5 秒开始翻倍退避，最多五分钟。连续五次未取得新鲜数据后停止 API 轮询，继续监听本地状态变化。
- 切换锁竞争后等待一秒，并复用同一轮检查的查询回执。同一模块中请求账户身份相同的 OmO 会话共享一次检查；不同登录身份的回执不会直接用于续跑。
- 定时器唤醒不等于请求 API。OmO 每段等待最多一分钟，只核对本地时间，以便机器休眠或校时后及时识别已经到期的恢复时间。文件监听异常时每秒尝试恢复本地监听，也不会因此每秒查询额度。

- 真实用户新输入（包括附件）、主动中止（abort）、成功完成、会话删除或插件销毁都会终止对应恢复等待。关闭或重载插件也会取消进程内等待，不跨重启持久化。
- OmO 内部通知只有在合成标记（synthetic）或既定内部标记的来源已确认时，才不会被当作用户输入取消等待；不能只凭正文相似就认定为内部通知。
- 已核实的内部 OpenAI 尝试若以网络错误结束，可以保留**原先已排队的额度恢复**，但网络错误本身不能取得恢复资格。来源证据不完整时延后判断，不盲目续跑。
- Claude 额度错误、上下文超长、单独的网络错误和过载错误不会建立额度恢复等待。

三层重试各管一件事，不能混为一谈：

1. **OpenCode LLM 传输重试**：由 OpenCode 处理模型请求的传输失败，QuotaHot 不修改其默认重试行为。
2. **OmO runtime 模型 fallback**：由 OmO 决定是否改用其他模型，QuotaHot 不负责启用它。OpenCode 与 OmO 的具体行为取决于各自版本和配置。
3. **QuotaHot 额度/账户轮询**：只查询额度、选择账户并等待恢复，不代替前两层重试模型请求。

QuotaHot 单次额度查询使用固定 15 秒预算。Codex 只有遇到 404、405 或 HTML 403 才尝试备选 URL；网络错误、401、429、JSON 403 均不触发端点回退。出站路由按配置的 `proxy` / `noProxy` 一次选定，不会在代理失败后悄悄直连重试。

同进程额度事件共用查询；不同进程通过 `switch.lock` 和 `switch-state.json` 的最近检查回执复用结果。等待期间监听该状态文件，其他进程更新账户额度、重置时间或检查结果后重新检查。新鲜额度结果带重置时间时，按该时刻加一分钟缓冲安排下次检查；没有新鲜数据时才退避：

- 网络查询失败从 5 秒起指数退避，上限 5 分钟；普通无候选结果从 600 秒起退避，上限 80 分钟；切换锁竞争固定 1 秒重试。
- **连续五次检查无新鲜额度数据即停止主动轮询**，保留状态文件监听，待额度或重置状态变化再检查；5 分钟只是网络退避上限，不代表无限循环。

插件日志记录检查次数、结果、新鲜数据标志和重置时刻，不记录凭证。多个插件实例共用监听和检查，最后一个等待会话销毁时关闭监听。

`recovery-status`（或 `recovery`）检查本地 `$QUOTAHOT_DATA_DIR/recovery-status/*.json` 中的全部 OpenCode / OmO 快照，不向上游查询额度。输出区分插件来源，并显示等待会话数、会话 ID、阶段、实际下次检查时间；JSON 还包含最近一次检查结果。同一插件模块发布一份快照，OmO 内不同账户组的下次检查时间取最早值；多个进程分别显示。状态文件使用属主权限，在最后一个等待会话退出时删除；异常退出留下的有效快照若超过三分钟没有心跳，会在本次状态查询中标记为 `stale` 并删除，避免长期积累。快照仅用于诊断，不保存令牌或消息正文，也不会在重启后恢复任务。升级后需重新执行 `quotahot-hook install omo` 并重新加载扩展，旧版 OmO 扩展不会发布这些快照，历史失败会话也不会自动补建恢复任务。

## OpenCode 会话群通知

会话通知由独立插件 `quotahot-session-notify.js` 处理，不修改额度切换插件 `quotahot.js`。顶层 `quotahot-hook install` / `uninstall` 管理额度切换集成；通知插件须单独执行 `notify install` / `notify uninstall`，卸载只删除带有 QuotaHot 通知所有权标记的插件文件。通知模板 `opencode-notification-plugin-template.js` 须与可执行文件同目录；从源码构建后可在 `hooks/` 目录使用 `node dist/quotahot-hook`，不要假定 shell 安装脚本已安装通知模板。

已核对版本为 DWS CLI `v1.0.64` 与 OpenCode `1.19.3`，其他版本需重新核验。DWS 当前 Schema 仍标记 `confirmation=user_required`；`--yes` 只用于用户明确授权并启用的固定目标，不能扩展到其他群或私聊。版本或确认策略不匹配时停止，不尝试发送。

独立通知生命周期如下。真实环境中的命令须由用户在隔离测试通过后执行，将 `<openConversationId>` 替换为用户指定的精确群 ID：

```bash
quotahot-hook notify install --print
quotahot-hook notify install
quotahot-hook notify configure --group <openConversationId>
quotahot-hook notify status
quotahot-hook notify enable --yes
quotahot-hook notify disable
quotahot-hook notify uninstall
```

`configure` 通过 `dws chat +conversation-info` 核验精确群 ID 并显示群名称，保存后仍保持关闭；执行 `enable --yes` 表示明确授权未来符合条件的会话持续自动发送到该群。需要先安装并登录 `dws`，且 OpenCode 插件进程的 `PATH` 中必须能找到 `dws`。配置保存在 `$QUOTAHOT_DATA_DIR/session-notify.json`，不保存 DWS 凭证。执行 `disable` 后插件停止发送，但保留群配置供之后重新启用。

通知候选事件为 OpenCode `session.idle`，它本身不保证成功完成。插件会重新读取会话消息；只有最新用户消息之后存在已完成且无错误的最终 assistant 消息，并含可发送文本时才投递。每段（含 `i/n ` 前缀及空格）最多 1024 UTF-8 字节，在 Unicode code point 边界切分；这是当前环境已验证的保守客户端上限，不是 DWS 服务端最大值。分段串行发送，只有上一段状态查询明确返回 `SUCCESS` 且目标匹配才继续；受理成功或拿到 `openTaskId` 不等于投递成功。失败、超时、缺字段或状态未知时停止后续分段，未知片段不自动重发。已有成功片段时可能显示 `partial`，只有全部片段确认成功才显示 `sent`。

本地 ledger 按 session ID 和最终 assistant message ID 去重，重启遗留的 `in_progress` 按 unknown 处理，不自动重发。DWS 未公开服务端 exactly-once 或全局到达顺序保证；`sent` 也不表示群成员已读。`notify uninstall` 不代替 `disable`，移除插件前先停用配置。

### fake-DWS 隔离验证

在 `hooks/` 目录执行以下命令，使用仓库现有夹具，不启动真实 OpenCode 或调用真实 DWS：

```bash
node --import tsx --test --experimental-test-module-mocks \
  test/notification-config.test.ts \
  test/notification-target.test.ts \
  test/notification-delivery.test.ts \
  test/notification-ledger.test.ts \
  test/notification-send-cli.test.ts \
  test/plugin-notification.test.ts
```

CLI 夹具创建临时 `HOME`、`QUOTAHOT_DATA_DIR`，将 fake `dws` 放在 `PATH` 首位，记录合成目标与调用参数；其他场景使用注入调用器和 mock OpenCode client。安装路径测试也须隔离 `XDG_CONFIG_HOME`，不要读取真实凭证或允许 fake 失败后回退到系统 `dws`。重点检查最终正文选择、中文/emoji 字节边界、固定目标、逐段 `SUCCESS` 门禁、失败/未知停止、事件重放及本地去重。完整步骤见 [快速验证](../specs/003-opencode-session-notify/quickstart.md)。隔离通过只证明这些本地逻辑，不证明真实群权限、可用性或实际送达。

### 用户操作的真实群手动验收

仅在隔离测试通过后，由用户亲自执行上述安装、配置与启用命令；这不是自动化测试或代理代发步骤。用户须核对 `notify status` 中的群名称与精确 ID，并确认持续授权和群成员可见范围。启用后重启或重新加载 OpenCode，在专用会话生成一次带唯一测试标记、足以分段且无敏感信息的最终答复，亲自在目标群检查正文完整、片段顺序及有无重复，并检查可观察范围内的其他群/私聊是否误收。

结合插件结果记录本次真实实测结论，不能用 fake 测试代替。出现 `partial`、`failed` 或 `unknown` 时停止，不自动补发；验收后执行 `quotahot-hook notify disable`，再用 `notify status` 确认停用，按需执行 `quotahot-hook notify uninstall`。未执行用户手动验收时应记录为未执行，不保存真实群、消息、任务 ID 或凭证到项目文档。

## 账户与凭证同步

账户文件位于 `$QUOTAHOT_DATA_DIR/accounts/*.json`（默认 `~/.quotahot/accounts/`）。独立使用 hook 时也可以手动把账户 JSON 放入该目录：

```json
{
  "type": "codex",
  "email": "person@example.com",
  "account_id": "account-id",
  "access_token": "access-token",
  "refresh_token": "refresh-token",
  "id_token": "id-token",
  "expired": "2026-09-12T00:00:00.000Z",
  "auto_refresh": true,
  "disabled": false
}
```

配置文件 `$QUOTAHOT_DATA_DIR/config.json` 中读取 `proxy`、`noProxy` 和按 provider 保存的 `accountOrder`：

```json
{
  "proxy": "http://127.0.0.1:7897",
  "noProxy": ["localhost", "127.0.0.1", "::1"],
  "accountOrder": { "codex": ["codex:person@example.com"], "claude": [] }
}
```

需要切换时，候选账户先按对应 provider 的 `accountOrder` 中的账户 ID（`provider:email`）依次检查；未列出的账户随后按原有文件名顺序检查。缺失、无效、重复或已不存在的条目不会阻止切换。禁用账户仍被排除，不可用的候选账户仍会跳过；当前账户的检查和保留规则不变。`--dry-run` 和 `--no-check` 使用相同的候选顺序；没有有效顺序时保持原有文件名顺序。

切换目标由 provider 决定。Codex 账户会写入 `~/.codex/auth.json`、OpenCode 的 `auth.json`（仅在目标文件存在时）和 Pi `auth.json` 中的 `openai-codex` 项（仅在目标文件存在时）；Claude 账户会写 Claude Code 凭证与 Pi 的 `anthropic` 项（Pi 文件存在时）。切换仅更新对应账户和 provider 字段，Pi 的其他 provider 登录信息保留。目标文件会按现有同步逻辑备份并记录令牌字段的脱敏变更。

同步是覆盖本机客户端当前 provider 登录状态的操作。Codex CLI、OpenCode 或 Pi 可能需要重新加载或重启后才使用新凭证。hook 不编辑上游原始账户目录，也不替代客户端自身的登录流程。

## 边界与验证

- 切换走 `switch.lock`；凭证刷新使用按账户分的 SQLite 锁。
- `--dry-run` 不写切换状态、缓存或凭证；已过期且必须刷新才能判断的账户，无法在只读预览里评估。
- hook 出错时 fail-open，不会阻塞 OpenCode 的对话流程。
- hook 将 OpenCode 的 OpenAI（Codex）额度错误和单独安装的 OmO Native 扩展确认为账户额度错误的事件作为自动触发源；Claude 只支持手动切换并同步凭证，Codex CLI 与 Pi 不作为自动触发源。

```bash
cd hooks
npm run typecheck
npm test
npm run build
```
