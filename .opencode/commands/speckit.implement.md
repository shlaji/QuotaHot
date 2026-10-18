---
description: 处理并执行 tasks.md 中定义的全部任务，落实实施计划
---

## 用户输入

```text
$ARGUMENTS
```

继续之前，你**必须**考虑用户输入（如果不为空）。

## 执行前检查

**检查扩展钩子（实施之前）**：
- 检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果存在，读取该文件并查找 `hooks.before_implement` 键下的条目。
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

1. 在仓库根目录运行 `python3 .specify/scripts/python/check_prerequisites.py --json --require-tasks --include-tasks`，并解析 FEATURE_DIR 和 AVAILABLE_DOCS 列表。所有路径必须为绝对路径。对于参数中的单引号，例如 "I'm Groot"，使用转义语法，如 'I'\''m Groot'（如果可行，也可以使用双引号："I'm Groot"）。

2. **检查检查清单状态**（如果 FEATURE_DIR/checklists/ 存在）：
   - 将检查清单标记视为只读门禁：扫描复选框状态，报告状态，并在必要时询问是否继续；不得修改检查清单文件或标记。
   - `checklists/requirements.md` 是由 `/speckit.specify` 和 `/speckit.clarify` 维护的内置规格质量检查清单；由 `/speckit.checklist` 生成的自定义检查清单是由评审者负责的需求质量评审产物。
   - 对于自定义检查清单，`[x]` 表示评审者认定该需求质量标准已满足，并不表示实施工作已完成。
   - 扫描 checklists/ 目录中的所有检查清单文件。
   - 对每份检查清单统计：
     - 总项数：所有匹配 `- [ ]`、`- [X]` 或 `- [x]` 的行。
     - 已勾选项数：匹配 `- [X]` 或 `- [x]` 的行。
     - 未勾选项数：匹配 `- [ ]` 的行。
   - 创建状态表：

     ```text
     | Checklist | Total | Checked | Unchecked | Status |
     |-----------|-------|---------|-----------|--------|
     | ux.md     | 12    | 12      | 0         | ✓ PASS |
     | test.md   | 8     | 5       | 3         | ✗ FAIL |
     | security.md | 6   | 6       | 0         | ✓ PASS |
     ```

   - 计算总体状态：
     - **PASS**：所有检查清单的未勾选项数均为 0。
     - **FAIL**：一份或多份检查清单存在未勾选项。

   - **如果任一检查清单存在未勾选项**：
     - 展示包含未勾选项数的表格。
     - **停止**并询问：“部分检查清单仍有未勾选项。是否仍要继续实施？（yes/no）”
     - 等待用户回复后再继续。
     - 如果用户回复 "no"、"wait" 或 "stop"，停止执行。
     - 如果用户回复 "yes"、"proceed" 或 "continue"，进入第 3 步。

   - **如果所有检查清单均已勾选**：
     - 展示表格，说明所有检查清单均已通过。
     - 自动进入第 3 步。

3. 加载并分析实施上下文：
   - **必须**：读取 tasks.md，了解完整任务列表和执行计划。
   - **必须**：读取 plan.md，了解技术栈、架构和文件结构。
   - **如果存在**：读取 data-model.md，了解实体及其关系。
   - **如果存在**：读取 contracts/，了解 API 规格和测试要求。
   - **如果存在**：读取 research.md，了解技术决策和约束。
   - **如果存在**：读取 .specify/memory/constitution.md，了解治理约束。
   - **如果存在**：读取 quickstart.md，了解集成场景。

