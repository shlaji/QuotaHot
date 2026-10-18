---
description: 根据交互式输入或已提供的原则创建或更新项目章程。
handoffs:
  - label: 编写规格说明
    agent: speckit.specify
    prompt: 根据更新后的章程编写功能规格说明。我想构建...
---

## 用户输入

```text
$ARGUMENTS
```

继续之前，你**必须**考虑用户输入（如果非空）。

## 范围约束

本命令的工作仅限于更新项目章程本身。依赖章程的模板和命令会在运行时读取章程，
不在此处修改。

- 将用户输入的每一部分归类为章程内容，或独立的非治理意图。
- 如果输入包含功能实现、代码生成、重构、构建或部署请求，你**不得**执行这些请求，
  而应将其提取为暂缓处理的意图。
- 你**不得**创建、修改或删除应用源文件、功能路由、组件、测试、部署文件，
  或任何与章程工作流无关的产物。
- 如果无法确定某条指令是否属于章程内容，必须先请求澄清，再进行修改。
- 完成章程更新后，在 `Next Actions` 章节中列出每项暂缓处理的意图。
  列出原始意图，并建议适当的后续 Spec Kit 命令，例如 `/speckit.specify`，但不要调用它。
- 如果没有非治理意图，则省略 `Next Actions` 章节。

## 执行前检查

