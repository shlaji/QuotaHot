# QuotaHot Hook

`quotahot-hook` 是一条独立的命令，额度用尽时把 Codex CLI、OpenCode 或 Claude Code 切到另一个账户。它不会启动也不会调用 QuotaHot 的 Web 服务，两个程序谁也不 import 谁的源码。

它们之间唯一的关联是磁盘上的文件约定：两边都可能读 `QUOTAHOT_DATA_DIR`（默认 `~/.quotahot`）下的 `config.json` 和账户 JSON，但构建、安装、运行各走各的。

## 构建与安装

需要 Node.js 24 或更高版本：凭证锁用的是 `node:sqlite`。

### 从分发包安装（Linux / macOS）

用 **`quotahot-hook-1.0.0.tar.gz`**，不是主程序那个 `quotahot` 包。目标机不需要签出源码、不需要 npm install，也不需要跑着 Web 服务，只要事先装好 Node.js 24+。

```bash
tar -xzf quotahot-hook-1.0.0.tar.gz
cd quotahot-hook-1.0.0
sh install.sh                       # 安装命令，并注册 Codex 和 OpenCode
export PATH="$HOME/.local/bin:$PATH"
quotahot-hook help
```

只注册一个客户端就用 `sh install.sh codex` 或 `sh install.sh opencode`。安装脚本不需要
`sudo`：它把 bundle 直接拷到 `~/.local/bin/quotahot-hook`，再跑一遍钩子注册命令。
已装过的命令和客户端里的注册项都是直接覆盖，不留 `.quotahot-bak` 备份。
上面那行 PATH 导出建议写进 shell 启动文件，换个终端也还在。
解压出来的目录装完就能删。

装完请重启 OpenCode 或开一个新的 Codex 会话。注册钩子并不会凭空生出账户，得先按下文
准备好账户文件。想摘掉客户端集成（账户文件不动）：

```bash
"$HOME/.local/bin/quotahot-hook" uninstall
```

Windows 上解压同一个压缩包，在一个固定目录里执行 `node quotahot-hook help` 或
`node quotahot-hook install`，并把 `package.json` 和 bundle 放在一起；那个 shell
安装脚本只管 Linux/macOS。

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

构建产物是 `hooks/dist/quotahot-hook`，一个自带全部依赖的 bundle，可以直接拷进 `PATH` 上的某个目录，不需要主程序的源码或构建产物。

`npm run build` 还会打出 `hooks/release/quotahot-hook-1.0.0.tar.gz`，里面是 bundle、
标记 CommonJS 的 package.json、安装脚本和这份 README；打包需要系统装了 `tar`。把压缩包
拷到目标机，按上面「从分发包安装」那一节走。主程序的构建不会产出这个独立的 Hook 包。

## 命令

```bash
quotahot-hook version
quotahot-hook install                    # Codex 和 OpenCode
quotahot-hook install codex              # 只装 Codex
quotahot-hook install opencode --print   # 只预览，不写文件
quotahot-hook uninstall                  # 两边的集成都摘掉
quotahot-hook status --provider codex
quotahot-hook switch --dry-run
quotahot-hook switch --no-check
quotahot-hook run codex                   # 事件 JSON 从 stdin 进
quotahot-hook run opencode                # 事件 JSON 从 stdin 进
quotahot-hook install --help              # 只打印该命令的用法，绝不动手安装
```

`--provider` 只认 `codex` 和 `claude`，给别的值直接报错，不会悄悄退回到另一个 provider。

安装时写进去的是 `quotahot-hook` 的绝对路径调用。Codex 那几条进 `~/.codex/hooks.json`；OpenCode 插件落在 `$XDG_CONFIG_HOME/opencode/plugin` 或 `plugins` 下。已有文件直接覆盖、不留备份，与本程序无关的 Codex 钩子逐条保留，卸载也只摘掉认得出是本程序的条目或本程序生成的插件。

安装和卸载只识别 `quotahot-hook run codex`。升级后执行 `quotahot-hook install` 并重启 OpenCode；Codex 换账户后要开新会话才生效。主程序 `quotahot` 不转发 hook 子命令。

为避免重复加载，OpenCode 插件文件名为 `quotahot.js`，生成标记 `quotahot:start/end`，并只导出 `QuotaHot` 与默认描述符；重新安装会更新原文件，而不是生成第二份插件。

## 账户与配置文件

想换数据目录就设 `QUOTAHOT_DATA_DIR`。钩子会读这些文件：

- `$QUOTAHOT_DATA_DIR/config.json`
- `$QUOTAHOT_DATA_DIR/accounts/*.json`
- `$QUOTAHOT_DATA_DIR/switch-state.json`
- `$QUOTAHOT_DATA_DIR/switch.lock`
- `<账户文件>.refresh-lock.db`

`config.json` 里只取 `proxy` 和 `noProxy` 两项：

```json
{
  "proxy": "http://127.0.0.1:7897",
  "noProxy": ["localhost", "127.0.0.1", "::1"]
}
```

每个账户文件都得写明 provider、身份、令牌和过期时间。不装主程序、不跑主服务也能直接把账户放进来：

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

Claude Code 用 `type: "claude"`。跟随某个客户端的账户可以把 `auto_refresh` 设成 `false`，再给出 `sync_path` 和 `sync_source`。这些文件应当只有属主可读；钩子刷新自己那份账户副本时，无关字段逐字保留。

## 边界与限制

- 切换走 `switch.lock`；凭证刷新用的是按账户分的 SQLite 锁，与所有使用同一个账户目录的进程共享。
- `--dry-run` 不写切换状态、缓存和凭证。已经过期、必须刷新才能判断的账户，在只读预览里评估不出来。
- OpenCode 的事件要先确认 provider 是 OpenAI、并且出现了明确的额度信号才会切。上下文超长和过载错误不触发切换。
- 钩子出错一律 fail-open，事件路径返回退出码 0，不会把宿主的对话卡住。
- Codex 切完必须开新会话。OpenCode 则是在重启/重载规则允许之后，下一个请求就用上新凭证。
- 两个程序共享的是文件格式，不是 API，也不是运行时生命周期。并发写只在凭证刷新和切换这两件事上协调过；任一程序正在更新文件时，不要手动去编辑它们。

## 开发

实现与接口模块都在 `src/` 下，回归测试在 `test/` 下。

```bash
cd hooks
npm run typecheck
npm test
npm run build
```

`dist/meta.json` 记着 esbuild 的每一个输入。隔离测试会断言其中没有任何一项来自 `../src`，主包那边也单独把 `hooks/` 排除在 TypeScript 与 bundle 的输入之外。
