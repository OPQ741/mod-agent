# Agent Loop · 运行时与状态机

> Agent Runtime 是整个系统的节拍器：它推进任务、在该停时停、在可恢复时恢复。本篇定义状态机、核心循环、停止语义与预算防护。

核心结论：Agent 不是一次生成全部结果，而是不断“读取状态 → 选择下一步 → 执行动作 → 记录结果”，直到任务完成、被取消或达到预算上限。本页定义这条循环的状态与停止条件。

## 1. 任务状态机

顶层状态：

- `queued` 已入队等待执行；
- `initializing` 检查权限、Git 状态、工作区与运行环境；
- `exploring` 分析项目与需求上下文；
- `planning` 生成并校验执行计划；
- `awaiting_approval` 等待人对计划 / 工具 / 高风险操作确认；
- `executing` 读 / 改文件、跑命令与工具；
- `validating` 运行类型检查、lint、测试、构建；
- `repairing` 分析验证失败并进行有限次数修复；
- `paused` 用户暂停或等待人工输入；
- `cancelling` 正在停止 Worker 与子进程；
- `completed` 成功完成并生成交付摘要；
- `failed` 无法完成，保留现场与错误摘要；
- `cancelled` 已取消；
- `expired` 超过最长任务时间或资源预算。

状态只能通过 Orchestrator 的显式转换函数修改。每次转换都在一个事务里同时更新状态并追加事件，避免出现界面显示已完成、库里仍是执行中的不一致。

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> initializing
    initializing --> exploring
    exploring --> planning
    planning --> awaiting_approval: 策略要求确认
    planning --> executing: 允许直接执行
    awaiting_approval --> executing: 批准
    awaiting_approval --> paused: 延后
    awaiting_approval --> cancelled: 拒绝/取消
    executing --> validating: 代码变更完成
    executing --> awaiting_approval: 高风险工具
    validating --> repairing: 检查失败且可修复
    repairing --> validating: 重新验证
    validating --> completed: 验收通过
    validating --> failed: 超预算或不可恢复
    exploring --> paused
    executing --> paused
    validating --> paused
    paused --> queued: 恢复调度
    queued --> cancelling
    executing --> cancelling
    validating --> cancelling
    repairing --> cancelling
    cancelling --> cancelled
    completed --> [*]
    failed --> [*]
    cancelled --> [*]
```

### 1.1 进入主循环之前：启动管线（真实 Claude Code 证据）

任务状态机从 `queued` 进入 `initializing`，到主循环第一次转起来，真实 Claude Code 拆成约 9 个阶段、冷启动约 235ms 完成。CLI 对启动延迟很敏感，顺序大致是：

```mermaid
flowchart LR
    A["1 解析参数<br/>入口/工作模式"] --> B["2 加载配置<br/>settings 合并"]
    B --> C["3 工作区信任<br/>确认目录可跑"]
    C --> D["4 模型/凭证就绪<br/>Provider 初始化"]
    D --> E["5 加载规则<br/>CLAUDE.md/AGENTS"]
    E --> F["6 工具注册<br/>含 MCP/延迟加载"]
    F --> G["7 Hooks 就绪<br/>事件管线"]
    G --> H["8 上下文装配<br/>系统提示词"]
    H --> I["9 进入主循环<br/>首次 query"]
