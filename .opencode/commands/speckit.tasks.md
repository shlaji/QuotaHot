---
description: 根据可用的设计产物，为功能生成可执行且按依赖排序的 tasks.md。
handoffs:
  - label: 分析一致性
    agent: speckit.analyze
    prompt: 运行项目一致性分析
    send: true
  - label: 实施项目
    agent: speckit.implement
    prompt: 开始分阶段实施
    send: true
---

## 用户输入

```text
$ARGUMENTS
```

继续之前，你**必须**考虑用户输入（如果不为空）。

## 执行前检查

**检查扩展钩子（生成任务之前）**：
- 检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果存在，读取该文件并查找 `hooks.before_tasks` 键下的条目。
- 如果 YAML 无法解析或无效，不得静默跳过：告知用户无法读取 `.specify/extensions.yml`（包含解析器错误），且未检查任何钩子，包括其中注册的所有强制钩子（`optional: false`），然后正常继续。
- 过滤掉 `enabled` 明确为 `false` 的钩子。没有 `enabled` 字段的钩子默认视为已启用。
- 对于每个剩余钩子，**不要**尝试解释或求值其 `condition` 表达式：
  - 如果钩子没有 `condition` 字段，或者该字段为 null 或空，视为可执行。
  - 如果钩子定义了非空的 `condition`，跳过该钩子，将条件求值交给 HookExecutor 实现处理。
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
  - **强制钩子**（`optional: false`）：
    ```
    ## Extension Hooks

    **Automatic Pre-Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}

    等待钩子命令返回结果，然后再进入执行概要。
    ```
    输出上述内容后，你必须实际调用该钩子，并等待它完成后再继续。调用方式应与你在当前代理或会话中自行运行该命令时一致（调用形式可能与上面显示的 `{command}` 字面 ID 不同，例如技能模式代理会使用 `/skill:speckit-...` 或 `$speckit-...`）。仅输出上述内容不会运行钩子。
- 如果没有注册钩子，或 `.specify/extensions.yml` 不存在，静默跳过。

## 执行概要

1. **初始化**：在仓库根目录运行 `python3 .specify/scripts/python/setup_tasks.py --json`，并解析 FEATURE_DIR、TASKS_TEMPLATE_CONTENT、TASKS_TEMPLATE 和 AVAILABLE_DOCS 列表。提供 `FEATURE_DIR` 和 `TASKS_TEMPLATE` 时，它们必须为绝对路径。`AVAILABLE_DOCS` 是 `FEATURE_DIR` 下可用文档名称或相对路径的列表（例如 `research.md` 或 `contracts/`）。对于参数中的单引号，例如 "I'm Groot"，使用转义语法，如 'I'\''m Groot'（如果可行，也可以使用双引号："I'm Groot"）。

2. **加载设计文档**：从 FEATURE_DIR 读取：
   - **必需**：plan.md（技术栈、库、结构）、spec.md（带优先级的用户故事）。
   - **可选**：data-model.md（实体）、contracts/（接口契约）、research.md（决策）、quickstart.md（测试场景）。
   - **如果存在**：加载 `.specify/memory/constitution.md`，了解项目原则和治理约束。
   - 注意：并非所有项目都具备全部文档。根据可用文档生成任务。

3. **执行任务生成流程**：
   - 加载 plan.md，提取技术栈、库和项目结构。
   - 加载 spec.md，提取用户故事及其优先级（P1、P2、P3 等）。
   - 如果 data-model.md 存在：提取实体并映射到用户故事。
   - 如果 contracts/ 存在：将接口契约映射到用户故事。
   - 如果 research.md 存在：提取用于初始化任务的决策。
   - 按用户故事组织并生成任务（参见下文“任务生成规则”）。
   - 生成依赖关系图，展示用户故事的完成顺序。
   - 为每个用户故事创建并行执行示例。
   - 验证任务完整性（每个用户故事都具备全部所需任务，且可独立测试）。

4. **生成 tasks.md**：使用 TASKS_TEMPLATE_CONTENT（来自上述 JSON 输出）作为结构。为兼容未提供 TASKS_TEMPLATE_CONTENT 的旧版初始化脚本，改为读取 TASKS_TEMPLATE。填入以下内容：
   - plan.md 中的正确功能名称。
   - 阶段 1：初始化任务（项目初始化）。
   - 阶段 2：基础任务（所有用户故事必须先完成的阻塞性前置任务）。
   - 阶段 3 及之后：每个用户故事一个阶段（按照 spec.md 中的优先级排序）。
   - 每个阶段包含：故事目标、独立测试标准、测试（如果要求）、实施任务。
   - 最终阶段：完善与横切关注点。
   - 所有任务必须严格遵循检查清单格式（参见下文“任务生成规则”）。
   - 每个任务的明确文件路径。
   - 展示故事完成顺序的依赖关系章节。
   - 每个故事的并行执行示例。
   - 实施策略章节（MVP 优先、增量交付）。

## 强制执行后钩子

**向用户报告完成之前，你必须完成本节。**

检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果不存在，或 `hooks.after_tasks` 下没有注册钩子，跳至完成报告。
- 如果存在，读取该文件并查找 `hooks.after_tasks` 键下的条目。
- 如果 YAML 无法解析或无效，不得静默跳过：告知用户无法读取 `.specify/extensions.yml`（包含解析器错误），且未检查任何钩子，包括其中注册的所有强制钩子（`optional: false`），然后继续进入完成报告。
- 过滤掉 `enabled` 明确为 `false` 的钩子。没有 `enabled` 字段的钩子默认视为已启用。
- 对于每个剩余钩子，**不要**尝试解释或求值其 `condition` 表达式：
  - 如果钩子没有 `condition` 字段，或者该字段为 null 或空，视为可执行。
  - 如果钩子定义了非空的 `condition`，跳过该钩子，将条件求值交给 HookExecutor 实现处理。