**检查扩展钩子（更新章程之前）**：
- 检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果存在，读取该文件并查找 `hooks.before_constitution` 键下的条目。
- 如果 YAML 无法解析或内容无效，不得静默跳过：告知用户无法读取 `.specify/extensions.yml`（附上解析器错误），且未检查任何钩子，包括其中注册的强制钩子（`optional: false`），然后正常继续。
- 排除 `enabled` 明确为 `false` 的钩子。没有 `enabled` 字段的钩子默认视为已启用。
- 对于其余每个钩子，**不要**尝试解释或求值钩子的 `condition` 表达式：
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

    等待钩子命令返回结果后，再继续执行概要中的步骤。
    ```
    输出上述内容后，你必须实际调用钩子，并等待其完成后才能继续。调用方式应与你在当前代理或会话中自行执行该命令时一致（实际调用形式可能与上面显示的 `{command}` 字面标识不同，例如技能模式下的代理会使用 `/skill:speckit-...` 或 `$speckit-...`）。仅输出上述内容并不会执行钩子。
- 如果没有注册钩子，或 `.specify/extensions.yml` 不存在，则静默跳过。

## 执行概要

你正在更新 `.specify/memory/constitution.md` 中的项目章程。命令执行时，
通过 Spec Kit 的预设与模板解析栈，从 `constitution-template` 解析出当前生效的章程骨架。

按以下流程执行：

1. 在仓库根目录运行 `python3 .specify/scripts/python/resolve_template.py constitution-template --json`，将 `TEMPLATE_CONTENT` 解析为当前生效的模板。
   - 共享解析器会先应用项目覆盖项、参与组合的预设层和扩展层，最后才回退到核心模板。
     解析必须成功后才能继续。
   - 如果解析失败，停止并报告解析错误；不得仅使用参与组合的某一个模板层继续执行。
   - 如果 `.specify/memory/constitution.md` 已存在，加载该文件，作为当前项目特定值和修订内容的来源。
     应用新解析出的骨架时，保留仍然适用的信息。
   - 如果文件不存在，使用解析出的模板作为初始文档。
   - 不要回写任何纳入版本控制的模板层。
   - 识别所有形式为 `[ALL_CAPS_IDENTIFIER]` 的占位符标记。
   **重要**：用户要求的原则数量可能少于或多于模板中的数量。如果指定了数量，应遵从该要求，同时沿用模板的总体结构，并据此更新文档。

2. 收集或推导占位符的值：
   - 如果用户输入（对话）提供了值，则使用该值。
   - 否则，根据仓库现有上下文推断（README、文档，以及其中包含的历史章程版本）。
   - 治理日期：`RATIFICATION_DATE` 是最初通过章程的日期（未知时询问用户或标记 TODO）；如有修改，`LAST_AMENDED_DATE` 设为今天，否则保留原值。
   - `CONSTITUTION_VERSION` 必须按语义化版本规则递增：
     - MAJOR：删除或重新定义治理规则或原则，造成不向后兼容的变化。
     - MINOR：新增原则或章节，或实质性扩充指导内容。
     - PATCH：澄清、措辞调整、错别字修正，以及不改变语义的细化。
   - 如果无法明确判断版本递增类型，应先说明理由，再作最终决定。

3. 以解析出的模板为规定结构，起草更新后的章程内容：
   - 用具体文本替换每个占位符（不得残留方括号标记，除非项目选择暂不定义并有意保留某些模板槽位；对每个保留项都必须明确说明理由）。
   - 保留标题层级。完成替换后可删除注释，除非注释仍有助于澄清要求。
   - 确保每个 Principle 章节都包含简洁的名称行、陈述不可妥协规则的段落或项目列表，以及在理由不明显时给出的明确解释。
   - 确保 Governance 章节列出修订流程、版本策略和合规审查要求。

4. 更新后，在章程文件顶部以 HTML 注释形式生成同步影响报告（Sync Impact Report）。
   该报告是供人工审查修订内容的临时材料，不属于治理内容；
   提交修订后的章程文件之前，应将其删除。
   - 版本变化：旧版本 → 新版本。
   - 修改过的原则列表（如果重命名，则列出旧标题 → 新标题）。
   - 新增章节。
   - 删除章节。
   - 如果有占位符被有意暂缓填写，列出后续 TODO 事项。

5. 最终输出前的验证：
   - 不残留未经说明的方括号标记。
   - 版本行与报告一致。
   - 日期使用 ISO 格式 YYYY-MM-DD。
   - 原则采用陈述式表达，可测试且无含糊措辞（对于含糊的“应该”，应视情况改为明确的 MUST/SHOULD 约束并说明理由）。

6. 将完成后的章程写回 `.specify/memory/constitution.md`（覆盖原文件）。

7. 向用户输出最终摘要，包含：
   - 新版本及版本递增理由。
   - 所有需要人工后续处理的 TODO 占位符或暂缓事项。
   - 建议的提交信息（例如 `docs: amend constitution to vX.Y.Z (principle additions + governance update)`）。
   - 在 `Next Actions` 章节中列出所有暂缓处理的非治理意图。

格式与风格要求：

- 严格使用模板中的 Markdown 标题（不得升降标题级别）。
- 对较长的理由说明行进行换行，以保持可读性（理想情况下每行少于 100 个字符），但不要为强行满足限制而生硬断行。
- 章节之间保留一个空行。
- 避免行尾空白。

如果用户只提供了部分更新（例如只修改一条原则），仍须执行验证和版本判断步骤。

如果缺少关键信息（例如确实无法确定最初通过日期），插入 `TODO(<FIELD_NAME>): explanation`，并在同步影响报告的暂缓事项中列出。

只写入 `.specify/memory/constitution.md`；不要创建或修改模板源文件。

## 执行后检查

**检查扩展钩子（更新章程之后）**：
检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果存在，读取该文件并查找 `hooks.after_constitution` 键下的条目。
- 如果 YAML 无法解析或内容无效，不得静默跳过：告知用户无法读取 `.specify/extensions.yml`（附上解析器错误），且未检查任何钩子，包括其中注册的强制钩子（`optional: false`），然后正常继续。
- 排除 `enabled` 明确为 `false` 的钩子。没有 `enabled` 字段的钩子默认视为已启用。
- 对于其余每个钩子，**不要**尝试解释或求值钩子的 `condition` 表达式：
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
    输出上述内容后，你必须实际调用钩子，并等待其完成后才能继续。调用方式应与你在当前代理或会话中自行执行该命令时一致（实际调用形式可能与上面显示的 `{command}` 字面标识不同，例如技能模式下的代理会使用 `/skill:speckit-...` 或 `$speckit-...`）。仅输出上述内容并不会执行钩子。
- 如果没有注册钩子，或 `.specify/extensions.yml` 不存在，则静默跳过。
