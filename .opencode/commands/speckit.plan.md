---
description: 使用计划模板执行实施规划流程，生成设计产物。
handoffs:
  - label: 创建任务
    agent: speckit.tasks
    prompt: 将计划拆分为任务
    send: true
  - label: 创建检查清单
    agent: speckit.checklist
    prompt: 为以下领域创建检查清单...
---

## 用户输入

```text
$ARGUMENTS
```

继续之前，你**必须**考虑用户输入（如果非空）。

## 执行前检查

**检查扩展钩子（规划之前）**：
- 检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果存在，读取该文件并查找 `hooks.before_plan` 键下的条目。
- 如果 YAML 无法解析或格式无效，不得静默跳过：告知用户无法读取 `.specify/extensions.yml`（附上解析器错误），且未检查任何钩子，包括其中注册的所有必选钩子（`optional: false`），然后正常继续。
- 筛除 `enabled` 被显式设为 `false` 的钩子。没有 `enabled` 字段的钩子默认视为已启用。
- 对于剩余的每个钩子，**不要**尝试解释或求值其 `condition` 表达式：
  - 如果钩子没有 `condition` 字段，或该字段为 null/空值，将其视为可执行钩子。
  - 如果钩子定义了非空的 `condition`，跳过该钩子，将条件求值留给 HookExecutor 实现处理。
- 对于每个可执行钩子，根据其 `optional` 标志输出以下内容：
  - **可选钩子**（`optional: true`）：
    ```
    ## Extension Hooks

    **Optional Pre-Hook**: {extension}
    Command: `/{command}`
    Description: {description}

    Prompt: {prompt}
    To execute: `/{command}`
    ```
  - **必选钩子**（`optional: false`）：
    ```
    ## Extension Hooks

    **Automatic Pre-Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}

    等待钩子命令返回结果后，再继续执行概要部分。
    ```
    输出上述内容块后，你必须实际调用钩子，等待其完成后才能继续。调用方式应与你在当前代理/会话中自行运行该命令时一致（实际调用形式可能不同于上面显示的 `{command}` 字面标识符，例如技能模式代理使用 `/skill:speckit-...` 或 `$speckit-...`）。仅输出内容块并不会运行钩子。
- 如果没有注册钩子，或 `.specify/extensions.yml` 不存在，则静默跳过。

## 执行概要

1. **初始化**：在仓库根目录运行 `python3 .specify/scripts/python/setup_plan.py --json`，解析 JSON 中的 FEATURE_SPEC、IMPL_PLAN、FEATURE_DIR、BRANCH。参数中包含单引号时，例如 "I'm Groot"，使用转义语法：如 'I'\''m Groot'（也可在允许时使用双引号："I'm Groot"）。

2. **加载上下文**：读取 FEATURE_SPEC 和 `.specify/memory/constitution.md`。加载 IMPL_PLAN 模板（已复制）。

3. **执行规划流程**：按照 IMPL_PLAN 模板的结构完成以下工作：
   - 填写 Technical Context，将未知项标记为 "NEEDS CLARIFICATION"。
   - 根据项目章程填写 Constitution Check 部分。
   - 评估门禁条件，若存在无法合理解释的违规项则报错（ERROR）。
   - 阶段 0：生成 research.md，解决所有 NEEDS CLARIFICATION。
   - 阶段 1：生成 data-model.md、contracts/、quickstart.md。
   - 设计完成后重新评估 Constitution Check。

## 必须检查的执行后钩子

**向用户报告完成之前，你必须完成本节。**

