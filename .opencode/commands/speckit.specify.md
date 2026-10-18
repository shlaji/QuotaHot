---
description: 根据自然语言的功能描述创建或更新功能规格说明。
handoffs:
  - label: 制定技术计划
    agent: speckit.plan
    prompt: 为这份规格说明制定计划。我使用的技术是...
  - label: 澄清规格需求
    agent: speckit.clarify
    prompt: 澄清规格说明中的需求
    send: true
---

## 用户输入

```text
$ARGUMENTS
```

继续之前，你**必须**考虑用户输入（如果非空）。

## 执行前检查

**检查扩展钩子（编写规格说明之前）**：
- 检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果存在，读取该文件并查找 `hooks.before_specify` 键下的条目。
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

触发消息中，用户在 `/speckit.specify` 后输入的文字**就是**功能描述。即使下方出现的是 `$ARGUMENTS` 字面文本，也应认为本次对话中始终可以取得该描述。除非用户提交的是空命令，否则不要要求用户重复输入。

根据该功能描述，执行以下步骤：

1. 为功能**生成简短名称**（2 至 4 个单词）：
   - 分析功能描述，提取最有意义的关键词。
   - 创建一个由 2 至 4 个单词组成、能概括功能本质的简短名称。
   - 尽可能使用“动作加名词”的格式（例如 "add-user-auth"、"fix-payment-bug"）。
   - 保留技术术语和缩写（OAuth2、API、JWT 等）。
   - 名称应简洁，同时足够明确，让人一眼就能理解功能。
   - 示例：
     - “我想添加用户身份验证” → "user-auth"
     - “为 API 实现 OAuth2 集成” → "oauth2-api-integration"
     - “创建数据分析仪表盘” → "analytics-dashboard"
     - “修复支付处理超时缺陷” → "fix-payment-timeout"

2. **创建分支**（可选，通过钩子执行）：

   如果上面的执行前检查中有 `before_specify` 钩子成功运行，它应已创建或切换到一个 git 分支，并输出包含 `BRANCH_NAME` 和 `FEATURE_NUM` 的 JSON。记下这些值以供参考，但分支名称**不决定**规格目录名称。

   如果用户明确提供了 `GIT_BRANCH_NAME`，将其原样传给钩子，让分支脚本使用该确切值作为分支名称（跳过所有前缀和后缀生成逻辑）。

3. **创建功能规格目录**：

   除非用户明确提供 `SPECIFY_FEATURE_DIRECTORY`，否则规格说明默认存放在 `specs/` 目录下。

   **`SPECIFY_FEATURE_DIRECTORY` 的解析顺序**：
   1. 如果用户明确提供了 `SPECIFY_FEATURE_DIRECTORY`（例如通过环境变量、参数或配置），则原样使用。
   2. 否则，在 `specs/` 下自动生成：
      - 检查 `.specify/init-options.json` 中的 `feature_numbering`（优先使用）或 `branch_numbering`（已弃用，仅供迁移使用，将在未来版本中移除）。
      - 如果值为 `"timestamp"`：前缀为 `YYYYMMDD-HHMMSS`（当前时间戳）。
      - 如果值为 `"sequential"` 或未设置：前缀为 `NNN`（扫描 `specs/` 中已有目录后取得的下一个可用三位数编号）。
      - 构造目录名称：`<prefix>-<short-name>`（例如 `003-user-auth` 或 `20260319-143022-user-auth`）。
      - 将 `SPECIFY_FEATURE_DIRECTORY` 设为 `specs/<directory-name>`。
      - 如果使用了 `branch_numbering`（且没有 `feature_numbering`），输出一行警告：“⚠️ init-options.json 中的 `branch_numbering` 已弃用。请将其重命名为 `feature_numbering`。”

   **创建目录和规格文件**：
   - `mkdir -p SPECIFY_FEATURE_DIRECTORY`
   - 通过 Spec Kit 的预设与模板解析栈解析当前生效的 `spec-template`（等同于 `specify preset resolve spec-template`）。
   - 将解析出的 `spec-template` 文件复制到 `SPECIFY_FEATURE_DIRECTORY/spec.md`，作为初始文件。
   - 将 `SPEC_FILE` 设为 `SPECIFY_FEATURE_DIRECTORY/spec.md`。
   - 将解析后的路径持久化到 `.specify/feature.json`：
     ```json
     {
       "feature_directory": "<resolved feature dir>"
     }
     ```
     写入实际解析出的目录路径值（例如 `specs/003-user-auth`），而不是字面字符串 `SPECIFY_FEATURE_DIRECTORY`。
     这样，下游命令（`/speckit.plan`、`/speckit.tasks` 等）就能定位功能目录，而无需依赖 git 分支命名约定。

   **重要**：
   - 每次调用 `/speckit.specify` 时，只能创建一个功能。
   - 规格目录名称与 git 分支名称相互独立。两者可以相同，但应由用户决定。
   - 规格目录和文件始终由本命令创建，绝不由钩子创建。