4. **项目配置验证**：
   - **必须**：根据项目实际配置创建或验证忽略文件：

   **检测与创建逻辑**：
   - 检查以下命令是否成功，以判断仓库是否为 git 仓库（如果是，则创建或验证 .gitignore）：

     ```sh
     git rev-parse --git-dir 2>/dev/null
     ```

   - 检查是否存在 Dockerfile*，或 plan.md 是否使用 Docker → 创建或验证 .dockerignore。
   - 检查是否存在 .eslintrc* → 创建或验证 .eslintignore。
   - 检查是否存在 eslint.config.* → 确保配置中的 `ignores` 条目覆盖必需模式。
   - 检查是否存在 .prettierrc* → 创建或验证 .prettierignore。
   - 检查是否存在 .npmrc 或 package.json → 创建或验证 .npmignore（如果需要发布）。
   - 检查是否存在 terraform 文件（*.tf）→ 创建或验证 .terraformignore。
   - 检查是否需要 .helmignore（存在 helm charts）→ 创建或验证 .helmignore。

   **如果忽略文件已存在**：验证其是否包含必要模式，仅追加缺失的关键模式。
   **如果忽略文件不存在**：使用检测到的技术所需的完整模式集创建文件。

   **各技术的常用模式**（根据 plan.md 中的技术栈）：
   - **Node.js/JavaScript/TypeScript**: `node_modules/`, `dist/`, `build/`, `*.log`, `.env*`
   - **Python**: `__pycache__/`, `*.pyc`, `.venv/`, `venv/`, `dist/`, `*.egg-info/`
   - **Java**: `target/`, `*.class`, `*.jar`, `.gradle/`, `build/`
   - **C#/.NET**: `bin/`, `obj/`, `*.user`, `*.suo`, `packages/`
   - **Go**: `*.exe`, `*.test`, `vendor/`, `*.out`
   - **Ruby**: `.bundle/`, `log/`, `tmp/`, `*.gem`, `vendor/bundle/`
   - **PHP**: `vendor/`, `*.log`, `*.cache`, `*.env`
   - **Rust**: `target/`, `debug/`, `release/`, `*.rs.bk`, `*.rlib`, `*.prof*`, `.idea/`, `*.log`, `.env*`
   - **Kotlin**: `build/`, `out/`, `.gradle/`, `.idea/`, `*.class`, `*.jar`, `*.iml`, `*.log`, `.env*`
   - **C++**: `build/`, `bin/`, `obj/`, `out/`, `*.o`, `*.so`, `*.a`, `*.exe`, `*.dll`, `.idea/`, `*.log`, `.env*`
   - **C**: `build/`, `bin/`, `obj/`, `out/`, `*.o`, `*.a`, `*.so`, `*.exe`, `*.dll`, `autom4te.cache/`, `config.status`, `config.log`, `.idea/`, `*.log`, `.env*`
   - **Swift**: `.build/`, `DerivedData/`, `*.swiftpm/`, `Packages/`
   - **R**: `.Rproj.user/`, `.Rhistory`, `.RData`, `.Ruserdata`, `*.Rproj`, `packrat/`, `renv/`
   - **通用**: `.DS_Store`, `Thumbs.db`, `*.tmp`, `*.swp`, `.vscode/`, `.idea/`

   **工具专用模式**：
   - **Docker**: `node_modules/`, `.git/`, `Dockerfile*`, `.dockerignore`, `*.log*`, `.env*`, `coverage/`
   - **ESLint**: `node_modules/`, `dist/`, `build/`, `coverage/`, `*.min.js`
   - **Prettier**: `node_modules/`, `dist/`, `build/`, `coverage/`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`
   - **Terraform**: `.terraform/`, `*.tfstate*`, `*.tfvars`, `.terraform.lock.hcl`
   - **Kubernetes/k8s**: `*.secret.yaml`, `secrets/`, `.kube/`, `kubeconfig*`, `*.key`, `*.crt`

5. 解析 tasks.md 结构并提取：
   - **任务阶段**：初始化（Setup）、测试（Tests）、核心开发（Core）、集成（Integration）、完善（Polish）。
   - **任务依赖**：串行与并行执行规则。
   - **任务详情**：ID、描述、文件路径、并行标记 [P]。
   - **执行流程**：顺序和依赖要求。

6. 按照任务计划执行实施：
   - **逐阶段执行**：完成当前阶段后，再进入下一阶段。
   - **遵守依赖关系**：串行任务按顺序执行，带 [P] 的并行任务可以同时运行。
   - **遵循 TDD 方法**：先执行测试任务，再执行对应的实施任务。
   - **按文件协调**：影响同一文件的任务必须串行执行。
   - **验证检查点**：验证当前阶段已完成后再继续。

7. 实施执行规则：
   - **先初始化**：初始化项目结构、依赖和配置。
   - **先测试后代码**：如果需要为契约、实体和集成场景编写测试，先完成这些测试。
   - **核心开发**：实现模型、服务、CLI 命令和端点。
   - **集成工作**：数据库连接、中间件、日志和外部服务。
   - **完善与验证**：单元测试、性能优化和文档。

8. 进度跟踪和错误处理：
   - 每完成一个任务后报告进度。
   - 任一非并行任务失败时，停止执行。
   - 对于带 [P] 的并行任务，继续推进成功的任务，并报告失败的任务。
   - 提供清晰的错误信息及上下文，便于调试。
   - 如果无法继续实施，建议下一步操作。
   - **重要**：对于已完成的任务，务必在任务文件中将其标记为 [X]。

9. 完成验证：
   - 验证所有必需任务均已完成。
   - 检查已实现的功能是否符合原始规格。
   - 验证测试通过且覆盖率满足要求。
   - 确认实现遵循技术计划。

注意：此命令假定 tasks.md 中已有完整的任务分解。如果任务不完整或缺失，建议先运行 `/speckit.tasks` 重新生成任务列表。

## 强制执行后钩子

**向用户报告完成之前，你必须完成本节。**

检查项目根目录中是否存在 `.specify/extensions.yml`。
- 如果不存在，或 `hooks.after_implement` 下没有注册钩子，跳至完成报告。
- 如果存在，读取该文件并查找 `hooks.after_implement` 键下的条目。
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

报告最终状态，并概述已完成的工作。

## 完成条件

- [ ] tasks.md 中的所有任务均已完成并标记为 `[X]`
- [ ] 已依据规格、计划和测试覆盖率要求验证实现
- [ ] 已按照上文“强制执行后钩子”中的规则分派或跳过扩展钩子
- [ ] 已向用户报告完成，并概述已完成的工作
