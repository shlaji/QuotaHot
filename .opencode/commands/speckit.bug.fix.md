---
description: 实施缺陷评估中的修复方案，并记录改动
---


<!-- Extension: bug -->
<!-- Config: .specify/extensions/bug/ -->
# 修复缺陷

实施 `/speckit.bug.assess` 提出的修复方案，并在 `.specify/bugs/<slug>/fix.md` 中记录改动。**只有**指定 slug 已有评估报告时，才能使用此命令。

## 用户输入

```text
$ARGUMENTS
```

用户输入应指明待修复的缺陷。接受以下任一形式：

- `slug=<bug-slug>`、`--slug <bug-slug>`，或单独符合 slug 形式的标记。
- 包含 slug 的路径（例如 `.specify/bugs/login-timeout/`）。
- **无输入**：回退到上下文（见下文）。

## 解析 slug

按以下顺序解析 `BUG_SLUG`，找到首个匹配项即停止：

1. **用户显式输入**：通过 `$ARGUMENTS` 传入的 slug（上述任一形式）。
2. **对话上下文**：如果当前会话刚运行过 `/speckit.bug.assess`，则使用其报告的 slug，无需再次询问。检查 `.specify/bugs/<slug>/assessment.md` 是否存在以确认；若不存在，继续下一项。
3. **磁盘上只有一个候选项**：列出 `.specify/bugs/*/assessment.md`。如果只找到一个匹配的 `assessment.md`，使用其父目录名作为 slug。
4. **消除歧义**：
   - **交互模式**：列出候选项，并询问用户要修复哪个缺陷。
   - **自动化模式**：停止并报错，列出候选项。不得猜测。

解析完成后，设置 `BUG_SLUG` 和 `BUG_DIR = .specify/bugs/<BUG_SLUG>`，并在回复中简述采用的解析方式（显式输入 / 来自上下文 / 唯一候选项 / 询问用户）。

## 前置条件

- `BUG_DIR/assessment.md` 必须存在。若不存在，停止并告知用户先运行 `/speckit.bug.assess`。
- 如果 `BUG_DIR/fix.md` 已存在，交互模式下先询问用户是否覆盖，再继续；自动化模式下拒绝覆盖。
- 完整阅读 `BUG_DIR/assessment.md`。将其中的**修复方案**、**可能修改的文件**、**需新增或更新的测试**及**风险与注意事项**视为此命令的执行契约。

## 执行前检查

此时已解析 `BUG_SLUG` 和 `BUG_DIR`，本会话中运行的钩子命令可以从对话中复用它们；不会自动向钩子传递任何内容。

**检查扩展钩子（缺陷修复前）**：
- 检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果存在，读取并查找 `hooks.before_bug_fix` 键下的条目。
- 如果 YAML 无法解析或内容无效，不得静默跳过：告知用户无法读取 `.specify/extensions.yml`（附解析器错误），且未检查任何钩子，包括其中注册的强制钩子（`optional: false`），然后正常继续。
- 过滤掉 `enabled` 明确为 `false` 的钩子。没有 `enabled` 字段的钩子默认启用。
- 对于其余每个钩子，**不得**尝试解释或求值其 `condition` 表达式：
  - 没有 `condition` 字段，或该字段为 null/空时，将钩子视为可执行。
  - 如果定义了非空的 `condition`，跳过该钩子，将条件求值留给 HookExecutor 实现。
- 对每个可执行钩子，根据其 `optional` 标志输出以下内容：
  - **可选钩子**（`optional: true`）：
    ```
    ## 扩展钩子

    **可选前置钩子**: {extension}
    命令: `/{command}`
    说明: {description}

    提示词: {prompt}
    执行方式: `/{command}`
    ```
  - **强制钩子**（`optional: false`）：
    ```
    ## 扩展钩子

    **自动前置钩子**: {extension}
    正在执行: `/{command}`
    EXECUTE_COMMAND: {command}

    等待钩子命令返回结果后，再进入执行阶段。
    ```
    输出上述内容后，必须实际调用钩子，等待其完成后再继续。使用当前代理/会话中正常运行该命令的方式调用（调用形式可能不同于上面显示的字面标识 `{command}`，例如技能模式代理使用 `/skill:speckit-...` 或 `$speckit-...`）。仅输出上述内容并不会运行钩子。
- 如果未注册钩子，或 `.specify/extensions.yml` 不存在，静默跳过。

## 执行

1. **确认计划**
   - 根据评估，用 3 至 6 个要点重述即将修改的内容和位置。
   - 如果评估判定为 `invalid`，停止，因为没有需要修复的内容。告知用户并退出。
   - 如果判定为 `likely valid, needs reproduction`，且仍有未解决的 `[NEEDS CLARIFICATION]` 项，明确指出这些问题；交互模式下询问用户是否继续，自动化模式下停止。

