---
description: 在任务生成后，对 spec.md、plan.md 和 tasks.md 进行非破坏性的跨文档一致性与质量分析。
---

## 用户输入

```text
$ARGUMENTS
```

在继续之前，你**必须**考虑用户输入（如果非空）。

## 执行前检查

**检查扩展钩子（分析前）**：
- 检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果存在，读取该文件并查找 `hooks.before_analyze` 键下的条目。
- 如果 YAML 无法解析或内容无效，不得静默跳过：告知用户无法读取 `.specify/extensions.yml`（包含解析器错误），并说明未检查任何钩子，包括其中注册的所有强制钩子（`optional: false`），然后正常继续。
- 过滤掉 `enabled` 明确为 `false` 的钩子。没有 `enabled` 字段的钩子默认视为启用。
- 对于其余每个钩子，**不要**尝试解释或求值其 `condition` 表达式：
  - 如果钩子没有 `condition` 字段，或该字段为 null/空，则将其视为可执行钩子。
  - 如果钩子定义了非空的 `condition`，则跳过该钩子，将条件求值留给 HookExecutor 实现。
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

    等待钩子命令返回结果后，再进入目标部分。
    ```
    输出上述内容块后，你必须实际调用钩子，等待其执行结束后再继续。使用当前代理/会话中通常执行该命令的方式运行（调用形式可能与上述字面量 `{command}` ID 不同，例如技能模式的代理会使用 `/skill:speckit-...` 或 `$speckit-...`）。仅输出内容块不会执行钩子。
- 如果没有注册钩子，或 `.specify/extensions.yml` 不存在，则静默跳过。

## 目标

在实施前，识别三份核心文档（`spec.md`、`plan.md`、`tasks.md`）之间的不一致、重复、歧义和定义不充分之处。此命令必须仅在 `/speckit.tasks` 成功生成完整的 `tasks.md` 后运行。

## 操作约束

**严格只读**：**不得**修改任何文件。输出结构化分析报告，并提供可选的修正方案（必须获得用户明确批准后，才能手动调用任何后续编辑命令）。

**章程的权威性**：在本次分析范围内，项目章程（`.specify/memory/constitution.md`）**不可违背**。与章程冲突的问题自动定为 CRITICAL，必须调整规范、计划或任务，不得弱化、重新解释或静默忽略相关原则。如果需要修改原则本身，必须在 `/speckit.analyze` 之外单独、明确地更新章程。

## 执行步骤

### 1. 初始化分析上下文

在仓库根目录运行一次 `python3 .specify/scripts/python/check_prerequisites.py --json --require-spec --require-tasks --include-tasks`，解析 JSON 中的 FEATURE_DIR 和 AVAILABLE_DOCS。推导以下绝对路径：

- SPEC = FEATURE_DIR/spec.md
- PLAN = FEATURE_DIR/plan.md
- TASKS = FEATURE_DIR/tasks.md

如果缺少任何必需文件，则输出错误信息并中止（提示用户运行缺失的前置命令）。
对于 "I'm Groot" 这类包含单引号的参数，使用转义语法，例如 'I'\''m Groot'（如果可行，也可以使用双引号："I'm Groot"）。

### 2. 加载文档（渐进式展开）

仅从每份文档中加载最少的必要上下文：

**从 spec.md 加载：**

- 概述/背景
- 功能需求
- 成功标准（可衡量的结果，例如性能、安全性、可用性、用户成功和业务影响）
- 用户故事
- 边界情况（如果存在）

**从 plan.md 加载：**

- 架构/技术栈选择
- 数据模型引用
- 阶段划分
- 技术约束

**从 tasks.md 加载：**

- 任务 ID
- 描述
- 阶段分组
- 并行标记 [P]
- 引用的文件路径

**从章程加载：**

- 加载 `.specify/memory/constitution.md`，用于验证是否符合原则。

### 3. 构建语义模型

建立内部表示（不要在输出中包含原始文档）：

- **需求清单**：为每项功能需求（FR-###）和成功标准（SC-###）记录一个稳定的键。如果存在明确的 FR-/SC- 标识符，将其用作主键；也可以额外生成命令式短语形式的 slug，以便阅读（例如，“用户可以上传文件” → `user-can-upload-file`）。仅纳入需要可实施工作的成功标准（例如负载测试基础设施、安全审计工具），排除上线后的结果指标和业务 KPI（例如“将支持工单减少 50%”）。
- **用户故事/操作清单**：带有验收标准的独立用户操作。
- **任务覆盖映射**：将每项任务映射到一个或多个需求或用户故事（通过关键词或 ID、关键短语等显式引用模式推断）。
- **章程规则集**：提取原则名称及 MUST/SHOULD 规范性陈述。

### 4. 分项检测（节省 token 的分析）

重点关注有价值的发现。发现总数最多为 50 条，其余内容汇总到超限摘要中。

#### A. 重复检测

- 识别近似重复的需求。
- 标记质量较差的表述，以便合并整理。

#### B. 歧义检测

- 标记缺少可衡量标准的模糊形容词（快速、可扩展、安全、直观、稳健）。
- 标记尚未处理的占位符（TODO、TKTK、???、`<placeholder>` 等）。

#### C. 定义不充分

- 有动作动词，但缺少操作对象或可衡量结果的需求。
- 未与验收标准对应的用户故事。
- 引用了规范/计划中未定义的文件或组件的任务。

#### D. 章程一致性

- 任何与 MUST 原则冲突的需求或计划内容。
- 缺少章程强制要求的章节或质量门禁。

#### E. 覆盖缺口

- 没有关联任务的需求。
- 未映射到任何需求/用户故事的任务。
- 需要可实施工作（性能、安全性、可用性），但未体现在任务中的成功标准。

#### F. 不一致

- 术语漂移（同一概念在不同文件中的名称不同）。
- 计划中引用了规范中不存在的数据实体，或反之。
- 任务顺序矛盾（例如集成任务排在基础设置任务之前，且没有依赖说明）。
- 相互冲突的需求（例如一项要求使用 Next.js，另一项却指定 Vue）。

### 5. 确定严重程度

使用以下启发式规则确定发现的优先级：

- **CRITICAL**：违反章程的 MUST 要求、缺少核心规范文档，或某项需求完全没有任务覆盖且阻碍基本功能。
- **HIGH**：需求重复或冲突、安全性/性能属性含糊不清、验收标准无法测试。
- **MEDIUM**：术语漂移、非功能需求缺少任务覆盖、边界情况定义不充分。
- **LOW**：风格/措辞改进、不影响执行顺序的轻微冗余。

### 6. 生成精简分析报告

按以下结构输出 Markdown 报告（不写入文件）：

## Specification Analysis Report

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| A1 | Duplication | HIGH | spec.md:L120-134 | 两项相似的需求…… | 合并表述，保留更清晰的版本 |

（每项发现占一行，生成以类别英文首字母为前缀的稳定 ID。）

**Coverage Summary Table:**

| Requirement Key | Has Task? | Task IDs | Notes |
|-----------------|-----------|----------|-------|

**Constitution Alignment Issues:**（如果存在）

**Unmapped Tasks:**（如果存在）

**Metrics:**

- Total Requirements
- Total Tasks
- Coverage % (requirements with >=1 task)
- Ambiguity Count
- Duplication Count
- Critical Issues Count

### 7. 提供后续行动

在报告末尾输出简洁的 Next Actions 内容块：

- 如果存在 CRITICAL 问题：建议在运行 `/speckit.implement` 前解决。
- 如果只有 LOW/MEDIUM 问题：用户可以继续，但应提供改进建议。
- 提供明确的命令建议，例如“运行 /speckit.specify 细化规范”“运行 /speckit.plan 调整架构”“手动编辑 tasks.md，为 'performance-metrics' 补充覆盖”。

### 8. 提议修正

询问用户：“是否需要我针对优先级最高的 N 个问题提出具体的修正编辑建议？”（不得自动应用这些修改。）

### 9. 检查扩展钩子

报告完成后，检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果存在，读取该文件并查找 `hooks.after_analyze` 键下的条目。
- 如果 YAML 无法解析或内容无效，不得静默跳过：告知用户无法读取 `.specify/extensions.yml`（包含解析器错误），并说明未检查任何钩子，包括其中注册的所有强制钩子（`optional: false`），然后正常继续。
- 过滤掉 `enabled` 明确为 `false` 的钩子。没有 `enabled` 字段的钩子默认视为启用。
- 对于其余每个钩子，**不要**尝试解释或求值其 `condition` 表达式：
  - 如果钩子没有 `condition` 字段，或该字段为 null/空，则将其视为可执行钩子。
  - 如果钩子定义了非空的 `condition`，则跳过该钩子，将条件求值留给 HookExecutor 实现。
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
    输出上述内容块后，你必须实际调用钩子，等待其执行结束后再继续。使用当前代理/会话中通常执行该命令的方式运行（调用形式可能与上述字面量 `{command}` ID 不同，例如技能模式的代理会使用 `/skill:speckit-...` 或 `$speckit-...`）。仅输出内容块不会执行钩子。
- 如果没有注册钩子，或 `.specify/extensions.yml` 不存在，则静默跳过。

## 操作原则

### 上下文效率

- **精简且有效的 token 使用**：聚焦可采取行动的发现，而不是面面俱到的文档。
- **渐进式展开**：逐步加载文档，不要将全部内容直接堆入分析。
- **节省 token 的输出**：发现表最多 50 行，超出部分汇总说明。
- **确定性结果**：未做更改时重新运行，应产生一致的 ID 和计数。

### 分析准则

- **绝不修改文件**（这是只读分析）。
- **绝不臆造缺失章节**（如果不存在，如实报告）。
- **优先处理违反章程的问题**（这类问题始终为 CRITICAL）。
- **优先引用实例，而非罗列穷尽规则**（引用具体实例，而不是泛泛的模式）。
- **妥善报告零问题的情况**（输出包含覆盖统计的成功报告）。

## 上下文

$ARGUMENTS
