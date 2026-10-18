---
description: 对照功能的规格、计划和任务评估当前代码库，将尚未实现的工作作为新任务追加到 tasks.md，供 implement 完成。
---

## 用户输入

```text
$ARGUMENTS
```

继续之前，**必须**考虑用户输入（如果非空）。

## 执行前检查

**检查扩展钩子（收敛前）**：

- 检查项目根目录是否存在 `.specify/extensions.yml`。
- 如果存在，读取文件并查找 `hooks.before_converge` 键下的条目。
- 如果 YAML 无法解析或无效，不得静默跳过：告知用户无法读取 `.specify/extensions.yml`（附上解析器错误），并说明未检查任何钩子，包括其中注册的强制钩子（`optional: false`），然后正常继续。
- 过滤掉 `enabled` 明确为 `false` 的钩子。未设置 `enabled` 字段的钩子默认视为启用。
- 对每个剩余钩子，**不要**尝试解释或求值其 `condition` 表达式：
  - 如果钩子没有 `condition` 字段，或该字段为 null 或空，则视为可执行。
  - 如果钩子定义了非空的 `condition`，则跳过该钩子，将条件求值交给 HookExecutor 实现。
- 对每个可执行钩子，根据其 `optional` 标志输出以下内容：
  - **可选钩子**（`optional: true`）：

    ```text
    ## Extension Hooks

    **Optional Pre-Hook**: {extension}
    Command: `/{command}`
    Description: {description}

    Prompt: {prompt}
    To execute: `/{command}`
    ```

  - **强制钩子**（`optional: false`）：

    ```text
    ## Extension Hooks

    **Automatic Pre-Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}

    等待钩子命令返回结果后，再进入目标部分。
    ```
    输出上述内容块后，必须实际调用该钩子并等待其完成，才能继续。调用方式应与在当前代理或会话中直接运行该命令时一致（调用形式可能与上方显示的 `{command}` 标识符字面值不同，例如技能模式的代理会使用 `/skill:speckit-...` 或 `$speckit-...`）。仅输出内容块并不会运行钩子。

- 如果未注册任何钩子，或 `.specify/extensions.yml` 不存在，则静默跳过。

## 目标

消除功能规格、计划和任务所要求的内容与代码库当前实现之间的差距。将 `spec.md`、
`plan.md` 和 `tasks.md` 作为**意图的唯一来源**（以项目宪章作为约束），评估代码现状，
确定哪些需求、验收标准、计划决策和现有任务尚未满足、尚未完成或仅部分满足，
并在 `tasks.md` 底部**将每项剩余工作追加为可追溯的新任务**，供 `/speckit.implement` 完成。
只有在 `/speckit.tasks` 已生成完整的 `tasks.md`，且 `/speckit.implement` 已针对当前
`tasks.md` 运行之后，才允许运行此命令。

这**不是**差异比较工具，也**不**跟踪变更。它根据功能产物评估代码当前的状态，
不使用 git，不比较分支，也不查看历史。

## 操作约束

**只追加，绝不重写**：此命令**唯一**允许的写入操作是在 `tasks.md` 中追加一个新的
`## Phase N: Convergence` 章节。严禁：

- 以任何方式修改 `spec.md` 或 `plan.md`；
- 重写、重新编号、重新排序或删除任何现有任务（包括此前收敛阶段的任务）；
- 修改、创建或删除任何应用代码。追加任务的实现由 `/speckit.implement` 负责。

当代码库已经满足全部要求时，此命令必须让 `tasks.md` **逐字节保持不变**
（不得添加空的收敛阶段标题），并报告无差距的结果。

**宪章的权威性**：项目宪章（`.specify/memory/constitution.md`）**不可违背**。
违反 MUST 原则的代码应列为最高严重级别的问题，并生成相应的整改任务。
如果宪章仍是未填写的模板，则直接跳过宪章检查，不要因此报错终止。

## 执行步骤

### 1. 初始化收敛上下文

在仓库根目录运行一次 `python3 .specify/scripts/python/check_prerequisites.py --json --require-spec --require-tasks --include-tasks`，从 JSON 中解析 FEATURE_DIR 和 AVAILABLE_DOCS。推导以下绝对路径：

