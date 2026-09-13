<!-- headroom:memory-instructions -->
## 记忆

使用 `headroom_memory` MCP 服务保存跨会话复用的持久知识。

在回答有关过往决策、约定、项目上下文、架构、用户偏好、组织信息、代号、
调试历史或其他历史会话内容的问题前，先调用 `memory_search`。

在形成长期有效的决策、发现稳定约定或获得重要事实后，调用 `memory_save`，
将信息保存给后续会话使用。

对于当前对话中不可见的信息，记忆库是第一事实来源。

## 仓库结构

- 根目录包是 Hono/React QuotaHot Web 服务，命令为 `quotahot`。`src/main.ts` 是 CLI 入口；`src/server/main.ts` 启动 HTTP/SSE 服务；`src/web/` 存放 React 界面；`src/shared/` 存放共享类型、调度逻辑和工具函数。
- `hooks/` 是独立的 `quotahot-hook` 包，用于切换 Codex、OpenCode 或 Claude Code 账户，不会导入根应用，也不会启动 Web 服务。两者唯一的共享契约是 `QUOTAHOT_DATA_DIR` 下的磁盘数据，默认目录为 `~/.quotahot`。根包和 hook 的版本必须保持一致，`hooks/scripts/build.mjs` 会拒绝版本不匹配。
- QuotaHot 使用 `QUOTAHOT_*` 环境变量、`quotahot.service` 和 `quotahot.js` OpenCode 插件；用户可见品牌为 QuotaHot。
- Node.js 需要 24 或更高版本，因为项目使用内置的 `node:sqlite`。两个包都使用原生 ESM 源码，并打包为可运行的 CommonJS 可执行文件。

## 常用命令

- 根包安装与检查：`npm install`、`npm run typecheck`、`npm test`。
- 根包开发：`npm run dev` 会在 `5173` 启动 Vite，并在 `8686` 启动 Hono 服务；Vite 会将 `/api` 反代到 `PORT` 指定的端口，未设置时使用 `8686`。
- 根包生产构建：完整构建入口只有 `npm run build`。它会构建 Vite 前端，将 `src/main.ts` 打包为 `dist/quotahot`，再在 `release/` 下生成 SEA 和压缩包产物。除非有意覆盖 `dist/`，否则不要在此后单独运行前端构建。
- 根包运行：`npm start` 会先构建，再启动打包后的服务。`PORT` 修改端口，`QUOTAHOT_DATA_DIR` 修改持久化数据目录，`QUOTAHOT_HOST` 修改监听地址。
- Hook 检查与构建：`cd hooks && npm install && npm run typecheck && npm test && npm run build`。构建会生成 `hooks/dist/quotahot-hook` 和 `hooks/release/quotahot-hook-<version>.tar.gz`；生成压缩包需要系统安装 `tar`。

## 工作约束

- 根目录 `tsconfig.json` 只包含 `src/**/*.ts`、`src/**/*.tsx` 和 `vite.config.ts`。Hook 代码由 `hooks/tsconfig.json` 检查，因此修改 `hooks/` 后必须单独执行 hook 的检查命令。
- 应用会在自己的数据目录中持久化状态和账户副本。不要直接编辑或复用上游客户端的凭证文件；请使用 `README.md` 中说明的导入和同步流程。
- `scripts/install.sh` 会在 Linux 上安装根服务为 systemd 用户服务，不需要 `sudo`；`hooks/scripts/install.sh` 会注册客户端集成。两个安装脚本都会修改用户配置且直接覆盖旧文件、不留备份，检查行为时优先使用 dry-run 或 help 模式。
