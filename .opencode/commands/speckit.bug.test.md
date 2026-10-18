---
description: 验证先前修复的缺陷是否已解决，并记录验证报告
---


<!-- Extension: bug -->
<!-- Config: .specify/extensions/bug/ -->
# 测试缺陷修复

验证 `/speckit.bug.fix` 记录的修复是否确实解决了 `/speckit.bug.assess` 描述的缺陷。输出为 `.specify/bugs/<slug>/test.md` 中的验证报告。

## 用户输入

```text
$ARGUMENTS
```

用户输入应指明待验证的缺陷。接受以下任一形式：

- `slug=<bug-slug>`、`--slug <bug-slug>`，或单独符合 slug 形式的标记。
- 包含 slug 的路径（例如 `.specify/bugs/login-timeout/`）。
- **无输入**：回退到上下文（见下文）。

## 解析 slug

按以下顺序解析 `BUG_SLUG`，找到首个匹配项即停止：

1. **用户显式输入**：通过 `$ARGUMENTS` 传入的 slug（上述任一形式）。
2. **对话上下文**：如果当前会话刚运行过 `/speckit.bug.assess` 或 `/speckit.bug.fix`，则使用其报告的 slug，无需再次询问。检查 `.specify/bugs/<slug>/fix.md` 是否存在以确认；若不存在，继续下一项。
3. **磁盘上只有一个候选项**：列出 `.specify/bugs/*/fix.md`。如果只有一个缺陷包含 `fix.md`，使用该缺陷。
4. **消除歧义**：
   - **交互模式**：列出候选项，并询问用户要验证哪个缺陷。
   - **自动化模式**：停止并报错，列出候选项。不得猜测。

解析完成后，设置 `BUG_SLUG` 和 `BUG_DIR = .specify/bugs/<BUG_SLUG>`，并在回复中简述采用的解析方式（显式输入 / 来自上下文 / 唯一候选项 / 询问用户）。

## 前置条件

- `BUG_DIR/assessment.md` 必须存在。
- `BUG_DIR/fix.md` 必须存在。若不存在，停止并告知用户先运行 `/speckit.bug.fix`。
- 如果 `BUG_DIR/test.md` 已存在，交互模式下询问用户是否覆盖；自动化模式下拒绝覆盖。
- 完整阅读 `assessment.md` 和 `fix.md`，了解：
  - 原始症状和复现步骤（来自 `assessment.md`）。
  - 实际代码改动和新增测试（来自 `fix.md`）。

## 执行前检查

此时已解析 `BUG_SLUG` 和 `BUG_DIR`，本会话中运行的钩子命令可以从对话中复用它们；不会自动向钩子传递任何内容。

**检查扩展钩子（缺陷验证前）**：
- 检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果存在，读取并查找 `hooks.before_bug_test` 键下的条目。
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

1. **规划验证**
   - 确定哪些检查能证明缺陷已消除：
     - 重新执行评估中的复现步骤（或等效的自动化检查）。
     - 运行修复中新增或更新的测试。
     - 运行涉及改动文件的更广泛的回归测试套件。
   - 确定哪些检查能证明没有破坏其他行为：
     - 改动模块的现有测试套件。
     - 如果项目使用代码风格检查 / 类型检查，也应执行。

2. **运行检查**
   - 执行每项计划中的检查。记录命令、退出状态及相关输出的简短摘录（最后几行或失败的断言）。
   - 如果检查有破坏性、依赖网络或成本高，跳过并记录为 `skipped`，说明原因；未经用户明确同意不得运行。
   - 如果完全无法运行某项检查（缺少工具、未配置测试框架），记录为 `not-run` 并说明原因，不得编造结果。

3. **判断结果**
   - 将修复标记为：
     - **verified**：所有关键检查通过，且原始症状不再复现。
     - **partial**：原始症状已消失，但出现了无关的回归问题，或部分检查无法得出结论。
     - **failed**：症状仍可复现，或修复导致回归测试套件失败。
   - 不得夸大结果。如果未实际执行复现（例如缺陷需要生产环境），必须明确说明。

4. **写入验证报告**

   使用以下结构写入 `BUG_DIR/test.md`：

   ```markdown
   # 缺陷验证: <简短标题>

   - **Slug**: <BUG_SLUG>
   - **Tested**: <ISO 8601 日期>
   - **Assessment**: ./assessment.md
   - **Fix**: ./fix.md
   - **Result**: verified | partial | failed

   ## 摘要

   <用一两句话说明：缺陷是否仍可复现、修复是否有效、是否发现回归问题。>

   ## 已执行的检查

   | 检查 | 命令 / 操作 | 结果 | 备注 |
   |-------|------------------|--------|-------|
   | 复现（修复后） | <命令或人工步骤> | pass / fail / skipped / not-run | <简短备注> |
   | 新增 / 更新的测试 | `<command>` | pass / fail | <简短备注> |
   | 回归测试套件 | `<command>` | pass / fail / skipped | <简短备注> |
   | 代码风格检查 / 类型检查 | `<command>` | pass / fail / skipped | <简短备注> |

   ## 输出摘录

   <相关输出的简短片段，例如测试运行的最终摘要行或失败的断言。保持简洁，不粘贴完整日志。>

   ## 剩余风险

   - <已知限制、未覆盖的环境等>

   ## 建议

   <一段文字。示例：>
   - “关闭缺陷，已完成端到端验证。”
   - “暂缓，复现结果尚无定论，需要在预发布环境中验证。”
   - “重新打开缺陷，症状仍可复现；重新运行 `/speckit.bug.assess`。”
   ```

## 必须完成的执行后钩子检查

**向用户报告完成前，必须完成本节。**

此时已解析 `BUG_SLUG` 和 `BUG_DIR`，且报告已写入，本会话中运行的钩子命令可以从对话中复用它们；不会自动向钩子传递任何内容。

检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果不存在，或 `hooks.after_bug_test` 下未注册钩子，跳转至完成报告。
- 如果存在，读取并查找 `hooks.after_bug_test` 键下的条目。
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

- slug 及 `BUG_DIR/test.md` 路径。
- 结果（`verified`、`partial`、`failed`）。
- 如果结果为 `failed`，建议携带 `test.md` 中记录的新证据重新运行 `/speckit.bug.assess`。

## 安全约束

- 此命令不得修改源代码。它只运行检查，并在 `.specify/bugs/<slug>/` 内写入文件。
- 未经确认，绝不覆盖已有的 `test.md`。
- 如果原始评估列出了复现步骤，而你未实际执行，绝不能仅凭测试就将修复标记为 `verified`；应降级为 `partial` 并说明原因。
