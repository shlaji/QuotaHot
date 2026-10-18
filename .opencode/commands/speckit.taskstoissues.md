---
description: "已弃用：根据现有设计产物，将该功能的已有任务转换为可执行、按依赖关系排序的 GitHub 议题。"
tools: ['github/github-mcp-server/list_issues', 'github/github-mcp-server/issue_write']
---

## 弃用通知

你**必须首先显示以下简短警告**，将其作为本命令的第一步，且先于下方的“用户输入”和“执行前检查”部分：

> ⚠️ `/speckit.taskstoissues` 已弃用，将在未来的某个次版本中移除。请改用随附的 `github` 扩展：先运行 `specify extension add github`，再调用 `/speckit.github.taskstoissues`。

继续执行现有工作流，不作任何变更。不要自动安装或启用扩展，不要停止，也不要运行替代命令。

## 用户输入

```text
$ARGUMENTS
```

继续之前，你**必须**考虑用户输入（如果非空）。

## 执行前检查

**检查扩展钩子（将任务转换为议题之前）**：
- 检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果存在，读取该文件并查找 `hooks.before_taskstoissues` 键下的条目。
- 如果 YAML 无法解析或内容无效，不得静默跳过：告知用户无法读取 `.specify/extensions.yml`（附上解析器错误），且未检查任何钩子，包括其中注册的所有强制钩子（`optional: false`），然后正常继续。
- 过滤掉 `enabled` 显式为 `false` 的钩子。没有 `enabled` 字段的钩子默认视为启用。
- 对每个剩余钩子，**不要**尝试解释或求值其 `condition` 表达式：
  - 如果钩子没有 `condition` 字段，或该字段为 null 或空值，则视为可执行。
  - 如果钩子定义了非空的 `condition`，则跳过该钩子，将条件求值交给 HookExecutor 实现。
- 对每个可执行钩子，根据其 `optional` 标志输出以下内容：
  - **可选钩子**（`optional: true`）：
    ```
    ## Extension Hooks

    **Optional Pre-Hook**: {extension}
    Command: `/{command}`
    Description: {description}

    Prompt: {prompt}
    To execute: `/{command}`
    ```
  - **强制钩子**（`optional: false`）：
    ```
    ## Extension Hooks

    **Automatic Pre-Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}

    等待钩子命令返回结果后，再继续执行概要部分。
    ```
    输出上述块后，你必须实际调用该钩子，等待执行完成后才能继续。调用方式应与你在当前代理或会话中自行运行该命令的方式相同（实际调用形式可能不同于上面显示的字面 `{command}` ID，例如技能模式代理会使用 `/skill:speckit-...` 或 `$speckit-...`）。仅输出该块并不会运行钩子。
- 如果没有注册钩子，或 `.specify/extensions.yml` 不存在，则静默跳过。

## 执行概要

1. 在仓库根目录运行 `python3 .specify/scripts/python/check_prerequisites.py --json --require-tasks --include-tasks`，并解析 FEATURE_DIR 和 AVAILABLE_DOCS 列表。所有路径都必须是绝对路径。如果参数包含单引号，例如 "I'm Groot"，请使用转义语法，如 'I'\''m Groot'（如果可行，也可使用双引号："I'm Groot"）。
1. **如果存在**：加载 `.specify/memory/constitution.md`，获取项目原则和治理约束。
1. 从已执行脚本的输出中提取 **tasks** 的路径。
1. 运行以下命令获取 Git 远程地址：

```bash
git config --get remote.origin.url
```

> [!CAUTION]
> 只有远程地址是 GitHub URL 时，才能继续后续步骤。