```

几条值得 mod-agent 照抄的启动纪律：

- **重依赖按需 `await import()`**：MCP/遥测/协议 exporter 这类只有用到才加载的模块不进启动路径，以缩短冷启动；
- **信任检查放在所有自动发现之前**：先确认目录可信，再加载规则、MCP、hooks，避免仓库里一份 `.mcp.json` 在未信任目录下被静默执行；
- **配置合并分层**：默认 → 组织级 → 项目级 → 命令行，后者覆盖前者；
- 启动阶段的异常（凭证缺失、配置非法、工作区冲突）快速失败并给出可操作提示，而不是拖到主循环才报错。

## 2. 核心 Agent Loop

整个循环就四步：模型提议动作 → 运行时校验并执行 → 结果回灌上下文 → 判断是否完成。

```ts
async function runTask(taskId: string): Promise<void> {
  let state = await store.loadTaskState(taskId)

  while (!isTerminal(state.status)) {
    await control.assertNotCancelled(taskId)
    budget.assertWithinLimits(state.budget)

    const context = await contextBuilder.build(state)
    const decision = await modelGateway.nextAction(context)
    const parsed = decisionSchema.parse(decision) // Zod 校验

    if (parsed.type === "final") {
      const report = await delivery.verifyAndBuildReport(state, parsed)
      await store.completeTask(taskId, report)
      return
    }

    const tool = toolRegistry.get(parsed.toolName)
    const permit = await policy.evaluate({ task: state, tool, args: parsed.args })
    if (permit.kind === "approval_required") {
      await store.pauseForApproval(taskId, permit.request)
      return // 审批后由调度恢复，不阻塞等待
    }

    const result = await toolExecutor.execute({
      task: state,
      tool,
      args: parsed.args,
      timeoutMs: permit.timeoutMs,
    })
    state = await store.appendToolResultAndCheckpoint(taskId, result)
    state = await progressGuard.evaluate(state, result)
  }
}
```

循环要点：

1. 每轮从持久层加载最新状态与检查点，检查取消标记、截止时间、token / 费用 / 步数预算；
2. 上下文 = 用户需求 + 项目规则 + 当前计划 + 最近工具结果 + 相关代码片段 + 当前 diff + 剩余预算；
3. 每个工具调用依次过：Schema → 权限 → 参数范围 → 路径边界 → 命令策略 → 审批 → 幂等 → 超时；
4. 需审批时保存审批请求与检查点后释放执行，而不是阻塞线程轮询；
5. 执行前记录调用，完成后保存结果 / 退出码 / 耗时 / 产物引用；
6. 检测文件变化、重复失败、无进展循环；必要时把失败压缩为诊断信息重新规划；
7. 达到交付条件后，做最终 diff / 权限 / 测试检查，生成结构化交付报告。

上面的伪代码还需要补：Worker 租约、并发重复投递、幂等键、AbortSignal、子进程清理、数据库事务。

下面这张图把一轮循环的实际走向画出来：

```mermaid
flowchart TD
    S["从持久层加载 task 状态 + 检查点"] --> G{"取消? 预算超限?"}
    G -- 是 --> X["停止循环 / 进入 cancelled 或 expired"]
    G -- 否 --> C["装配本轮上下文（需求+规则+计划+最近工具结果）"]
    C --> M["模型给出下一步 decision"]
    M --> D{"decision 是 final?"}
    D -- 是 --> R["出交付报告，completeTask"]
    D -- 否 --> P["过权限 policy"]
    P --> A{"需要审批?"}
    A -- 是 --> H["存审批请求 + 检查点，暂停（不阻塞线程）"]
    A -- 否 --> E["沙箱内执行工具，记 timeoutMs"]
    E --> N["回灌裁剪后结果，存检查点"]
    N --> F["progressGuard：是否无进展 / 重复"]
    F --> S