4. 加载解析出的当前生效的 `spec-template` 文件，了解必需的章节。

5. **如果存在**：加载 `.specify/memory/constitution.md`，了解项目原则和治理约束。

6. 按以下流程执行：
    1. 从参数中解析用户描述。
       如果为空：返回 ERROR "No feature description provided"。
    2. 从描述中提取关键概念。
       识别参与者、动作、数据和约束。
    3. 对于不明确的方面：
       - 根据上下文和行业标准作出有依据的推断。
       - 只有满足以下条件时，才使用 [NEEDS CLARIFICATION: specific question] 标记：
         - 该选择会显著影响功能范围或用户体验。
         - 存在多种合理解释，且会带来不同影响。
         - 没有合理的默认值。
       - **数量限制：[NEEDS CLARIFICATION] 标记总数最多为 3 个。**
       - 按影响程度确定澄清优先级：范围 > 安全与隐私 > 用户体验 > 技术细节。
    4. 填写 User Scenarios & Testing 章节。
       如果无法确定清晰的用户流程：返回 ERROR "Cannot determine user scenarios"。
    5. 生成功能需求（Functional Requirements）。
       每项需求都必须可测试。
       对未指定的细节使用合理默认值（在 Assumptions 章节中记录假设）。
    6. 定义成功标准（Success Criteria）。
       制定可衡量且与技术无关的结果。
       同时包含定量指标（时间、性能、数量）和定性指标（用户满意度、任务完成情况）。
       每项标准都必须能在不了解实现细节的情况下验证。
    7. 识别关键实体（Key Entities，如果涉及数据）。
    8. 返回 SUCCESS（规格说明已可进入规划阶段）。

7. 按模板结构将规格说明写入 SPEC_FILE，用从功能描述（参数）中提取的具体细节替换占位符，同时保留章节顺序和标题。