检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果不存在，或 `hooks.after_plan` 下没有注册钩子，跳至完成报告。
- 如果存在，读取该文件并查找 `hooks.after_plan` 键下的条目。
- 如果 YAML 无法解析或格式无效，不得静默跳过：告知用户无法读取 `.specify/extensions.yml`（附上解析器错误），且未检查任何钩子，包括其中注册的所有必选钩子（`optional: false`），然后继续生成完成报告。
- 筛除 `enabled` 被显式设为 `false` 的钩子。没有 `enabled` 字段的钩子默认视为已启用。
- 对于剩余的每个钩子，**不要**尝试解释或求值其 `condition` 表达式：
  - 如果钩子没有 `condition` 字段，或该字段为 null/空值，将其视为可执行钩子。
  - 如果钩子定义了非空的 `condition`，跳过该钩子，将条件求值留给 HookExecutor 实现处理。
- 对于每个可执行钩子，根据其 `optional` 标志输出以下内容：
  - **必选钩子**（`optional: false`），**你必须为每个必选钩子输出 `EXECUTE_COMMAND:`**：
    ```
    ## Extension Hooks

    **Automatic Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}
    ```
    输出上述内容块后，你必须实际调用钩子，等待其完成后才能继续。调用方式应与你在当前代理/会话中自行运行该命令时一致（实际调用形式可能不同于上面显示的 `{command}` 字面标识符，例如技能模式代理使用 `/skill:speckit-...` 或 `$speckit-...`）。仅输出内容块并不会运行钩子。
  - **可选钩子**（`optional: true`）：
    ```
    ## Extension Hooks

    **Optional Hook**: {extension}
    Command: `/{command}`
    Description: {description}

    Prompt: {prompt}
    To execute: `/{command}`
    ```

## 完成报告

命令在阶段 1 设计完成后结束。报告分支、IMPL_PLAN 路径以及生成的产物。

## 阶段

### 阶段 0：概要与研究

1. **从上面的 Technical Context 中提取未知项**：
   - 每个 NEEDS CLARIFICATION → 研究任务。
   - 每个依赖项 → 最佳实践任务。
   - 每个集成点 → 模式研究任务。

2. **创建并派发研究代理**：

   ```text
   For each unknown in Technical Context:
     Task: "Research {unknown} for {feature context}"
   For each technology choice:
     Task: "Find best practices for {tech} in {domain}"
   ```

3. 在 `research.md` 中**汇总研究结果**，使用以下格式：
   - Decision: [what was chosen]
   - Rationale: [why chosen]
   - Alternatives considered: [what else evaluated]

**输出**：research.md，其中所有 NEEDS CLARIFICATION 均已解决。

### 阶段 1：设计与契约

**前置条件：** `research.md` 已完成。

1. **从功能规格中提取实体** → `data-model.md`：
   - 实体名称、字段和关系。
   - 需求中规定的校验规则。
   - 状态转换（如适用）。

2. **定义接口契约**（如果项目有外部接口）→ `/contracts/`：
   - 明确项目向用户或其他系统暴露哪些接口。
   - 采用适合项目类型的契约格式编写文档。
   - 示例：库的公共 API、CLI 工具的命令模式、Web 服务的端点、解析器的文法、应用程序的 UI 契约。
   - 如果项目仅供内部使用（构建脚本、一次性工具等），则跳过。

3. **创建快速入门验证指南** → `quickstart.md`：
   - 记录可运行的验证场景，证明功能端到端正常工作。
   - 包含前置条件、初始化命令、测试/运行命令以及预期结果。
   - 通过链接或引用指向契约和数据模型的详细内容，不要重复编写。
   - 不得包含完整实现代码、模型/服务/控制器的实现体、迁移代码或完整测试套件。
   - 此产物应仅作为验证/运行指南；实现细节应放在 `tasks.md` 中，并留到实施阶段处理。

**输出**：data-model.md、/contracts/*、quickstart.md。

## 关键规则

- 文件系统操作使用绝对路径；文档中的引用使用项目相对路径。
- 门禁检查失败或仍有未解决的澄清项时，必须报错（ERROR）。

## 完成条件

- [ ] 已执行规划流程并生成设计产物。
- [ ] 已按上方“必须检查的执行后钩子”中的规则派发或跳过扩展钩子。
- [ ] 已向用户报告完成，包含分支、计划路径和生成的产物。