```

模型不直接动手。每一轮都由运行时把关：先查还能不能跑，再攒上下文，让模型拿主意，过权限关，能自动执行就执行、要问人就先存盘退出。任一步被叫停时，那个位置已经存了检查点，下次从原地继续。

比如，任务是给登录接口加超时处理。模型第一轮读完 auth.ts，想直接 `sed` 改文件。这属于写操作，policy 判 `approval_required`，于是循环存下审批请求、把任务挂到 `awaiting_approval` 就退出了，而不是阻塞等待用户点确认。用户批准后，调度器从同一检查点恢复，模型带着已读 auth.ts 的上下文继续，不用从头再读一遍。

### 2.1 「继续还是停」不止一条判断

最小实现里，循环的判断只有一条：模型这一轮返回了工具调用就继续，否则结束。生产级运行时要把"为什么要再转一圈"分得更细。逆向 Claude Code 的运行时可以看到，它把继续循环的原因分成约七类（参考 [claude-code-from-scratch · Agent Loop](https://diwang.info/claude-code-from-scratch/#/docs/01-agent-loop)）：

| #   | 继续原因       | 触发情形                              | 处理                               |
| --- | -------------- | ------------------------------------- | ---------------------------------- |
| 1   | 模型调用了工具 | 响应含 tool_use                       | 执行工具、回灌结果、继续           |
| 2   | 折叠后重试     | 上下文超限且暂存了可折叠的旧操作      | 提交折叠腾空间后重试               |
| 3   | 强制压缩后重试 | 折叠空间仍不够                        | 触发全量摘要压缩后重试             |
| 4   | 输出截断升级   | 到达输出 token 上限（第一次）         | 升到更高输出上限（如 16K→64K）重试 |
| 5   | 截断续写       | 升级已用尽仍被截断                    | 注入续写提示，最多重试约 3 次      |
| 6   | Stop Hook 拦截 | 模型认为做完了，但 Stop Hook 要求继续 | 执行 Hook 后继续循环               |
| 7   | 预算续跑       | 服务端侧生成预算耗尽但任务未竟        | 续接生成                           |

这些大多属于可恢复的边界情况。成熟运行时的做法是先把这类错误留在循环内部、尝试自恢复，成功则用户无感，失败才最终抛出，而不是一遇到截断或超长就把错误抛到界面上。

### 2.2 两层循环与异步背压

对应上表，成熟运行时倾向把一层 while 拆成两层：

- **外层（任务 / 查询生命周期）**：管用户输入、token 与费用预算、会话恢复；
- **内层（单次查询）**：管上下文压缩、模型调用、工具执行、错误恢复。

内层常实现为异步生成器（`async function*`）。好处有两个：一是天然背压，消费端（TUI）没处理完，生产端就不继续产生事件，不会堆积；二是所有分支都能用普通的 `continue` / `break` 表达，不必手写状态机。中断用一个贯穿全程的 `AbortController`，`abort()` 后在检查点退出，连在飞的网络请求一并取消。

### 2.3 工具错误是「数据」，不是异常：最轻的自修复

工具层的任何失败，比如模型编出一个不存在的工具名、`edit_file` 的待替换串没找到、命令退出码非零、权限被拒，都不要抛异常中断循环，而是转成一条带 `is_error: true` 的 `tool_result` 正常回喂给模型：

```text
{ role: "user", content: [{ type: "tool_result", tool_use_id: "...", is_error: true,
  content: "Error: old_string not found in auth.ts. Re-read the file first." }] }
