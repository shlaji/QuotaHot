# QuotaHot Hook

`quotahot-hook` 是独立账户切换命令。自动触发入口只有 **OpenCode 插件**：OpenCode 的 OpenAI（Codex）请求出现明确额度用尽信号时，hook 会选择可用的 Codex 账户并同步本机客户端凭证。OpenCode 的 Anthropic/Claude 额度错误不会触发自动切换；要切换 Claude 账户，请手动运行 `quotahot-hook switch --provider claude`。hook 不启动也不调用 QuotaHot Web 服务；与主程序共享的只有 `QUOTAHOT_DATA_DIR` 下的配置和账户文件。

一次 Codex 切换会同步 Codex CLI、OpenCode，以及已经存在的 Pi Codex 凭证；手动切换 Claude 会同步 Claude Code 和已经存在的 Pi Claude 凭证。Codex CLI 和 Pi 不再安装 QuotaHot hook 或插件，也不会独立触发切换；安装时仅保留对可识别为 QuotaHot 自有的旧 Codex hook 条目和 Pi 扩展的清理。缺少 Pi `auth.json` 时不会创建该文件，清理也不会删除账户凭证或其他工具的 hook。

## 构建与安装

需要 Node.js 24 或更高版本：凭证锁使用 `node:sqlite`。

### 从分发包安装（Linux / macOS）

```bash
tar -xzf quotahot-hook-1.0.0.tar.gz
cd quotahot-hook-1.0.0
sh install.sh
export PATH="$HOME/.local/bin:$PATH"
quotahot-hook help
```

安装命令会把 bundle 和 `opencode-plugin-template.js` 一起放到 `~/.local/bin/`，注册 OpenCode 插件，并清除旧版本中属于 QuotaHot 的 Codex/Pi 触发集成。模板必须与可执行文件保持同目录，`install` 与 `install --print` 都会读取它并填入当前可执行文件的完整命令参数。安装前会拒绝客户端目标参数。旧集成清理不会碰 Codex/Pi `auth.json`。

完成后重启或重新加载 OpenCode。卸载时运行 `quotahot-hook uninstall`；它会移除 QuotaHot OpenCode 插件及可识别的旧 Codex/Pi 集成，不会修改账户文件。

Windows 可解压同一压缩包，在固定目录运行 `node quotahot-hook help` 或 `node quotahot-hook install`，并将 `package.json`、`opencode-plugin-template.js` 与 bundle 放在一起；shell 安装脚本仅支持 Linux/macOS。

### 从源码构建

```bash
cd hooks
npm install
npm run typecheck
npm test
npm run build
sh scripts/install.sh
export PATH="$HOME/.local/bin:$PATH"
quotahot-hook help
```

构建产物 `hooks/dist/quotahot-hook` 是包含依赖的 bundle，`hooks/dist/opencode-plugin-template.js` 是独立维护的插件运行时模板；两者须一起分发。`npm run build` 还会生成 `hooks/release/quotahot-hook-1.0.0.tar.gz`；打包需要系统安装 `tar`。

## 命令

```bash
quotahot-hook version
quotahot-hook install                 # 安装 OpenCode 插件并清理旧的 QuotaHot Codex/Pi 触发集成
quotahot-hook install --print         # 只预览 OpenCode 插件，不修改文件
quotahot-hook uninstall               # 移除 QuotaHot 拥有的所有触发集成
quotahot-hook status --provider codex
quotahot-hook switch --dry-run
quotahot-hook switch --no-check
quotahot-hook switch --provider claude # 手动切换 Claude 并同步 Claude Code/Pi 凭证
quotahot-hook run opencode             # OpenCode 插件使用的事件入口
quotahot-hook recovery-status         # 查看额度恢复轮询和等待会话
quotahot-hook recovery-status --json  # 机器可读的本地轮询状态
quotahot-hook recovery                # recovery-status 的简写
quotahot-hook recovery --json         # 机器可读的本地轮询状态
quotahot-hook install --help           # 仅打印帮助，不写文件
```