2. **实施修复方案**
   - 按首选修复方案修改代码。仅修改评估列出的文件，除非新发现的证据要求扩大范围（此时须在报告中明确记录扩大的范围）。
   - 新增或更新评估要求的测试，避免缺陷悄然回归。
   - 保持最小改动，不重构无关代码，也不引入评估未要求的依赖。
   - 如果发现评估有误（方案无效或根因在别处），立即停止修改代码，在修复报告的**与评估的偏差**一节中记录新发现，并建议重新运行 `/speckit.bug.assess`。

3. **运行本地检查**
   - 如果项目有明确的测试命令（例如 `pytest`、`npm test`、`cargo test`），运行覆盖改动路径的测试。记录通过/失败情况及关键输出。
   - 未经用户同意，不得运行有破坏性或依赖网络的测试套件。

4. **写入修复报告**

   使用以下结构写入 `BUG_DIR/fix.md`：

   ```markdown
   # 缺陷修复: <简短标题>

   - **Slug**: <BUG_SLUG>
   - **Fixed**: <ISO 8601 日期>
   - **Assessment**: ./assessment.md
   - **Status**: applied | partial | not-applied

   ## 摘要

   <用一两句话说明改动及原因。>

   ## 改动

   | 文件 | 改动 | 备注 |
   |------|--------|-------|
   | `path/to/file.py` | <新增 / 修改 / 删除> | <简短备注> |
   | `path/to/test_file.py` | 新增测试 | <简短备注> |

   ## 关键差异（可选）

   <简短展示最重要的差异片段，不要完整堆砌全部差异。>

   ## 新增或更新的测试

   - `path/to/test_file.py::test_name`：<该测试保障的行为>

   ## 本地验证

   - 运行的命令: `<command>` → <简要结果>
   - 人工检查: <手动验证的内容，如有>

   ## 与评估的偏差

   <无偏差则留空。否则，列出实际修复偏离方案的地方及原因。>

   ## 后续事项

   - <建议的清理、监控、文档更新等>
   ```

## 必须完成的执行后钩子检查

**向用户报告完成前，必须完成本节。**

此时已解析 `BUG_SLUG` 和 `BUG_DIR`，且报告已写入，本会话中运行的钩子命令可以从对话中复用它们；不会自动向钩子传递任何内容。

检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果不存在，或 `hooks.after_bug_fix` 下未注册钩子，跳转至完成报告。
- 如果存在，读取并查找 `hooks.after_bug_fix` 键下的条目。
- 如果 YAML 无法解析或内容无效，不得静默跳过：告知用户无法读取 `.specify/extensions.yml`（附解析器错误），且未检查任何钩子，包括其中注册的强制钩子（`optional: false`），然后继续至完成报告。
- 过滤掉 `enabled` 明确为 `false` 的钩子。没有 `enabled` 字段的钩子默认启用。
- 对于其余每个钩子，**不得**尝试解释或求值其 `condition` 表达式：
  - 没有 `condition` 字段，或该字段为 null/空时，将钩子视为可执行。
  - 如果定义了非空的 `condition`，跳过该钩子，将条件求值留给 HookExecutor 实现。
- 对每个可执行钩子，根据其 `optional` 标志输出以下内容：
  - **强制钩子**（`optional: false`）：**必须为每个强制钩子输出 `EXECUTE_COMMAND:`**：
    ```
    ## 扩展钩子

    **自动钩子**: {extension}
    正在执行: `/{command}`
    EXECUTE_COMMAND: {command}
    ```
    输出上述内容后，必须实际调用钩子，等待其完成后再继续。使用当前代理/会话中正常运行该命令的方式调用（调用形式可能不同于上面显示的字面标识 `{command}`，例如技能模式代理使用 `/skill:speckit-...` 或 `$speckit-...`）。仅输出上述内容并不会运行钩子。
  - **可选钩子**（`optional: true`）：
    ```
    ## 扩展钩子

    **可选钩子**: {extension}
    命令: `/{command}`
    说明: {description}

    提示词: {prompt}
    执行方式: `/{command}`
    ```

## 完成报告

**向用户报告**以下内容：

- slug 及 `BUG_DIR/fix.md` 路径。
- 状态（`applied`、`partial`、`not-applied`）。
- 建议的下一步：`/speckit.bug.test slug=<BUG_SLUG>`。

## 安全约束

- 绝不修改项目工作区之外的文件。
- 绝不编辑 `assessment.md`，它是执行依据。在 `fix.md` 的**与评估的偏差**一节中记录不同意见。
- 除非评估明确要求，否则绝不删除文件。
- 未经确认，绝不覆盖已有的 `fix.md`。