```

模型看到错误后通常会自己纠正：重新读文件、修正参数、换一条命令。这是成本最低的自修复。默认分支返回 `Unknown tool: xxx` 而不是抛错，目的就是让模型有机会纠正自己编造的工具名。

注意别和 [verification-and-multiagent.md](./verification-and-multiagent.md) 里的 Repair Loop 搞混，两者不是一回事：

- **错误回喂（本篇）**：单步、即时，工具一报错，模型下一轮顺手改对；
- **Repair Loop**：多步、跨阶段，验证流水线跑完、测试失败后，带着错误分类和诊断重新规划，改完再验。

权限被拒同理：把 `User denied this action.` 作为工具结果返回，模型会换方案，而不是崩溃或反复硬闯。

### 2.4 流式窗口里提前执行工具

一次模型响应通常有 5–30 秒的流式生成窗口。运行时不必等整段响应结束才执行工具：当某个 `tool_use` 的参数 JSON 在流中拼完整（Anthropic 的 `content_block_stop` 事件）时，若该工具只读、并发安全且权限已放行，就立刻启动执行，把工具耗时藏进模型继续生成的窗口里，多个只读工具自然并行。写操作和命令执行不在此列，必须等响应完整、权限确认后再跑。具体事件与双后端差异见 [tools-and-extensions.md §2.4](./tools-and-extensions.md#_2-4-并行工具执行) 与 [model-gateway.md](./model-gateway.md)。

### 2.5 消息队列 vs 中断：两条不同的分支

出处：Claude Code `interactive-mode.md`、`agent-sdk/streaming-vs-single-mode.md` v2.1.300 实证。Agent 在跑的时候，用户完全可以继续打字。成熟运行时必须区分"你想让我立刻停"与"你想让我下一轮再看"这两件事，它们的实现路径完全不同：

| 用户动作     | 语义                             | 运行时处理                                                           |
| ------------ | -------------------------------- | -------------------------------------------------------------------- |
| `Enter` 提交 | 排队：下一条消息在 turn 边界注入 | 消息进队列，当前 turn 继续；turn 结束前不 abort，按序冲刷到下一轮    |
| `Ctrl+Enter` | 立刻发送（打断当前 turn）        | 触发 `AbortController`、在检查点退出，然后按新输入重启 turn          |
| `Esc`        | 中断当前生成，保留已完成的工作   | 停止流式、落 checkpoint，把已完成的部分作为 observation 回灌而非丢弃 |

对应到 SDK 契约，用户消息带一个 `priority: "now" | "next" | "later"` 三档（出处：https://code.claude.com/docs/en/interactive-mode 、https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode ）：`now` 立即打断、`next` 排队到本 turn 结束、`later` 排队到主循环空闲时。TUI 必须让这两个动作有清晰的键位分离，不能像早期 CLI 那样只做一个"中断"按钮。

对 mod-agent：主循环 `runTask` 的伪代码在 §2 只处理"取消 vs 预算撞线"两条退出路径，没写"用户新消息进入"这一支。实现时必须补一条 `pendingUserMessages: Queue<{ text, priority }>`，`priority: now` 走 abort + 重启，其他走 turn 边界注入。审批对话框的 Tab 附加评论（见 [usage.md §5](./usage.md)）也是这条队列的一部分，它是"用户对这次决策的上下文说明"，不是新的 prompt。

### 2.6 Channels：把外部事件推入主循环

出处：Claude Code `channels.md`、`channels-reference.md` v2.1.300 实证（https://code.claude.com/docs/en/channels ）。真实 Claude Code 支持通过一个 MCP server 把外部事件（CI 结果、chat 消息、监控告警、webhook）主动推入一个正在跑的会话。这不是新造一套队列，是**上面那条 `pendingUserMessages` 队列的第二种生产者**：

| 生产者       | 事件类型               | 语义                                                                              |
| ------------ | ---------------------- | --------------------------------------------------------------------------------- |
| 用户输入     | `user-message`         | 携带用户权威，可以直接改预算、批准动作                                            |
| Channels     | `channel-notification` | **不携带用户权威**，与 teammate 消息同级（[agent-teams.md §4](./agent-teams.md)） |
| 后台子 agent | `task-notification`    | 与 §5.1 会话恢复语义挂钩，是"派出去的东西回来了"                                  |
| 定时器       | `cron-fire`            | 与 [autonomy.md §2.4](./autonomy.md) `CronCreate` 是同一批                        |

统一实现是一处 `pendingExternalEvents: Queue<{ origin, kind, payload, priority }>`：主循环每轮结束、下一轮开始前按 `priority` 冲刷注入。四类生产者共用同一队列、同一注入路径，避免"CI 回调走一条通道、用户输入走另一条通道、子 agent 通知又走第三条"这种分散的状态机。

三条硬约束：

- **Channels 事件不能借道绕过权限判定**。CI 推来一条"帮我把这个 PR merge 了"看起来像消息、其实只是不可信输入，policy 层按普通工具调用判，deny 与 bypass-immune 规则照常生效。这条与 reasoning-blind（[autonomy.md §3.7](./autonomy.md)）对称：任何"非用户本人当面点的头"，一律不携带用户权威；
- **事件源要显式声明能力位**。真实 Claude Code 的 `channels-reference` 里，server 连上来第一件事就是宣告它打算推哪几类事件（`declares: ["ci-result", "chat-message"]`），未宣告类型到达时丢弃。mod-agent 对应 `ChannelServerRegistration.declaredEvents[]`，主循环按类型分派 handler，未注册的 kind 落 `task.warning` 事件而不是崩溃；
- **回信通道是可选的**。CI 类只要单向推入即可，chat 类可能要"agent 回一句话给原始渠道"。真实实现提供一个 `PushNotification` 工具让模型主动回信，未宣告 `canReply: true` 的 server 拿不到它。mod-agent 落地把 `canReply` 作为 channel 注册的一个能力位、和 `declaredEvents` 一起决定运行时暴露给模型的工具子集。

Phase 归属：MVP 只做 `user-message` + `task-notification` + `cron-fire` 三类生产者（前两类已经覆盖主循环，第三类由 [autonomy.md](./autonomy.md) `/loop` 提供）。Channels（外部事件驱动）留到 Phase 5 团队与企业能力，与 Artifact、Web 控制台同期。

## 3. 分层循环

- **主循环（任务级）**：上面的 `runTask`，负责中断 / 恢复 / 预算；
- **子循环（步骤级）**：改文件 → 跑测试 → 修复这类 Repair Loop，见 [verification-and-multiagent.md](./verification-and-multiagent.md)；
- **工具循环**：单个工具调用内部的重试 / 幂等处理。

### 3.1 规划与执行的双循环（业界实证）

长任务里长远规划和眼前执行是两件事，成熟产品普遍拆成两个循环：

- **Cline 的 Plan / Act 双模式**（出处：https://docs.cline.bot/core-workflows/plan-and-act ）：Plan 模式在运行时拿不到写工具，只能读 / 搜索 / 讨论；切到 Act 模式时对话上下文完整继承，不用重述。规划和执行可以绑不同模型，规划用强推理模型、执行用低成本快模型；
- **Windsurf 的后台规划 agent**（出处：https://docs.windsurf.com/windsurf/cascade/cascade ）：一个专职规划 agent 在后台持续修订长期计划，当前模型只按计划做短动作，执行中发现新信息自动回写计划，并维护一份可人工查看 / 修改的 Todo 列表。计划不是开跑前写死的；
- **Factory `--use-spec` / Replit Plan mode**（出处：https://docs.factory.ai/droid-cli/cli-reference.md 、https://docs.replit.com/replitai/agent ）：复杂任务先进 spec / 任务清单模式产出计划供人确认，再进入执行。

对 mod-agent，建议按任务规模分级：小任务直接执行；中任务 plan → edit；大任务走"后台规划 agent + 可人工编辑的计划产物 + 动态 replan"的结构，规划产物随上下文推进动态调整。

### 3.2 Plan Mode 的落地：只读契约 + 计划文件 + 审批四选项

规划模式靠的不是在提示词里叮嘱模型先别动手，而是在运行时直接把写权限收回来。机制由四部分组成：

1. **一对进入 / 退出工具**：`enter_plan_mode`、`exit_plan_mode`。这两个工具不常用，做**延迟加载**（平时不占 schema，需要时再激活，见 [tools-and-extensions.md](./tools-and-extensions.md)）；
2. **只读契约**：进入规划模式后，权限层对所有写 / 编辑 / shell 工具一律返回 `deny`，模型只能读、搜索、分析；
3. **唯一可写的计划文件**：进入时生成一个计划文件（如 `plans/plan-<sessionId>.md`），它是规划模式下唯一被加入写白名单的路径。模型把计划写进这个文件，而不是直接改源码。这复用了 [security.md](./security.md) 的权限判定：规划模式的硬拦截在规则之后、放行之前，优先级高于普通 allow；
4. **退出时的审批四选项**。模型调用 `exit_plan_mode` 提交计划后，由用户决定：

| 选项           | 含义                             | 之后的动作               |
| -------------- | -------------------------------- | ------------------------ |
| 清空计划并执行 | 放弃这份计划、按新的理解直接执行 | 退出规划，重新开工       |
| 按计划执行     | 认可计划                         | 退出规划，按计划逐步执行 |
| 我来手动处理   | 不交给 agent                     | 结束，用户自己改         |
| 继续规划       | 计划还不成熟                     | 留在规划模式，继续打磨   |

计划文件是持久化、可人工编辑的产物（对齐 Windsurf 可查看 / 修改的 Todo）。退出规划模式进入执行后，它仍作为上下文锚点；执行中若发现计划需要调整，可以重新进入规划模式 replan，而不是闷头执行一份过期计划。

## 4. 端到端时序

```mermaid
sequenceDiagram
    actor User as 用户
    participant CLI as CLI/TUI
    participant Plan as Planner
    participant AL as AgentLoop
    participant Tool as 工具层
    participant Sand as 沙箱
    participant Mem as 记忆层
    User->>CLI: 提交需求 / issue
    CLI->>Plan: 请求澄清与计划
    Plan->>Mem: 读 repo map 与 AGENTS.md
    Plan-->>CLI: TaskPlan
    CLI->>User: 请求确认计划
    User-->>CLI: 确认
    loop Agent 核心循环
        AL->>Tool: 发 Action 读文件 / 改代码
        Tool->>Sand: 沙箱内执行
        Sand-->>Tool: 裁剪后 Observation
        Tool-->>AL: 回灌 Observation
        AL->>Mem: 装配上下文并按需压缩
    end
    AL->>Sand: 跑测试与 lint
    Sand-->>AL: VerificationResult
    AL->>CLI: blocker 或完成请求评审
    CLI->>User: Diff 与交付报告
