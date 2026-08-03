# Verification & Multi-Agent · 验证闭环与子代理

> 验证结果就是交付依据；子代理只在评测证明有收益时才引入。这篇讲验证流水线、错误分类、Repair Loop 与多 Agent 策略。

agent 说「我改好了」不算数，**测试跑绿了才算数**。这篇讲两件事：一是改完代码后按什么顺序做质检（先查便宜快的、再查贵的），二是什么时候该把一个大任务拆给几个「子代理」分头干。用质检流水线打比方：不是每件产品都从头到尾过一遍最贵的全检，而是先看外观（diff）、再通电（类型/lint）、最后才满载测试（build/E2E）。读完你会知道为什么「多 agent」不是越多越好。

## 1. 验证流水线

按改动类型选择，不每轮盲目跑全仓库耗时检查；顺序从便宜、反馈快的检查开始：

1. diff / 补丁可应用检查、格式与敏感文件检查；
2. 受影响包的 TypeScript 类型检查；
3. ESLint / 项目 lint；
4. 相关单元测试与回归测试；
5. 构建；
6. UI 任务的 Playwright 冒烟 / E2E（需要时）；
7. 最终全量检查（按风险、时间与规模决定）。

把这条「从便宜到贵」的顺序画出来：

```mermaid
flowchart TD
    A["diff 能应用? 格式对?"] -->|秒级| B["受影响包的类型检查"]
    B -->|秒级| C["ESLint / lint"]
    C -->|秒级~十秒| D["相关单元/回归测试"]
    D -->|十秒级| E["构建 build"]
    E -->|分钟级| F["UI 任务: Playwright 冒烟/E2E"]
    F -->|分钟级| G["最终全量检查（按需）"]
    A -.失败.-> X["进 Repair Loop，有限次自修"]
    D -.失败.-> X
    style X fill:#fee,stroke:#c00
```

这张图在说什么：先做几秒钟就能出结果的检查，过了再往上花钱。一旦某一步失败，直接进 Repair Loop 自动修，而不是傻跑到最后一步才发现问题。

举个例子（示意）：同样是「命令返回非 0」，系统会按错误码区别对待——`TEST_FAILED`（测试断言没通过）就让模型进 Repair Loop 去修；`NETWORK_BLOCKED`（网络被沙箱挡了）则不该让模型反复重写代码，因为这不是代码的错；`TOOL_PERMISSION_DENIED`（权限被拒）更不能让模型换一条命令绕过策略。错误码不同，恢复策略完全不同。

Playwright 优先用可等待的 locator assertion，不靠固定 sleep 判断页面稳定。

```ts
interface ValidationReport {
  status: "passed" | "failed" | "partial" | "not_run";
  checks: Array<{
    id: string;
    command: string[];
    status: "passed" | "failed" | "skipped" | "blocked";
    exitCode?: number;
    durationMs?: number;
    summary: string;
    artifactUri?: string;
  }>;
  acceptance: Array<{
    criterionId: string;
    status: "verified" | "not_verified" | "failed";
    evidence?: string[];
  }>;
}
```

### 1.1 约定即执行：规则文件里的测试命令（AGENTS.md 标准实证）

AGENTS.md 规范 FAQ 明确（出处：https://agents.md ）：**在 AGENTS.md 里列出的测试命令，agent 会自动尝试执行，并在任务结束前修复失败**（"The agent will attempt to execute relevant programmatic checks and fix failures before finishing the task"）。对 mod-agent：

- §2 项目命令发现以 `package.json` 等为准之外，**AGENTS.md / CLAUDE.md 中显式列出的 build / test 命令同样进入候选**，且执行前过 Policy；
- 「修到绿」是任务收尾的默认义务，不是可选项——与 §1 验证流水线、Repair Loop 衔接。

## 2. 项目命令发现

从 `package.json`、workspace 配置、README、CI 配置与现有脚本推断检查命令，形成候选列表并记录来源与置信度。命令必须过 Policy；检测到 monorepo 时优先定位受影响 package，不默认跑全仓库命令。

## 3. 错误分类

统一错误码，分类后才能采取不同恢复策略：

- `MODEL_TIMEOUT` / `MODEL_RATE_LIMIT` / `MODEL_INVALID_OUTPUT`
- `TOOL_TIMEOUT` / `TOOL_PERMISSION_DENIED` / `TOOL_SCHEMA_INVALID`
- `PATCH_CONFLICT` / `PATH_POLICY_VIOLATION`
- `COMMAND_EXIT_NONZERO` / `DEPENDENCY_INSTALL_FAILED` / `NETWORK_BLOCKED`
- `TYPECHECK_FAILED` / `LINT_FAILED` / `TEST_FAILED` / `BUILD_FAILED`
- `BUDGET_EXCEEDED` / `NO_PROGRESS` / `CANCELLED`
- `SANDBOX_FAILURE` / `WORKSPACE_CONFLICT`

例：测试断言失败进入诊断修复；网络受限不应反复让模型重写代码；权限拒绝不能换条命令规避策略。

## 4. Repair Loop（失败自修正）