- 对于每个可执行钩子，根据其 `optional` 标志输出以下内容：
  - **强制钩子**（`optional: false`）：**你必须为每个强制钩子输出 `EXECUTE_COMMAND:`**：
    ```
    ## Extension Hooks

    **Automatic Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}
    ```
    输出上述内容后，你必须实际调用该钩子，并等待它完成后再继续。调用方式应与你在当前代理或会话中自行运行该命令时一致（调用形式可能与上面显示的 `{command}` 字面 ID 不同，例如技能模式代理会使用 `/skill:speckit-...` 或 `$speckit-...`）。仅输出上述内容不会运行钩子。
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

输出生成的 tasks.md 的路径及摘要：
- 任务总数。
- 每个用户故事的任务数。
- 识别出的可并行执行部分。
- 每个故事的独立测试标准。
- 建议的 MVP 范围（通常仅包含用户故事 1）。
- 格式验证：确认所有任务均遵循检查清单格式（复选框、ID、标签、文件路径）。

任务生成上下文：$ARGUMENTS

tasks.md 应当可以立即执行，每个任务都必须足够具体，让 LLM 无需额外上下文即可完成。

## 任务生成规则

**关键要求**：任务必须按用户故事组织，以便独立实施和测试。

**测试是可选的**：仅在功能规格明确要求，或用户要求采用 TDD 方法时，才生成测试任务。

### 检查清单格式（必需）

每个任务都必须严格遵循以下格式：

```text
- [ ] [TaskID] [P?] [Story?] Description with file path
```

**格式组成**：

1. **复选框**：始终以 `- [ ]` 开头（Markdown 复选框）。
2. **任务 ID**：按执行顺序连续编号（T001、T002、T003...）。
3. **[P] 标记**：仅在任务可并行执行时添加（涉及不同文件，且不依赖未完成的任务）。
4. **[Story] 标签**：仅用户故事阶段的任务必须添加。
   - 格式：[US1]、[US2]、[US3] 等（对应 spec.md 中的用户故事）。
   - 初始化阶段：不添加故事标签。
   - 基础阶段：不添加故事标签。
   - 用户故事阶段：必须添加故事标签。
   - 完善阶段：不添加故事标签。
5. **描述**：明确说明操作，并包含准确的文件路径。

**示例**：

- ✅ 正确：`- [ ] T001 Create project structure per implementation plan`
- ✅ 正确：`- [ ] T005 [P] Implement authentication middleware in src/middleware/auth.py`
- ✅ 正确：`- [ ] T012 [P] [US1] Create User model in src/models/user.py`
- ✅ 正确：`- [ ] T014 [US1] Implement UserService in src/services/user_service.py`
- ❌ 错误：`- [ ] Create User model`（缺少 ID 和 Story 标签）
- ❌ 错误：`T001 [US1] Create model`（缺少复选框）
- ❌ 错误：`- [ ] [US1] Create User model`（缺少任务 ID）
- ❌ 错误：`- [ ] T001 [US1] Create model`（缺少文件路径）

### 任务组织

1. **依据用户故事（spec.md）**，这是主要组织方式：
   - 每个用户故事（P1、P2、P3...）各设一个阶段。
   - 将所有相关组件映射到各自的故事：
     - 该故事所需的模型。
     - 该故事所需的服务。
     - 该故事所需的接口或 UI。
     - 如果要求测试：该故事专属的测试。
   - 标明故事之间的依赖关系（大多数故事应当相互独立）。

2. **依据契约**：
   - 将每个接口契约映射到它所服务的用户故事。
   - 如果要求测试：为每个接口契约生成带 [P] 标记的契约测试任务，放在对应故事阶段的实施任务之前。

3. **依据数据模型**：
   - 将每个实体映射到需要它的一个或多个用户故事。
   - 如果实体服务于多个故事：放入最早的故事阶段或初始化阶段。
   - 将关系转为对应故事阶段中的服务层任务。
   - 对于 data-model.md 中每个带约束的字段（最大长度、可空或必填、枚举值、校验规则），在任务描述中逐字引用约束，避免留到实施时自行决定。

4. **依据初始化或基础设施**：
   - 共享基础设施 → 初始化阶段（阶段 1）。
   - 基础性或阻塞性任务 → 基础阶段（阶段 2）。
   - 故事专属的初始化工作 → 对应故事的阶段内。

### 阶段结构

- **阶段 1**：初始化（项目初始化）。
- **阶段 2**：基础工作（阻塞性前置任务，必须在用户故事之前完成）。
- **阶段 3 及之后**：按优先级排列的用户故事（P1、P2、P3...）。
  - 每个故事内部：测试（如果要求）→ 模型 → 服务 → 端点 → 集成。
  - 每个阶段应当是完整且可独立测试的增量。
- **最终阶段**：完善与横切关注点。

## 完成条件

- [ ] 已生成 tasks.md，包含所有阶段、任务 ID 和文件路径
- [ ] 已按照上文“强制执行后钩子”中的规则分派或跳过扩展钩子
- [ ] 已向用户报告完成，包含任务数、按故事划分的明细和 MVP 范围