```

有三处容易出问题：一是 Planner 出计划前先取 repo map / AGENTS.md，保证 `filesLikelyAffected` 有依据；二是每次工具调用都走"工具层 → 沙箱 → 裁剪 observation → 回灌"，observation 经 ACI 裁剪，而不是把原始输出塞回模型；三是每轮都重新申请上下文装配（含压缩），这是长任务不跑偏的关键。

## 5. 停止与恢复语义

- **Pause**：不再开始新的工具调用；允许当前安全的只读操作结束，或按策略中断子进程。保存检查点后退出循环。
- **Cancel**：记录取消原因，终止当前命令进程组，阻止新工具调用，清理短期资源。已发生的外部副作用不能假装回滚，须在报告中披露。
- **Resume**：按 `task_id + checkpoint_version` 加载状态，重新校验权限、仓库提交、环境与凭证，不盲目重放旧工具调用。
- **崩溃恢复**：重启后先查上一次工具调用是否已有确定结果，再决定重试，防止重复写入或重复发送外部请求。
- **超时**：分别设置模型请求、单次工具、单条命令、阶段与整个任务的时间上限。

### 5.1 会话（Session）语义：挂起 / 恢复的持久化基准（OpenAI Agents SDK 实证）

对话历史应由会话层统一接管，而不是在主循环里手动拼 list（出处：https://openai.github.io/openai-agents-python/sessions/ ）：

- **run 前**自动检索该 session 的历史并前置拼入输入；**run 后**本轮新产生的条目（用户输入、模型回复、工具调用等）自动落回 session；
- 人审暂停后必须能用**同一 session 原地恢复**。审批通过时从 `interruptions` 加状态对象继续，恢复的是同一份存储的对话历史；
- 历史太长可自动压缩（官方提供 compaction session）；存储后端可插拔（本地 SQLite / 远程 Redis / MongoDB / 加密包装）。

对 mod-agent：`awaiting_approval` / `paused` 状态恢复时，除 `task_id + checkpoint_version` 外，还应校验同一会话历史被完整恢复、审批与参数 hash 绑定，避免恢复后上下文漂移。

### 5.2 权限模式的恢复矩阵

出处：Claude Code `permission-modes.md`、`sessions.md` v2.1.300 实证。会话恢复时权限档位不是"原样还原"，而是按"启动入口 + 是否命中 deny"重算。真实 Claude Code 的行为可以整理成一张矩阵，作为我们 `resume` 语义的验收口径：

| 起点模式            | 终端 `claude --resume`      | VS Code 恢复        | 非交互 `claude -p` 恢复                                                          | picker 里选中恢复 |
| ------------------- | --------------------------- | ------------------- | -------------------------------------------------------------------------------- | ----------------- |
| `default`           | 保持                        | 保持                | 保持                                                                             | 保持              |
| `acceptEdits`       | 保持                        | 保持                | 保持                                                                             | 保持              |
| `plan`              | 保持                        | 保持                | 需同时满足"上次以 plan 结束、未 deny `ExitPlanMode`、`permission.mode` 已持久化" | 保持              |
| `auto`              | 保持（分类器仍生效）        | 保持                | 保持，但不弹框                                                                   | 保持              |
| `dontAsk`           | 保持                        | 保持                | 保持                                                                             | 保持              |
| `bypassPermissions` | 视 managed 与 root 判定重算 | 视 VS Code 独立开关 | 视 CLI 是否传了 `--dangerously-skip-permissions`                                 | 视同终端          |

三条硬规则必须写进我们 `resume` 的判定管线：**deny 掉的动作模式跨恢复不还原**（如上次会话被 `permissions.deny: ["ExitPlanMode"]` 拦下，`plan` 档不会自动续跑）；**高危档不静默继承**（`bypassPermissions` 恢复前必须重新过 root / sudo / `--restricted` / managed kill switch 判定，见 [security.md §4.2](./security.md#_4-2-单次动作的判定管线-fail-closed)）；**auto 分类器与主模型解耦**（分类器是独立模型、独立 API key 池、独立 rate limit，恢复会话时若分类器不可用，回落到 `default` 而不是直接放行）。

## 6. 预算与循环防护

每个任务配置化上限：最大模型轮次、最大工具调用数、最大修改文件数、最大改动行数、单命令超时、验证 / 修复轮次、最长运行时间、总费用。初始值由内部任务集校准，不写死示例值。

出现以下任一情况即停止自动循环并请求人工介入或以部分失败结束：

- 同一命令 / 测试连续重复且无状态变化；
- 连续多轮文件 / 计划 / 验证都无进展；
- 反复重写同一文件；
- 同一错误在设定修复次数后不变；
- 上下文持续膨胀但目标不收敛。

比如，模型连着 4 轮跑同一条 `npm test`，退出码都是 1，报错行几乎没变。这属于同一命令连续重复且无状态变化，系统不再让模型继续空试，而是把这几轮失败压成一段诊断（报错集中在 token 过期，可能不是测试本身的问题）重新规划，别放任它原地空转烧 token。

> 术语备注：**检查点**（checkpoint）指每轮工具执行后，把当前干到哪、改了哪些文件、还剩多少预算落一次盘；**Observation**（观测）指工具跑完回给模型的那段裁剪过的输出；**ACI** 指给模型看的操作界面的设计规范（详见 [context-engineering.md §1.1](./context-engineering.md#_1-1-接口即能力-aci-工具界面设计与-prompt-同等重要)）；**compaction**（压缩）指上下文快满时把长历史总结成摘要。

### 6.1 三层 Guardrail（输入 / 输出 / 工具）（OpenAI Agents SDK 实证）

把安全检查做成与业务 agent 并列的第二套轻量模型，卡三个位置（出处：https://openai.github.io/openai-agents-python/guardrails/ ）：

| 护栏层           | 卡在哪                          | 触发动作                                          |
| ---------------- | ------------------------------- | ------------------------------------------------- |
| Input guardrail  | 链上第一个 agent 收到用户输入时 | tripwire 触发即抛异常中止，agent 不执行           |
| Output guardrail | 产生最终输出的 agent 收尾后     | 拒绝候选输出，已完成的工具调用存入 session 待回放 |
| Tool guardrail   | 每个工具调用前 / 后             | 可跳过调用、替换输出、或抛 tripwire               |

- 执行模式分**并行**（快但可能已烧 token）与**阻塞**（先检查再跑，最省钱）；
- 对 mod-agent：写操作 / 危险命令默认阻塞式先确认；只读 / 可回滚操作可用并行快检。

### 6.2 写操作的确定性护栏（SWE-agent / Kilo 实证）

- **写前校验**：编辑命令触发时先跑 linter，语法不通过则不放行、把错误退给模型（SWE-agent，出处：https://swe-agent.com/latest/background/aci/ ）。这把修正语法从靠模型自觉变成系统强制的前置关卡，更省 token、更少产生脏状态；
- **写后诊断延迟**：一次写操作后、继续下一步前，按可配置延迟（默认 1000ms）等类型检查 / lint 诊断落定再继续（Kilo Code，出处：https://kilo.ai/docs/features/auto-approving-actions ）。复杂项目建议 2000ms 以上，关键代码不建议设为 0，让边改边自修有可靠依据而非凭猜测。

### 6.3 Headless 事件流输出（Claude Code / Gemini CLI 实证）

非交互模式输出三档（出处：https://code.claude.com/docs/en/headless 、https://google-gemini.github.io/gemini-cli/docs/cli/headless.html ）：

| 模式        | 用途                                                                               |
| ----------- | ---------------------------------------------------------------------------------- |
| text        | 默认，人读                                                                         |
| json        | 一次返回 result + session_id + usage + total_cost_usd，可 `--json-schema` 约束结构 |
| stream-json | NDJSON，逐事件实时吐，末行是 result 汇总                                           |

- 退出码即成败：0 成功、非 0 失败，脚本可直接分支。真实 Claude Code 的退出码更细：`0` 正常结束、`1` 出错、`2` 被中止（SIGINT/EOF），另有内部用 `51`（bypass 模式被拒）、`52`（远程/无 TTY 环境问题）等。脚本只需区分 0/非 0。但交互模式用退出码 2 区分人主动打断与真出错，这个约定值得照抄；
- Gemini 的 headless JSON 还带一份用量账：`stats.models[].tokens`（prompt / candidates / total / cached / tool）、`stats.tools`（totalCalls / totalSuccess / totalFail / totalDurationMs / totalDecisions: accept | reject | modify | auto_accept）、`stats.files`（totalLinesAdded / totalLinesRemoved），可以直接拿来做用量记账与工具成功率分析；
- **`--bare` 模式**（CI / 脚本默认推荐，出处同 Claude headless）：跳过一切自动发现（hooks / skills / MCP / 记忆 / 规则文件），不读本机 OAuth 与钥匙串，保证每台机器结果可复现。

这与 [data-and-events.md](./data-and-events.md) 的事件序列天然对应：事件流直接序列化成 stream-json，供 GitHub Action / git hook / 定时任务消费。