```mermaid
flowchart TD
    A["测试失败 / lint 报错"] --> B["取裁剪后的失败日志"]
    B --> C["模型写语言化反思：错在哪、下次怎么改"]
    C --> D["回滚到上一检查点"]
    D --> E["带反思与失败日志重新定位"]
    E --> F["生成新的 Patch"]
    F --> G["重跑测试"]
    G --> H{"通过"}
    H -- 是 --> I["进入交付"]
    H -- 否 --> J{"连续同一失败达阈值"}
    J -- 否 --> C
    J -- 是 --> K["判 stuck，提交人介入"]
```

步骤：

1. 收集失败命令、退出码、精简 stdout/stderr、测试名与相关文件；
2. 日志截断 / 归档，提取可定位的错误摘要，不把超长日志无过滤塞上下文；
3. 先要求 Agent 解释失败与修改的关联，提出可检验假设；
4. 允许有限次修复，每次记录修改文件与测试结果；
5. 错误转变则更新诊断；错误重复或范围持续扩大则停止自动修复；
6. 重跑受影响检查，区分「已通过 / 失败 / 未执行 / 环境无法执行」。

反思（Reflexion）不更新权重，用自然语言把失败教训写进下轮 prompt；它的质量上限就是模型的自我诊断能力，最终判定以确定性测试为准，不信模型自述成功。连续同一失败达阈值即判 stuck，防止 ReAct 单路径贪心死循环。

## 5. 多 Agent 策略

### 5.1 首期单 Agent

对常见新功能与修复，一个能力充足的主 Agent + 确定性验证流程，通常比多个 Agent 互相转交更好调试。多 Agent 会增加上下文传递、协调、工具权限、执行成本与失败归因复杂度。能不用就不用。

### 5.2 何时引入子 Agent

当评测证明某环节有可独立并行的工作、明确输入输出，并能提升成功率或降低成本时，可引入：

- `Repository Analyst`：只读探索，输出带证据的相关文件与调用链；
- `Test Analyst`：分析失败日志，提出最有价值的回归测试；
- `Patch Reviewer`：只读审查 diff、范围、安全与边界条件；
- `Documentation Agent`：生成变更文档 / 发布说明。

子 Agent 默认只给需要的工具——分析型 Agent 不应得到写文件与终端权限。

### 5.3 交接与隔离

```mermaid
flowchart TD
    O["Orchestrator 主 Agent"] --> W1["Worker 1 独立上下文 + worktree"]
    O --> W2["Worker 2 独立上下文 + worktree"]
    W1 --> R1["只回 1-2k token 摘要 + diff"]
    W2 --> R2["只回 1-2k token 摘要 + diff"]
    R1 --> M["综合：检查跨文件一致性"]
    R2 --> M
    M --> OK{"一致"}
    OK -- 是 --> D["合并产物交主循环"]
    OK -- 否 --> P["派修补 worker 或 replan"]
    P --> O
```

- 每个 worker 跑独立上下文窗口，中间工具调用不回流主会话，只回 1–2k token 摘要 + 产物；
- 并行写不同文件用独立 Git Worktree 隔离防冲突；
- 交接必须传递：任务目标、相关证据、候选文件、未确认假设、约束、当前提交、期望输出 Schema、禁止动作——不传无边界长对话作为唯一状态；
- 综合时显式检查跨文件一致性（多 Agent 失败约 44% 源于此），不一致则派修补 worker 或 replan。

### 5.4 业界实证：子代理与并行的强制机制

**Plan 只读靠「不注册写工具」，而不是系统提示约束（Cline 实证，出处：https://docs.cline.bot/core-workflows/plan-and-act ）**：Plan 模式下 agent 只挂载 read / search / discuss 类工具，不挂载 write_file / edit / terminal——"cannot modify any files or execute commands. This constraint is intentional." 切回 Act 模式时对话上下文完整继承，不用重述。对 mod-agent：§5.2 的分析型子代理（Repository Analyst / Patch Reviewer）应在**代码层**就不注册写工具，而不是靠 prompt 叮嘱。

**子代理 = 独立上下文窗口 + 同工具集 + 只回传结果（Zed `spawn_agent` 实证，出处：https://zed.dev/docs/ai/tools ）**：派一个带独立上下文窗口的子代理执行委托任务（并行调研 / 自包含小任务），探索过程留在自己窗口，仅把结果交回父代理；父代理继续原工作，子代理完成后再评审其结论——两边上下文都聚焦单一任务。

**并行 agent + worktree 隔离并发写（Zed Parallel Agents 实证，出处：https://zed.dev/docs/ai/parallel-agents ）**：

1. 每个 agent 线程独立上下文窗口与对话历史，可并行推进不同任务；
2. 预判两线程会改到相同文件时，给其中一个开独立 git worktree 检出，物理隔离写冲突；
3. 新建 worktree 默认 **detached HEAD**，防止不同线程误用同一分支；
4. 新建 worktree 时触发 hook，注入新旧 worktree 根路径环境变量，便于自动跑初始化；
5. 任务结束：人工评审 diff，经正常 git 流程合并；线程归档时保存并清理 worktree，恢复线程时自动重建。

**多 agent 编排的门槛（Factory Droid `--mission` 实证，出处：https://docs.factory.ai/droid-cli/cli-reference.md ）**：并行 / mission 模式要求自治等级先达到 `--auto high`（只读 → 安全改 → 本地开发 → 可 push 逐级解锁后才允许并行自治），因为并行 agent 要能自己提交 / push。对 mod-agent：多 worker 并行是**权限上界**，不是默认能力。