1. **获取已有议题以去重**：创建任何议题之前，先从 `tasks.md` 构建待处理的任务 ID 集合（每个 ID 都是 `T` 后接**至少**三位数字，例如 `T001`；`/speckit.converge` 使用 `T{M+1:03d}` 分配新 ID，这规定的是位数下限而不是上限，因此文件中的任务超过 999 个后，ID 会有四位或更多数字）。然后使用 GitHub MCP 服务器的 `list_issues` 工具查找已涵盖这些 ID 的议题。不要传入 `state` 值，省略它会让工具同时返回未关闭和已关闭的议题。请求时设置 `perPage: 100`，以减少调用次数。该工具使用基于游标的分页，因此通过 `after` 参数请求下一页（使用上一次响应中的 `endCursor`）。对每个议题标题，使用任务 ID 模式 `\bT\d{3,}\b` 进行匹配（`{3,}` 支持四位及更长的 ID；如果使用 `\d{3}`，包含 `T1000` 的标题将完全无法匹配，因为末尾的 `\b` 不能位于两个数字之间，导致该任务既未去重也未创建，且不会收到提示。单词边界仍会阻止 `ST001` 这样的词元被匹配，并要求匹配完整的连续数字，因此 `T100` 绝不会匹配 `T1000` 的一部分；此模式也能识别 `T001 ...`、`T001: ...` 或 `[T001] ...` 形式的标题）。匹配到待处理的任务 ID 时，将该 ID 标记为已有议题。只要所有任务 ID 都已匹配，或已无更多页面，就停止分页，避免在所有任务 ID 都已找到对应议题后继续获取整个仓库的议题历史。这样既能限制议题历史庞大仓库的调用次数，也能在重新生成 `tasks.md` 后再次运行命令或重新调用技能时防止重复创建。
1. 对列表中的每个任务，使用 GitHub MCP 服务器在 Git 远程地址对应的仓库中创建新议题。`tasks.md` 中的任务行以 Markdown 复选框开头，因此先移除开头的 `- [ ]`（以及所有 `[P]` / `[US#]` 标记），提取任务 ID 和描述。创建议题时统一使用 `T001: <description>` 形式的规范标题，ID 只写一次，后接任务描述（例如，`- [ ] T001 Create project structure` 这一行应转换为标题 `T001: Create project structure`）。
   - 对 ID 已存在于上一步已有议题集合中的任务，**跳过**并报告（例如，`T001 already has an issue, skipping`）。
   - 仅为尚无匹配议题的任务创建议题。

> [!CAUTION]
> 在任何情况下，都绝不能在与远程 URL 不匹配的仓库中创建议题。

## 执行后检查

**检查扩展钩子（将任务转换为议题之后）**：
检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果存在，读取该文件并查找 `hooks.after_taskstoissues` 键下的条目。
- 如果 YAML 无法解析或内容无效，不得静默跳过：告知用户无法读取 `.specify/extensions.yml`（附上解析器错误），且未检查任何钩子，包括其中注册的所有强制钩子（`optional: false`），然后正常继续。
- 过滤掉 `enabled` 显式为 `false` 的钩子。没有 `enabled` 字段的钩子默认视为启用。
- 对每个剩余钩子，**不要**尝试解释或求值其 `condition` 表达式：
  - 如果钩子没有 `condition` 字段，或该字段为 null 或空值，则视为可执行。
  - 如果钩子定义了非空的 `condition`，则跳过该钩子，将条件求值交给 HookExecutor 实现。
- 对每个可执行钩子，根据其 `optional` 标志输出以下内容：
  - **可选钩子**（`optional: true`）：
    ```
    ## Extension Hooks

    **Optional Hook**: {extension}
    Command: `/{command}`
    Description: {description}

    Prompt: {prompt}
    To execute: `/{command}`
    ```
  - **强制钩子**（`optional: false`）：
    ```
    ## Extension Hooks

    **Automatic Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}
    ```
    输出上述块后，你必须实际调用该钩子，等待执行完成后才能继续。调用方式应与你在当前代理或会话中自行运行该命令的方式相同（实际调用形式可能不同于上面显示的字面 `{command}` ID，例如技能模式代理会使用 `/skill:speckit-...` 或 `$speckit-...`）。仅输出该块并不会运行钩子。
- 如果没有注册钩子，或 `.specify/extensions.yml` 不存在，则静默跳过。