8. **规格质量验证**：写完初稿后，按照质量标准验证规格说明：

   a. **创建规格质量检查清单**：按照检查清单模板结构，在 `SPECIFY_FEATURE_DIRECTORY/checklists/requirements.md` 生成检查清单文件，包含以下验证项：

      ```markdown
      # Specification Quality Checklist: [FEATURE NAME]

      **Purpose**: 进入规划阶段前，验证规格说明的完整性和质量
      **Created**: [DATE]
      **Feature**: [Link to spec.md]

      ## Content Quality

      - [ ] 不包含实现细节（语言、框架、API）
      - [ ] 聚焦用户价值和业务需求
      - [ ] 面向非技术利益相关者编写
      - [ ] 已完成所有必需章节

      ## Requirement Completeness

      - [ ] 不再包含 [NEEDS CLARIFICATION] 标记
      - [ ] 需求可测试且无歧义
      - [ ] 成功标准可衡量
      - [ ] 成功标准与技术无关（不包含实现细节）
      - [ ] 已定义所有验收场景
      - [ ] 已识别边界情况
      - [ ] 已明确界定范围
      - [ ] 已识别依赖和假设

      ## Feature Readiness

      - [ ] 所有功能需求都有明确的验收标准
      - [ ] 用户场景覆盖主要流程
      - [ ] 功能满足 Success Criteria 中定义的可衡量结果
      - [ ] 规格说明中未混入实现细节

      ## Notes

      - 对于标记为未完成的项目，必须在执行 `/speckit.clarify` 或 `/speckit.plan` 前更新规格说明
      ```

   b. **执行验证检查**：逐项对照检查清单审查规格说明：
      - 判断每一项是否通过。
      - 记录发现的具体问题（引用规格说明中的相关章节）。

   c. **处理验证结果**：

      - **如果所有项目均通过**：将检查清单标记为完成，继续执行“强制执行后钩子”章节。

      - **如果存在未通过的项目（不包括 [NEEDS CLARIFICATION]）**：
        1. 列出未通过的项目和具体问题。
        2. 更新规格说明，逐一解决问题。
        3. 重新验证，直到所有项目均通过（最多迭代 3 次）。
        4. 如果迭代 3 次后仍未通过，在检查清单备注中记录剩余问题，并向用户发出警告。

      - **如果仍有 [NEEDS CLARIFICATION] 标记**：
        1. 提取规格说明中的所有 [NEEDS CLARIFICATION: ...] 标记。
        2. **数量限制检查**：如果超过 3 个标记，只保留最关键的 3 个（按对范围、安全和用户体验的影响判断），其余内容作出有依据的推断。
        3. 对每个需要澄清的问题（最多 3 个），按以下格式向用户提供选项：

           ```markdown
           ## Question [N]: [Topic]

           **Context**: [Quote relevant spec section]

           **What we need to know**: [Specific question from NEEDS CLARIFICATION marker]

           **Suggested Answers**:

           | Option | Answer | Implications |
           |--------|--------|--------------|
           | A      | [First suggested answer] | [What this means for the feature] |
           | B      | [Second suggested answer] | [What this means for the feature] |
           | C      | [Third suggested answer] | [What this means for the feature] |
           | Custom | 提供你自己的答案 | [Explain how to provide custom input] |

           **Your choice**: _[Wait for user response]_
           ```

        4. **关键要求：表格格式**：确保 Markdown 表格格式正确：
           - 使用一致的空格，并对齐竖线。
           - 每个单元格的内容两侧都应留有空格：使用 `| Content |`，而不是 `|Content|`。
           - 表头分隔符必须至少包含 3 个连字符：`|--------|`。
           - 在 Markdown 预览中检查表格是否正确渲染。
        5. 按顺序为问题编号（Q1、Q2、Q3，总计最多 3 个）。
        6. 一次性展示所有问题，然后等待回复。
        7. 等待用户回复所有问题的选择（例如 "Q1: A, Q2: Custom - [details], Q3: B"）。
        8. 用用户选择或提供的答案替换每个 [NEEDS CLARIFICATION] 标记，更新规格说明。
        9. 所有问题澄清后，重新执行验证。

   d. **更新检查清单**：每轮验证后，将当前的通过或未通过状态更新到检查清单文件中。

## 强制执行后钩子

**向用户报告完成之前，你必须完成本章节。**

检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果不存在，或 `hooks.after_specify` 下没有注册钩子，则跳转到“完成报告”。
- 如果存在，读取该文件并查找 `hooks.after_specify` 键下的条目。
- 如果 YAML 无法解析或内容无效，不得静默跳过：告知用户无法读取 `.specify/extensions.yml`（附上解析器错误），且未检查任何钩子，包括其中注册的强制钩子（`optional: false`），然后继续执行“完成报告”。
- 排除 `enabled` 明确为 `false` 的钩子。没有 `enabled` 字段的钩子默认视为已启用。
- 对于其余每个钩子，**不要**尝试解释或求值钩子的 `condition` 表达式：
  - 如果钩子没有 `condition` 字段，或该字段为 null 或空值，则视为可执行。
  - 如果钩子定义了非空的 `condition`，则跳过该钩子，将条件求值交给 HookExecutor 实现。
