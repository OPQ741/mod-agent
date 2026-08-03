# Tools & Extensions · 工具系统、MCP 与 Skills

> 这篇讲工具契约、统一执行结果、幂等与重试、人工审批策略，以及 MCP / Skills 扩展机制。

## 1. 工具分层

**A. 内部核心工具（由 Node 进程直接执行，高可信）**

- `repo.list_files` / `repo.read_file` / `repo.search_text`
- `repo.find_symbol` / `repo.find_references`
- `repo.git_status` / `repo.read_diff` / `repo.apply_patch`
- `command.run` / `test.run`
- `browser.open_page` / `browser.screenshot`（后期）

**B. MCP 外部能力**

- GitHub/GitLab：读 Issue/PR、建分支、发 PR（后期）；
- 文档系统 / 工单系统 / 设计工具 / 自定义企业工具。

MCP 是互操作协议，不天然代表可信或安全。每个 MCP Server 单独登记来源、用途、权限范围、认证方式、网络目标、超时与数据分类；其工具描述、注释、返回内容一律按不可信输入处理。

## 2. 工具描述契约（ACI）

```ts
interface AgentTool<I = unknown, O = unknown> {
  name: string;                       // 命名空间，如 repo.read_file
  description: string;                // 写清楚，防模型幻觉 API
  inputSchema: unknown;               // Zod / JSON Schema adapter
  outputSchema?: unknown;
  risk: "read" | "workspace_write" | "command" | "external_side_effect";
  idempotency: "safe" | "keyed" | "non_idempotent";
  timeoutMs: number;
  requiresApproval: (input: I, ctx: TaskContext) => boolean;
  execute(input: I, ctx: ToolExecutionContext): Promise<O>;
}
```

- 模型可见的工具子集按任务模式、任务状态、用户权限与注册策略动态生成；
- 工具名带命名空间（`repo.read_file`），避免多个 MCP Server 提供同名 `search` 产生歧义；
- ACI 反向定制：输出分页 / 折叠 / 截断、报错结构化带「你可能想运行…」提示、强制绝对路径。Anthropic 实测改成强制绝对路径后，模型再没犯过相对路径错误。

## 3. 统一执行结果

```ts
interface ToolExecutionResult<T = unknown> {
  callId: string;
  toolName: string;
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  output?: T;
  error?: { code: string; message: string; retryable: boolean };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  artifacts?: Array<{ kind: string; uri: string; sha256?: string }>;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}
```

- observation 一律标注 `truncated`，让模型知道结果不完整；
- 错误对象必须有稳定 `error_code`，不靠匹配自然语言报错文案来判断分支。

## 4. 重试与幂等

- 只读操作（GET、搜索、读文件）可按策略有限重试；
- 模型请求重试区分超时 / 限流 / 网络错误 / 参数错误，遵守 `Retry-After`，指数退避加抖动；
- 补丁重试前必须检查目标文件 hash 与是否已应用，不能不判断就再写；
- 创建 PR、发消息、改工单等外部副作用用幂等键，或先查副作用是否已发生；没有幂等保证时，超时后不自动重放，转人工确认；
- 结果未知的非幂等调用进入 `outcome_unknown` 语义，而非自动标失败后重试。

## 5. 人工审批策略

| 风险动作 | 默认策略 |
| --- | --- |
| 读工作区内普通源码 | 允许，受路径策略约束 |
| 改授权目录内源码 | 按任务模式允许，前端展示 diff |
| 改锁文件 / 权限 / CI/CD / 部署脚本 | 更严格确认或管理员策略决定 |
| 跑测试 / lint / 类型检查 | 命令在白名单 / 隔离环境内可自动执行 |
| 新增依赖、访问外网装包 | 需网络策略放行；首次新增建议审批 |
| 读密钥 / 凭证 / SSH 私钥 | 默认拒绝；确需则由服务端能力托管，不回模型上下文 |
| 批量删文件、改 Git 历史 | 默认拒绝或强制审批 |
| push / 建 PR / 合并 / 发布 | 先审批；MVP 默认不自动 merge / deploy |
| 访问生产系统 / 改线上数据 | 默认拒绝，需独立授权与审计 |

审批必须与具体动作参数绑定：用户批准了 `command.run` 的一条命令，不能复用于参数不同的另一条。保存请求摘要、参数 hash、策略版本、审批人、时间、结果与失效时间。

## 6. Skills · 工程流程复用

| 概念 | 是什么 | 例子 |
| --- | --- | --- |
| **Tool** | 可被程序调用的原子能力 | 读文件、搜代码、跑测试 |
| **Skill** | 可复用的工作流程 / 说明，指导 Agent 何时按何步骤调工具 | 「定位 React 状态竞态」「给项目加页面」「排查构建错误」 |
| **Workflow / 状态机** | 程序强制执行的可靠流程 | 必须审批、测试失败最多修两轮、取消后不再跑命令 |

安全约束不能只写在 Skill 文本里：Skill 可以建议，Policy 与状态机负责强制。

### 6.1 Skill 文件结构

```text
.agent/skills/
  react-feature/
    SKILL.md
    examples.md
    checklist.md
  bug-triage/
    SKILL.md
    checklist.md
  test-repair/
    SKILL.md
    examples.md
```

`SKILL.md` 包含：名称、适用场景、输入前提、必须遵守的边界、步骤、成功条件、常见失败与恢复方式、需调用的工具、相关示例。按需加载，不要把所有 Skill 一次性塞进每轮上下文。

### 6.2 选择与版本管理

- 由轻量 Router 按任务类型召回候选；明确的用户指令优先；
- 每个 Skill 带 `id`、`version`、`source`、`content_hash`、`trust_level`；
- 仓库内 Skill 是项目辅助指引而非安全策略；启用外部来源 Skill 前审阅并固定版本；
- Skill 作为可评测资产：维护标准任务与成败案例，验证它是否真的降低步骤错误、修改范围与成本。