- SPEC = FEATURE_DIR/spec.md
- PLAN = FEATURE_DIR/plan.md
- TASKS = FEATURE_DIR/tasks.md
- CONSTITUTION = `.specify/memory/constitution.md`（如果存在）
如果缺少 `spec.md`、`plan.md` 或 `tasks.md`，则停止执行，并给出清晰、可操作的提示，
指出需要先运行的命令（缺少规格时运行 `/speckit.specify`，缺少计划时运行 `/speckit.plan`，
缺少任务时运行 `/speckit.tasks`）。不要输出不完整的结果。
参数中包含单引号时，例如 "I'm Groot"，请使用转义语法，如 'I'\''m Groot'（也可在允许的情况下使用双引号："I'm Groot"）。

### 2. 加载产物（渐进式读取）

仅从各产物中加载必要的最少上下文：

**从 spec.md 读取：**

- 功能需求（FR-###）
- 成功标准（SC-###），仅纳入需要具体实现工作的条目，排除上线后的成效指标和业务 KPI
- 用户故事及其验收场景
- 边界情况（如果存在）

**从 plan.md 读取：**

- 架构、技术栈选择及技术决策
- 数据模型引用
- 各阶段及明确列出的涉及位置（计划中将创建或编辑的文件、组件）
- 技术约束

**从 tasks.md 读取：**

- 任务 ID（用于计算下一个 ID 和下一个阶段编号）
- 描述、阶段分组及引用的文件路径

**从宪章读取（如果不是未填写的模板）：**

- 原则名称及 MUST/SHOULD 规范性声明

### 3. 建立意图清单

建立内部模型（不要原样输出产物内容）：

- **需求清单**：为每个 FR-###、SC-### 和用户故事验收场景（如 `US1/AC2`）设置稳定的键，
  并纳入提出具体实现义务的计划决策和宪章原则。
- **代码范围映射**：根据 `plan.md` 和 `tasks.md` 中列出的文件路径，结合对各需求所述概念的
  关键词搜索，确定评估范围内的源文件和组件集合。评估必须限定在此范围内，
  **不得**推断出产物定义以外的范围。

### 4. 评估代码库并对问题分类

将每个现有任务纳入意图清单，不论其复选框状态或所属收敛阶段如何：声称已完成不等于证据。
对照规格、计划、任务和宪章核实现有行为；对于一系列纠正任务，应评估其最终行为，
而不是已被取代的实现细节。既要检查尚未履行的义务，也要检查与既定意图矛盾、
超出或偏离既定意图的实现。

对意图清单中的每个条目，检查范围内的当前代码，仅在存在差距时生成 `Finding`。
按**差距类型**对每个问题分类：

- **`missing`**：代码中完全没有所要求的实现。
- **`partial`**：已有实现，但尚未完全满足需求、验收标准或计划决策。
- **`contradicts`**：代码行为与既定意图或宪章的 MUST 原则冲突。
- **`unrequested`**：代码包含规格、计划或任务未要求的工作
  （列出以供知悉；converge **不会**删除代码，只会追加任务，要求审查其合理性、说明理由或移除该实现）。

每个 `Finding` 记录：稳定的 id、可追溯的 `source-ref`、`gap-type`、严重级别，
以及附带证据（所检查的文件或区域）的简短易读描述。

**边界情况：**

- **代码很少或尚无代码**：将全部规定范围视为 `missing` 的剩余工作，不要因此报错终止。
- **没有剩余工作**：不生成任何问题，按第 7 步的已收敛分支处理。

### 5. 确定严重级别

- **CRITICAL**：违反宪章 MUST 原则，或存在阻碍 P1 用户故事基本功能的 `missing`/`contradicts` 差距。
- **HIGH**：核心功能需求或验收标准存在 `missing` 或 `partial` 差距。
- **MEDIUM**：次要需求存在 `partial` 差距，或存在合理性不明确的 `unrequested` 新增实现。
- **LOW**：轻微的部分实现差距、完善细节或低风险的 `unrequested` 新增实现。

### 6. 在当前会话中展示问题摘要

追加任何内容之前，先输出简明的、按严重级别分级的摘要（此时尚不写入文件）：

## Convergence Findings

| ID | Gap Type | Severity | Source | Evidence | Remaining Work |
|----|----------|----------|--------|----------|----------------|
| F1 | missing  | HIGH     | FR-008 | Example: no append-only guard detected in path/to/module.py when writing tasks.md | Add append-only enforcement |