- 对每个可执行钩子，根据其 `optional` 标志输出以下内容：
  - **强制钩子**（`optional: false`）：**你必须为每个强制钩子输出 `EXECUTE_COMMAND:`**：
    ```
    ## Extension Hooks

    **Automatic Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}
    ```
    输出上述内容后，你必须实际调用钩子，并等待其完成后才能继续。调用方式应与你在当前代理或会话中自行执行该命令时一致（实际调用形式可能与上面显示的 `{command}` 字面标识不同，例如技能模式下的代理会使用 `/skill:speckit-...` 或 `$speckit-...`）。仅输出上述内容并不会执行钩子。
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

向用户报告完成情况，包含：
- `SPECIFY_FEATURE_DIRECTORY`：功能目录路径。
- `SPEC_FILE`：规格文件路径。
- 检查清单结果摘要。
- 是否已可进入下一阶段（`/speckit.clarify` 或 `/speckit.plan`）。

**注意：** 分支创建由 `before_specify` 钩子（git 扩展）负责。规格目录和文件始终由本核心命令创建。

## 简明指南

- 聚焦用户**需要什么**以及**为什么需要**。
- 避免描述如何实现（不包含技术栈、API 或代码结构）。
- 面向业务利益相关者编写，而不是开发人员。
- 不得在规格说明中内嵌任何检查清单。检查清单由单独的命令创建。

### 章节要求

- **必需章节**：每个功能都必须填写。
- **可选章节**：仅在与功能相关时保留。
- 不适用的章节应完整删除（不要保留并填写 "N/A"）。

### AI 生成指南

根据用户提示词创建规格说明时：

1. **作出有依据的推断**：利用上下文、行业标准和常见模式补全缺失信息。
2. **记录假设**：在 Assumptions 章节中记录合理默认值。
3. **限制澄清数量**：最多使用 3 个 [NEEDS CLARIFICATION] 标记，仅用于同时符合以下条件的关键决策：
   - 显著影响功能范围或用户体验。
   - 存在多种合理解释，且会带来不同影响。
   - 没有任何合理默认值。
4. **确定澄清优先级**：范围 > 安全与隐私 > 用户体验 > 技术细节。
5. **像测试人员一样思考**：任何含糊的需求都不应通过“可测试且无歧义”检查项。
6. **常见的待澄清领域**（仅在没有合理默认值时）：
   - 功能范围和边界（纳入或排除特定用例）。
   - 用户类型和权限（可能存在多种相互冲突的解释时）。
   - 安全与合规要求（涉及重大法律或财务影响时）。

**合理默认值示例**（不要就这些内容提问）：

- 数据保留：采用该领域的行业标准做法。
- 性能目标：除非另有说明，采用 Web 或移动应用的常规预期。
- 错误处理：提供用户易懂的提示和适当的回退方案。
- 身份验证方式：Web 应用采用标准的会话验证或 OAuth2。
- 集成模式：采用适合项目的模式（Web 服务使用 REST/GraphQL，库使用函数调用，工具使用 CLI 参数等）。

### 成功标准指南

成功标准必须符合以下要求：

1. **可衡量**：包含具体指标（时间、百分比、数量、比率）。
2. **与技术无关**：不提及框架、语言、数据库或工具。
3. **以用户为中心**：从用户或业务视角描述结果，而不是描述系统内部机制。
4. **可验证**：无需了解实现细节即可测试或验证。

**正面示例**：

- “用户可以在 3 分钟内完成结账”
- “系统支持 10,000 名并发用户”
- “95% 的搜索在 1 秒内返回结果”
- “任务完成率提升 40%”

**反面示例**（侧重实现）：

- “API 响应时间低于 200ms”（过于技术化，应改为“用户能立即看到结果”）
- “数据库可处理 1000 TPS”（属于实现细节，应使用面向用户的指标）
- “React 组件渲染高效”（依赖特定框架）
- “Redis 缓存命中率高于 80%”（依赖特定技术）

## 完成条件

- [ ] 已将规格说明写入 `SPEC_FILE`，并按质量检查清单完成验证
- [ ] 已按上面“强制执行后钩子”中的规则调用或跳过扩展钩子
- [ ] 已向用户报告完成情况，包含功能目录、规格文件路径和检查清单结果