`install` 不接收 `codex`、`pi`、`all` 等客户端目标；`run` 只接受 `opencode`。Codex/Pi 插件安装入口已移除，仅保留旧 QuotaHot 集成的归属识别与清理；凭证写回仍可使用。OpenCode 插件写入 `$XDG_CONFIG_HOME/opencode/plugin/quotahot.js`（若已有 `plugins/` 目录则使用它），文件由 QuotaHot 标记以便安全更新和卸载。

长参数提供单字母简写：`-c` 等价于 `--cache-seconds`（`status`、`switch`）；`-i` 等价于 `--min-interval-seconds`（`switch`、`run`）。两组参数的值仍以秒为单位，默认值不变；旧参数名继续支持。值可写在空格后或用等号连接，例如 `quotahot-hook switch -c=300 -i=60`。

额度错误后的自动切换仅响应 OpenCode 的 OpenAI（Codex）明确配额信号。OpenCode 仍在内部重试时不会重放任务；若请求因额度终止、会话进入空闲，且没有新用户消息或取消，插件会在额度恢复后至多自动续跑一次。等待期间插件监听数据目录中的 `switch-state.json`：其他进程更新账户额度或重置时间后立即重新检查；没有外部更新时，根据已知最早重置时间（包括初次切换返回的 `waitUntil`）加一分钟检查。没有有效重置时间时采用 10 分钟基础间隔的指数退避，上限 80 分钟；已过期的重置时间不会造成密集重试。多个插件实例共用监听和检查，销毁最后一个等待会话时关闭监听。该续跑不是原请求的断点恢复，模型必须核对先前完成的工具动作，避免重复执行。关闭或重载插件会取消进程内等待，不跨重启持久化；Claude 额度错误、上下文超长、网络错误和过载错误不会触发额度恢复流程。

`recovery-status` 检查本地 `$QUOTAHOT_DATA_DIR/recovery-status/*.json` 中的全部快照，不向上游查询额度。同一插件模块内多个等待会话共享一个轮询器、一份快照；多个 OpenCode 进程则分别显示。输出包括等待会话数、会话阶段、实际下次检查时间和最近一次检查结果。状态文件使用属主权限，在最后一个等待会话退出时删除；异常退出留下的有效快照若超过三分钟没有心跳，会在本次状态查询中标记为 `stale` 并删除，避免长期积累。快照仅用于诊断，不保存令牌或消息正文，也不会在重启后恢复任务。

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

配置文件 `$QUOTAHOT_DATA_DIR/config.json` 中只读取 `proxy` 和 `noProxy`：

```json
{
  "proxy": "http://127.0.0.1:7897",
  "noProxy": ["localhost", "127.0.0.1", "::1"]
}
```

切换目标由 provider 决定。Codex 账户会写入 `~/.codex/auth.json`、OpenCode 的 `auth.json`（仅在目标文件存在时）和 Pi `auth.json` 中的 `openai-codex` 项（仅在目标文件存在时）；Claude 账户会写 Claude Code 凭证与 Pi 的 `anthropic` 项（Pi 文件存在时）。切换仅更新对应账户和 provider 字段，Pi 的其他 provider 登录信息保留。目标文件会按现有同步逻辑备份并记录令牌字段的脱敏变更。

同步是覆盖本机客户端当前 provider 登录状态的操作。Codex CLI、OpenCode 或 Pi 可能需要重新加载或重启后才使用新凭证。hook 不编辑上游原始账户目录，也不替代客户端自身的登录流程。

## 边界与验证

- 切换走 `switch.lock`；凭证刷新使用按账户分的 SQLite 锁。
- `--dry-run` 不写切换状态、缓存或凭证；已过期且必须刷新才能判断的账户，无法在只读预览里评估。
- hook 出错时 fail-open，不会阻塞 OpenCode 的对话流程。
- hook 仅将 OpenCode 的 OpenAI（Codex）额度错误作为自动触发源；Claude 只支持手动切换并同步凭证，Codex CLI 与 Pi 不作为自动触发源。

```bash
cd hooks
npm run typecheck
npm test
npm run build
```