**汇总指标：**

- 已检查的需求和验收标准数量
- 已检查的计划决策数量
- 已检查的宪章原则数量（或标注“已跳过：模板”）
- 按差距类型统计的问题数量（missing / partial / contradicts / unrequested）
- 按严重级别统计的问题数量

### 7. 追加收敛任务（或报告已收敛）

**如果存在一个或多个可执行的问题**（结果为 `tasks_appended`）：

按追加约定，将内容追加到 `tasks.md` 的**末尾**：

1. 扫描所有现有任务 ID，以 `M` 表示最大值。确定下一个阶段编号 `N`
   （现有最大阶段编号 + 1）。
2. 写入一个新章节标题 `## Phase N: Convergence`。
3. 为每个可执行的问题输出一个复选框条目，优先排列 CRITICAL/HIGH 级别的问题，
   并分配补零的 ID：`T{M+1:03d}, T{M+2:03d}, …`：

   ```markdown
   - [ ] T042 <imperative description> per <source-ref> (<gap-type>)
   ```

   `<source-ref>` 用于将任务追溯到其来源，例如 `FR-003`、`SC-002`、
   `US1/AC2`, `plan: storage decision`, `Constitution II`.

   `<gap-type>` 为 `missing`、`partial`、`contradicts`、`unrequested` 之一。

   违反宪章的任务必须最先输出，并标为 `CRITICAL`。
4. 绝不复用现有 ID，也不重新编号。如果已有收敛阶段，在其下方添加独立编号的新阶段，
   不要改动旧阶段。

**如果没有可执行的问题**（结果为 `converged`）：

- **不要**对 `tasks.md` 做任何修改，不得添加空的阶段标题。
- 报告：**"✅ Converged — the implementation satisfies the spec, plan, and tasks."**
- 附上所检查内容的汇总数量。

### 8. 提供后续操作（交接）

- 结果为 `tasks_appended` 时：说明在哪个阶段追加了多少任务，并建议运行
  `/speckit.implement` 完成这些任务；指出再次运行 converge 时，剩余条目会更少或不再存在。
- 结果为 `converged` 时：建议进入评审或创建 PR。对于此功能的规定范围，
  无需再次运行 implement。

### 9. 检查扩展钩子

生成结果后，检查项目根目录是否存在 `.specify/extensions.yml`。

- 如果存在，读取文件并查找 `hooks.after_converge` 键下的条目。
- 如果 YAML 无法解析或无效，不得静默跳过：告知用户无法读取 `.specify/extensions.yml`（附上解析器错误），并说明未检查任何钩子，包括其中注册的强制钩子（`optional: false`），然后正常继续。
- 过滤掉 `enabled` 明确为 `false` 的钩子。未设置 `enabled` 字段的钩子默认视为启用。
- 对每个剩余钩子，**不要**尝试解释或求值其 `condition` 表达式：
  - 如果钩子没有 `condition` 字段，或该字段为 null 或空，则视为可执行。
  - 如果钩子定义了非空的 `condition`，则跳过该钩子，将条件求值交给 HookExecutor 实现。
- 在列出任何钩子之前，先在当前会话中报告收敛结果（`converged` 或 `tasks_appended`），
  以便用户决定是否运行可选的后续命令。
- 对每个可执行钩子，根据其 `optional` 标志输出以下内容：
  - **可选钩子**（`optional: true`）：

    ```text
    ## Extension Hooks

    **Optional Hook**: {extension}
    Command: `/{command}`
    Description: {description}

    Prompt: {prompt}
    To execute: `/{command}`
    ```

  - **强制钩子**（`optional: false`）：

    ```text
    ## Extension Hooks

    **Automatic Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}
    ```
    输出上述内容块后，必须实际调用该钩子并等待其完成，才能继续。调用方式应与在当前代理或会话中直接运行该命令时一致（调用形式可能与上方显示的 `{command}` 标识符字面值不同，例如技能模式的代理会使用 `/skill:speckit-...` 或 `$speckit-...`）。仅输出内容块并不会运行钩子。

- 如果未注册任何钩子，或 `.specify/extensions.yml` 不存在，则静默跳过。
