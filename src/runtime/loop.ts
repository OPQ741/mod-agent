/**
 * Agent 主循环（agent-loop.md §2 / development-guide.md §4）。
 *
 * 整个系统**只有一个主循环**（ADR-1）：它是唯一的动力来源。第二个循环一旦绕过它，
 * 暂停、取消、预算三个开关就有半边失效，表现为"用户按了停止，还有命令在跑"。
 *
 * 循环形状是**异步生成器**（agent-loop.md §2.2）：
 * - 天然背压：消费端没处理完，生产端就不继续产生事件；
 * - 所有分支都能用普通的 `continue` / `break` 表达，不必手写状态机；
 * - 中断用一个贯穿全程的 AbortController，abort 后在检查点退出。
 *
 * 四条最容易写错、也最该在这里钉死的纪律：
 * 1. tool_use 与 tool_result 必须配对，格式按后端分别维护；
 * 2. **工具错误是数据不是异常**：转成 `is_error` 的结果回喂，循环不断；
 * 3. 需要审批时**存下请求就退出**，不阻塞线程；批准后由调度器从同一检查点恢复；
 * 4. 每轮结束落检查点，任何一轮都可恢复。
 */

import path from "node:path"
import { promises as fs } from "node:fs"
import type {
  BudgetUsage,
  CommandRequestInput,
  CommandResult,
  Decision,
  PermissionMode,
  TaskEvent,
  TaskMode,
  ToolExecutionContext,
  ToolExecutionResult,
  ValidationReport,
} from "../shared/contracts.js"
import type { Checkpoint, ToolCallStatus } from "../store/types.js"
import {
  DecisionSchema,
  ToolUseDecisionSchema,
  isTerminalStatus,
  normalizeCommandRequest,
  type TaskStatus,
} from "../shared/contracts.js"
import { AppError, toAppError } from "../shared/errors.js"
import { newCallId, newCheckpointId } from "../shared/ids.js"
import { parameterHash, sha256, stableStringify } from "../shared/hash.js"
import type { ContentBlock, ModelMessage, ModelRequest, ModelResponse } from "../model/types.js"
import type { ModelGateway, RetryEvent } from "../model/gateway.js"
import type { Store } from "../store/types.js"
import { updateTaskWithRetry } from "./task-write.js"
import type { ToolExecutor } from "../tools/executor.js"
import type { ToolRegistry } from "../tools/registry.js"
import type { PolicyEngine } from "../policy/engine.js"
import type { PathGuard } from "../policy/pathguard.js"
import type { EditEngine } from "../patch/edit.js"
import type { Settings } from "../config/settings.js"
import type { Logger, Metrics } from "../observability/logger.js"
import { assertWithinBudget, budgetPressure } from "./budget.js"
import { ProgressGuard, fingerprintResult } from "./progress.js"
import { assertTransition } from "./state-machine.js"
import { compact, dedupeMessages } from "../context/compaction.js"
import type { ValidationCheck } from "../validation/runner.js"
import {
  VALIDATION_TIMEOUT_MS,
  runChecks,
  mapAcceptance,
  summarizeReport,
} from "../validation/runner.js"
import { diffText, summarize } from "../patch/diff.js"

export interface LoopDeps {
  store: Store
  registry: ToolRegistry
  executor: ToolExecutor
  gateway: ModelGateway
  policy: PolicyEngine
  pathGuard: PathGuard
  editEngine: EditEngine
  settings: Settings
  logger: Logger
  metrics: Metrics
  /** 命令运行器（沙箱注入）。 */
  runCommand: (req: CommandRequestInput) => Promise<CommandResult>
  /**
   * 计划模式是否处于激活状态。
   *
   * 计划模式**不是一个 flag 摆设**：激活期间本轮装配工具时按 `taskMode: "plan"`
   * 过滤，写工具与命令工具根本不会出现在下发的 schema 里（模型请求不到的工具，
   * 才真的请求不到），策略判定也按 plan 档兜一层。
   * 之前这里只留了一个 `planFilePath`，`enter()` 记个路径就算"进入了"，
   * 写工具照样可用、文件照样被写 —— 而工具描述在告诉模型"写工具已不可用"。
   */
  isPlanModeActive?: () => boolean
  now?: () => Date
}

export interface LoopOptions {
  taskId: string
  mode: TaskMode
  permissionMode: PermissionMode
  systemPrompt: string
  /** 动态上下文（每轮重新生成）。 */
  dynamicContext: (round: number) => string
  signal?: AbortSignal
  /** 验收条件，用于交付报告的 acceptance 映射。 */
  acceptanceCriteria?: ReadonlyArray<{ id: string; description: string }>
  /** 交付前的验证命令（省略则跳过验证，并在报告里明确标注）。 */
  validationChecks?: readonly ValidationCheck[]
  /** 是否开启压缩。 */
  compactionEnabled?: boolean
  /**
   * 仓库规则（AGENTS.md / CLAUDE.md 等）的合并文本。
   *
   * 必须由这里在**种子消息**里拼进去，而不是调用方先往 store 里写一条 ——
   * 后者会让 `isFreshTask`（按 `state.messages.length === 0` 判断）变成 false，
   * 于是用户请求永远不会被 seed，模型只看到规则、不知道要做什么。
   */
  projectRules?: string
}

export interface LoopOutcome {
  status: TaskStatus
  /** 终止原因枚举（data-and-events.md §1.2 第 3 条：终止原因是枚举，不是布尔）。 */
  subtype:
    | "success"
    | "error_max_turns"
    | "error_during_execution"
    | "error_max_budget_usd"
    | "error_no_progress"
    | "approval_required"
    | "cancelled"
  summary?: string
  turns: number
  /** 本轮被拒清单（data-and-events.md §1.3 ③）。 */
  permissionDenials: Array<{ toolName: string; reason: string }>
  validation?: ValidationReport
  changedFiles: string[]
}

/** 本轮要执行的一次工具调用（已补齐 id、已通过字段校验）。 */
interface PreparedCall {
  callId: string
  toolName: string
  args: Record<string, unknown>
  /** 模型给的参数不是合法 JSON 时的原因；有值则不执行。 */
  argsParseError?: string
}

/** 单轮输出被截断时最多续写几次（超过就是"写不完"，要交给人）。 */
const MAX_TRUNCATION_RECOVERIES = 3

/** 截断续写指令：明确说"接着写"，避免模型重新生成整段。 */
const OUTPUT_TRUNCATED_CONTINUE =
  "[output-truncated] Your previous message was cut off by the output token limit " +
  "(stop_reason: max_tokens). Continue from exactly where it stopped — do not restart " +
  "the whole answer and do not summarize what you already wrote. " +
  "If the remaining work does not fit in one response, reply with a tool call that splits it."

/**
 * 流式增量的合并阈值。
 *
 * 每个 token 发一条事件会让事件表按 token 数量膨胀（一轮回答上千行），
 * 而事件是**落库**的，不是只往终端打。所以按"字符数或 chunk 数"攒一攒再发：
 * 首屏延迟最多几十毫秒，落库量降到几十条。
 */
const DELTA_FLUSH_CHARS = 160
const DELTA_FLUSH_CHUNKS = 8

/* ------------------------------------------------------------------ *
 * 事件输出
 * ------------------------------------------------------------------ */

class EventSink {
  private seq: number
  constructor(
    private readonly store: Store,
    private readonly taskId: string,
    startSeq: number,
  ) {
    this.seq = startSeq
  }

  async emit(
    type: TaskEvent["type"],
    payload: unknown,
    parentCallId?: string | null,
  ): Promise<TaskEvent> {
    this.seq += 1
    const event: TaskEvent = {
      eventId: `${this.taskId}:${this.seq}`,
      taskId: this.taskId,
      seq: this.seq,
      type,
      timestamp: new Date().toISOString(),
      payload,
      parentCallId: parentCallId ?? null,
    }
    await this.store.appendEvents(this.taskId, [event])
    return event
  }

  get currentSeq(): number {
    return this.seq
  }
}

/* ------------------------------------------------------------------ *
 * 主循环
 * ------------------------------------------------------------------ */

/**
 * 推进一次任务。返回 async generator，逐条产出事件。
 *
 * 调用方（CLI / SDK / TUI）消费这个生成器；不消费就不会继续跑，这是背压的来源。
 */
export async function* runTask(
  deps: LoopDeps,
  options: LoopOptions,
): AsyncGenerator<TaskEvent, LoopOutcome, void> {
  const now = deps.now ?? (() => new Date())
  const state = await deps.store.getTask(options.taskId)
  if (!state) throw new AppError("INVALID_INPUT", `Task not found: ${options.taskId}`)

  const events = await deps.store.readAllEvents(options.taskId)
  const sink = new EventSink(deps.store, options.taskId, events.length)

  const usage: BudgetUsage = { ...state.usage, startedAt: state.usage.startedAt || now().getTime() }
  const progressGuard = new ProgressGuard({ maxNoProgressRounds: state.budget.maxNoProgressRounds })
  const permissionDenials: Array<{ toolName: string; reason: string }> = []
  /**
   * 已改动文件集合。
   *
   * 恢复时要从**上一个检查点**继承：否则 `--resume` 续跑完成后，交付报告里的
   * changedFiles 只剩这一段新改的文件，审批前那几轮的改动凭空消失 ——
   * 而"改了哪些文件"正是人判断是否接受这次交付的第一依据。
   */
  const resumedCheckpoint = await deps.store.latestCheckpoint(options.taskId)
  const changedFiles = new Set<string>(resumedCheckpoint?.changedFiles ?? [])
  /** 已发过 file.changed 事件的文件，避免恢复后重复播报。 */
  const emittedChangedFiles = new Set<string>(resumedCheckpoint?.changedFiles ?? [])
  const isFreshTask = state.messages.length === 0
  /**
   * 轮次从**库里已用的轮次**接着数，不是从 0 开始。
   *
   * 之前是 `let turns = 0` + `usage.rounds = turns`，于是每次 `--resume` 都把
   * 累计轮次清零：历史跑了 10 轮、续跑 2 轮，落库的 `rounds` 是 2。
   * `maxRounds` 是最基本的成本护栏，可被反复 resume 无限绕过。
   */
  let turns = state.usage.rounds
  /**
   * 输出截断的续写次数。
   *
   * 续写是恢复手段，不是无限续杯：真出现"每轮都被截断"时，说明单轮产出
   * 已经系统性超过上限（模型在写大段内容），继续续写只会烧钱不推进，
   * 必须停下来让人处理。
   */
  let truncationRecoveries = 0
  const messages: ModelMessage[] = isFreshTask
    ? await seedMessages(deps, options, state.userRequest)
    : [...state.messages]

  /**
   * 修补"只有 tool_use、没有 tool_result"的历史。
   *
   * 进程在"assistant 已落库、结果还没落库"之间被杀时会留下这种历史，
   * 而两家后端都要求 tool_use 必须配对 —— 不修的话恢复后第一次请求就 400，
   * 任务永远续不起来。这里补的是**失败结果**，不是假装执行过：
   * 模型看到"这次调用没有拿到结果"，会自己决定重试还是换路。
   *
   * 修补可能改动已落库的那条消息，所以下面用 `replaceMessages` 整体回写，
   * 而不是走增量 append。
   */
  const repairedDangling = !isFreshTask && closeDanglingToolUses(messages)
  if (repairedDangling) {
    deps.logger.warn("loop.dangling_tool_use_repaired", { taskId: options.taskId })
  }

  /**
   * 消息落库水位线：只把**新增**的消息 append 进 store。
   *
   * 之前是按 `slice(-1)` / `slice(-2)` 追加，两个后果：
   * ① final 分支会把上一轮的 tool_result 再写一遍（历史里出现重复消息）；
   * ② 首轮 seed 出来的用户请求从未落库 —— 恢复时上下文里没有"用户要什么"，
   *    这是最要命的一种丢数据，因为它只在恢复路径上暴露。
   *
   * 用"已落库条数"做水位线，增量部分才写。关键是初始值：
   * 新任务的水位线必须是 0（种子消息还没进库），恢复时才是 messages.length。
   * 两者都写成 messages.length 的话，首轮那次 flush 会被 `<=` 判空跳过，
   * 于是"用户到底要什么"永远只存在于内存里 —— 审批后 --resume 就丢了。
   */
  let persisted = isFreshTask ? 0 : messages.length
  const flushMessages = async (): Promise<void> => {
    if (messages.length <= persisted) return
    const pending = messages.slice(persisted)
    await deps.store.appendMessages(options.taskId, pending)
    persisted = messages.length
  }
  if (repairedDangling) {
    // 修补动的是已落库的那条消息，append 补不上，必须整体回写
    await deps.store.replaceMessages(options.taskId, messages)
  }
  // 恢复场景下 store 里已有历史；全新任务要把种子消息也补写进去
  await flushMessages()

  const finish = async (
    status: TaskStatus,
    subtype: LoopOutcome["subtype"],
    summary?: string,
    validation?: ValidationReport,
  ): Promise<{ outcome: LoopOutcome; event?: TaskEvent }> => {
    // 任何离开循环的路径都要先把消息落库，否则最后一步的思考在恢复时丢失
    await flushMessages()
    /**
     * 版本号必须**现读**：`state` 是循环开始时的快照，中途"queued → executing"
     * 那次转换已经把 stateVersion 加过一了。拿旧版本号去写终态必然撞乐观锁，
     * 表现为任务其实跑完了、库里状态还停在 executing（恢复时会再跑一遍）。
     */
    const latest = await deps.store.getTask(options.taskId)
    const from = latest?.status ?? state.status
    let event: TaskEvent | undefined
    if (latest && assertSafeTransition(from, status)) {
      /**
       * 用重试写入而不是裸 `updateTask`：从上面 `getTask` 到这里之间，
       * 「取消/暂停」可能刚好落库。裸 CAS 会抛 `VersionConflictError`，
       * 而它是普通 Error，`toAppError` 兜不住 —— 直接把生成器掀翻。
       *
       * 守卫同样关键：重读时若当前状态已不允许转到目标（典型是别人先写了
       * `cancelling`，而这里想写 `completed`），就**放弃写入**。
       * 用户取消优先于收尾：把取消覆盖成"成功交付"比冲突本身更糟。
       */
      const written = await updateTaskWithRetry(
        deps.store,
        options.taskId,
        { status, usage },
        { stopIf: (current) => !assertSafeTransition(current.status, status) },
      )
      if (written.applied) {
        event = await sink.emit("task.status_changed", { from, to: status, subtype })
      } else {
        deps.logger.warn("task.finish_write_abandoned", {
          taskId: options.taskId,
          attempted: status,
          actual: written.state.status,
          reason: written.reason,
          conflicts: written.conflicts,
        })
        /**
         * 库已经被外部推进到 `cancelling`：以**库**为准，把终态也收成 `cancelled`。
         *
         * 否则会出现"内存返回 completed、库里停在 cancelling"的双重真相：
         * CLI 报成功、`--continue` 却认为任务还没结束。`cancelling → cancelled`
         * 是合法转换，再走一次 `finish` 就能收敛，且只递归一层。
         */
        if (written.state.status === "cancelling") {
          return finish("cancelled", "cancelled", "Cancelled while finishing the task", validation)
        }
      }
    } else if (latest && from !== status) {
      /**
       * 拒绝转换必须留下痕迹。
       *
       * 之前这里是静默跳过：`executing → cancelled` 不在迁移表里（要经 `cancelling`），
       * 于是内存里的 outcome 说 cancelled、库里却永远停在 executing ——
       * 任务看起来"还在跑"，`--continue` 还会把它当成可恢复任务重新跑一遍。
       * 静默的失败比崩溃更难查，所以这里至少留下一条可诊断的告警。
       */
      deps.logger.warn("task.status_transition_refused", {
        taskId: options.taskId,
        from,
        to: status,
      })
    }
    const outcome: LoopOutcome = {
      status,
      subtype,
      ...(summary ? { summary } : {}),
      turns,
      permissionDenials,
      ...(validation ? { validation } : {}),
      changedFiles: [...changedFiles],
    }
    return event ? { outcome, event } : { outcome }
  }

  // 进入执行态
  if (!isTerminalStatus(state.status) && state.status !== "executing") {
    yield await sink.emit("task.status_changed", { from: state.status, to: "executing" })
    /**
     * `state` 是循环开始时的快照，版本号可能已经旧了（创建与开跑之间还有一次写入）。
     * 用重试写入，避免"刚开跑就撞乐观锁"表现为任务卡在 queued。
     *
     * 守卫只看**终态与 cancelling**，不套用完整迁移表：`queued → executing`
     * 这条真实路径本来就不在表里（任务创建后直接开跑，不经过 initializing），
     * 用迁移表做守卫会把每个任务都挡在 queued。
     */
    await updateTaskWithRetry(
      deps.store,
      options.taskId,
      { status: "executing" },
      {
        stopIf: (current) => isTerminalStatus(current.status) || current.status === "cancelling",
      },
    )
  }

  let currentStatus: TaskStatus = "executing"

  /**
   * 显式状态迁移。
   *
   * 迁移必须走这里而不是直接 `updateTask`：版本号要**现读**，非法转换要**静默跳过**
   * 而不是把循环掀翻（状态机的作用是兜住乱跑的任务，不是给循环加一个新的崩溃点）。
   */
  // 返回事件由调用方 yield：异步闭包里不能 yield，否则控制权根本交不出去
  const moveTo = async (to: TaskStatus): Promise<TaskEvent | undefined> => {
    const latest = await deps.store.getTask(options.taskId)
    if (!latest || latest.status === to) return undefined
    if (!assertSafeTransition(latest.status, to)) return undefined
    const written = await updateTaskWithRetry(
      deps.store,
      options.taskId,
      { status: to, usage },
      // 重读后若已不允许转到 `to`（例如中途被取消），放弃而不是硬写
      { stopIf: (current) => !assertSafeTransition(current.status, to) },
    )
    if (!written.applied) {
      deps.logger.warn("task.transition_abandoned", {
        taskId: options.taskId,
        attempted: to,
        actual: written.state.status,
        reason: written.reason,
      })
      return undefined
    }
    currentStatus = to
    return sink.emit("task.status_changed", { from: latest.status, to })
  }

  /**
   * 本轮生效的任务模式。
   *
   * 计划模式**不是任务创建时的一个静态属性**：模型可以在任务中途
   * `plan.enter_plan_mode`，那一刻起本轮的装配就必须按只读档过滤。
   * 之前计划模式只往 map 里存了个文件路径，装配照旧按 `options.mode`，
   * 于是写工具一直可用 —— 而工具描述在告诉模型"写工具已不可用"。
   */
  const effectiveTaskMode = (): TaskMode =>
    options.mode === "plan" || deps.isPlanModeActive?.() === true ? "plan" : options.mode

  while (!isTerminalStatus(currentStatus)) {
    /* ---- ① 取消与预算 ---- */
    if (options.signal?.aborted) {
      yield await sink.emit("task.warning", {
        reason: "cancelled",
        message: "Abort signal received",
      })
      // 状态机里 `executing` 等运行态只能经 `cancelling` 到 `cancelled`；
      // 跳过中间态会让终态写不进库（见 finish 里的告警）。
      const toCancelling = await moveTo("cancelling")
      if (toCancelling) yield toCancelling
      const settled = await finish("cancelled", "cancelled", "Cancelled by user or caller")
      if (settled.event) yield settled.event
      return settled.outcome
    }
    const latest = await deps.store.getTask(options.taskId)
    if (latest?.cancelRequestedAt) {
      const toCancelling = await moveTo("cancelling")
      if (toCancelling) yield toCancelling
      const settled = await finish("cancelled", "cancelled", "Cancel was requested")
      if (settled.event) yield settled.event
      return settled.outcome
    }

    try {
      assertWithinBudget(state.budget, usage, now().getTime())
    } catch (err) {
      const appError = toAppError(err, "BUDGET_EXCEEDED")
      yield await sink.emit("task.failed", { code: appError.code, message: appError.message })
      const settled = await finish(
        appError.code === "BUDGET_EXCEEDED" && usage.costUsd >= state.budget.maxCostUsd
          ? "failed"
          : "expired",
        usage.costUsd >= state.budget.maxCostUsd ? "error_max_budget_usd" : "error_max_turns",
        appError.message,
      )
      if (settled.event) yield settled.event
      return settled.outcome
    }

    /* ---- ② 上下文装配（含压缩） ---- */
    const assembled = deps.registry.assemble({
      taskMode: effectiveTaskMode(),
      permissionMode: options.permissionMode,
    })
    const contextMessages: ModelMessage[] = [
      { role: "system", content: options.systemPrompt },
      { role: "user", content: options.dynamicContext(turns + 1) },
      ...messages,
    ]

    let sentMessages = contextMessages
    if (options.compactionEnabled !== false) {
      const compacted = await compact(dedupeMessages(contextMessages), {
        contextWindowTokens: deps.settings.limits.contextWindowTokens,
        threshold: deps.settings.limits.compactionThreshold,
      })
      if (compacted.compacted) {
        // 压缩前后各发一条事件（development-guide.md §9.6）
        yield await sink.emit("task.warning", {
          reason: "context_compacted",
          beforeTokens: compacted.beforeTokens,
          afterTokens: compacted.afterTokens,
          folded: compacted.folded,
        })
        sentMessages = compacted.messages
        deps.metrics.increment("context.compaction")
      }
    }

    /* ---- ③ 模型决策 ---- */
    turns += 1
    usage.rounds = turns
    /**
     * 退避重试是**可观测事件**，不是只进日志的内部细节。
     *
     * `retry.api` 在契约里挂了很久却从未 emit：恢复时"据此判断退避时长"
     * 那条注释等于没有依据。这里把网关的 `onRetry` 收进缓冲，
     * 请求结束后按序补发 —— 退避期间生成器正在 await，发不出去；
     * 但事件流里必须有这条记录，否则事后无法解释"那 30 秒在干什么"。
     */
    const retryBuffer: RetryEvent[] = []
    /**
     * 两条分支都在 try 内赋值；"没有响应"的情况在分支里已经 throw，
     * 但编译器看不到这条路径，所以用 definite assignment 断言兜住。
     */
    let response!: ModelResponse
    try {
      const request: ModelRequest = {
        model: deps.settings.model ?? "default",
        system:
          typeof sentMessages[0]?.content === "string"
            ? sentMessages[0].content
            : options.systemPrompt,
        messages: sentMessages.filter((m) => m.role !== "system"),
        tools: assembled.specs,
        maxTokens: 8_192,
      }

      /**
       * 后端声明了流式就走流式，否则退回 `generate()`。
       *
       * 选择依据是**能力位**而不是"有没有提供方"：能力声明与实现一致，
       * 否则会出现"以为有增量、实际等整段"的静默降级。
       */
      if (deps.gateway.capabilities.streaming) {
        let pendingText = ""
        let pendingChunks = 0
        let streamed: ModelResponse | undefined

        for await (const event of deps.gateway.stream(request, options.signal)) {
          if (event.type === "retry") {
            // 流式下的退避是实时事件，不需要像非流式那样先缓冲再补发
            yield await sink.emit("retry.api", { ...event.event })
            continue
          }
          if (event.type === "done") {
            streamed = event.response
            continue
          }
          if (event.delta.type !== "text") continue

          pendingText += event.delta.text
          pendingChunks += 1
          if (pendingText.length >= DELTA_FLUSH_CHARS || pendingChunks >= DELTA_FLUSH_CHUNKS) {
            yield await sink.emit("agent.message_delta", { turn: turns, text: pendingText })
            pendingText = ""
            pendingChunks = 0
          }
        }

        // 结尾残量必须发出去：否则用户看到的最后一句是缺的
        if (pendingText.length > 0) {
          yield await sink.emit("agent.message_delta", { turn: turns, text: pendingText })
        }
        if (!streamed) {
          throw new AppError(
            "MODEL_INVALID_OUTPUT",
            "Model stream completed without a final response (no end chunk)",
          )
        }
        response = streamed
      } else {
        response = await deps.gateway.generate(request, options.signal, {
          onRetry: (event) => retryBuffer.push(event),
        })
      }
    } catch (err) {
      for (const retry of retryBuffer.splice(0, retryBuffer.length)) {
        yield await sink.emit("retry.api", { ...retry })
      }
      /**
       * 取消必须落到 `cancelled`，不是 `failed`。
       *
       * 请求在飞或退避等待中被中断时，网关抛的是 `CANCELLED`；若不在这里分流，
       * 用户按了一次停止就会得到一个"任务失败"的终态 —— 而失败会进失败统计、
       * 让 `--continue` 把它当成需要修的错误。
       */
      if (options.signal?.aborted) {
        yield await sink.emit("task.warning", {
          reason: "cancelled",
          message: "Cancelled while waiting for the model",
        })
        const toCancelling = await moveTo("cancelling")
        if (toCancelling) yield toCancelling
        const settled = await finish("cancelled", "cancelled", "Cancelled by user or caller")
        if (settled.event) yield settled.event
        return settled.outcome
      }
      const appError = toAppError(err, "MODEL_INVALID_OUTPUT")
      deps.metrics.increment("model.error")
      yield await sink.emit("task.failed", { code: appError.code, message: appError.message })
      const settled = await finish("failed", "error_during_execution", appError.message)
      if (settled.event) yield settled.event
      return settled.outcome
    }
    for (const retry of retryBuffer.splice(0, retryBuffer.length)) {
      yield await sink.emit("retry.api", { ...retry })
    }

    usage.inputTokens += response.usage.inputTokens
    usage.outputTokens += response.usage.outputTokens
    usage.costUsd = Number((usage.costUsd + (response.costUsd ?? 0)).toFixed(6))

    /* ---- ④ 解析决策 ---- */
    /**
     * 一轮响应里可能带**多个** tool_use（并行工具调用）。
     *
     * 之前这里只取 `toolCalls[0]`，其余既不执行也不告知 —— 更糟的是
     * assistant 历史里也只写入了第一个 `tool_use`，模型自己的操作记录被改写：
     * 它下一轮看到的历史里"自己只请求了一个文件"，于是会以为另一个文件
     * 已经处理过（或者根本没意识到自己请求过）。这不是性能问题，
     * 是"模型对世界的认知被系统篡改"的正确性问题。
     */
    const batch: PreparedCall[] = []
    let invalidCall: string | undefined
    if (response.toolCalls.length > 0) {
      for (const call of response.toolCalls) {
        const callId = call.id || newCallId()
        const check = ToolUseDecisionSchema.safeParse({
          type: "tool_use",
          callId,
          toolName: call.name,
          args: call.args,
        })
        if (!check.success) {
          invalidCall = check.error.message
          break
        }
        batch.push({
          callId,
          toolName: call.name,
          args: call.args,
          ...(call.argsParseError ? { argsParseError: call.argsParseError } : {}),
        })
      }
    }

    let decided: Decision | undefined

    /**
     * **停止原因必须先于决策解析处理。**
     *
     * `stopReason` 在模型契约里定义了很久、两家 provider 也都正确映射了它，
     * 但主循环此前从未读过 —— 于是"文本被 `max_tokens` 砍断"与"正常收尾"
     * 走同一条 final 分支：任务被判成成功交付、退出码 0、流水线继续往下。
     * 实测（ScriptedProvider 回放 `stopReason: "max_tokens"` + 半截文本）
     * 拿到的就是 `completed / success`。
     */
    if (response.stopReason === "error") {
      const message =
        "The model reported an error stop reason; this response carries no usable decision."
      yield await sink.emit("task.failed", { code: "MODEL_INVALID_OUTPUT", message })
      const settled = await finish("failed", "error_during_execution", message)
      if (settled.event) yield settled.event
      return settled.outcome
    }

    if (response.stopReason === "max_tokens" && batch.length === 0) {
      truncationRecoveries += 1
      deps.metrics.increment("model.output_truncated")
      if (truncationRecoveries > MAX_TRUNCATION_RECOVERIES) {
        const message =
          `Model output was truncated by the token limit ${truncationRecoveries} time(s) in a row. ` +
          "This task cannot be delivered: the last response was cut off mid-thought. " +
          "Reduce the requested output size (split the work into smaller steps) and rerun."
        yield await sink.emit("task.failed", { code: "MODEL_INVALID_OUTPUT", message })
        const settled = await finish("failed", "error_during_execution", message)
        if (settled.event) yield settled.event
        return settled.outcome
      }
      /**
       * 续写而不是重来：把半截 assistant 文本留在历史里，模型从断点接着写。
       * 丢掉它等于让模型重新生成一遍，既贵又可能得到另一份不同内容。
       * 空文本（纯思考被截断）不落空消息 —— 后端会拒绝空 content。
       */
      if (response.text.trim().length > 0) {
        messages.push({ role: "assistant", content: response.text })
      }
      messages.push({ role: "user", content: OUTPUT_TRUNCATED_CONTINUE })
      await flushMessages()
      yield await sink.emit("task.warning", {
        reason: "output_truncated",
        attempt: truncationRecoveries,
        limit: MAX_TRUNCATION_RECOVERIES,
      })
      continue
    }

    if (response.stopReason === "unknown") {
      // 原因不明时不猜：留一条可诊断的记录，仍按常规路径推进（文本通常是完整的）
      deps.logger.warn("model.stop_reason_unknown", { taskId: options.taskId, turn: turns })
    }

    if (response.toolCalls.length === 0) {
      const single: Decision =
        response.decisionHint === "ask"
          ? // 只有后端显式标注"这是提问"才走 ask 分支；猜文本里有没有问号是靠不住的
            { type: "ask" as const, question: response.text }
          : { type: "final" as const, summary: response.text }
      const parsed = DecisionSchema.safeParse(single)
      if (!parsed.success) {
        // 格式错误是模型自己能纠的，不该终止：回喂一条纠错消息，并把重试计入步数
        messages.push({
          role: "user",
          content: `Your last output could not be parsed: ${parsed.error.message}. Reply with a single tool call or a final summary.`,
        })
        deps.metrics.increment("model.format_error")
        continue
      }
      decided = parsed.data
    } else if (invalidCall !== undefined) {
      messages.push({
        role: "user",
        content:
          `Your last output contained a malformed tool call: ${invalidCall}. ` +
          "Nothing was executed. Reply with well-formed tool calls or a final summary.",
      })
      deps.metrics.increment("model.format_error")
      continue
    }

    /* ---- ⑤ final：验证并交付 ---- */
    if (decided?.type === "final") {
      messages.push({ role: "assistant", content: decided.summary })
      await flushMessages()

      let validation: ValidationReport | undefined
      if (options.validationChecks && options.validationChecks.length > 0) {
        // 验证是一个独立阶段：状态机上它是 `validating`，不是"还在 executing"
        const toValidating = await moveTo("validating")
        if (toValidating) yield toValidating
        yield await sink.emit("validation.started", {
          checks: options.validationChecks.map((c) => c.id),
        })
        validation = await runChecks(options.validationChecks, {
          /**
           * 验证命令**必须过策略**。
           *
           * 之前这里直接把 `deps.runCommand`（沙箱）交下去，验证流水线因此成为
           * 整个策略体系之外唯一一条执行通道：`rm -rf` 明明被判为 bypass-immune
           * deny，验证阶段照样执行并报 `passed`；而验证命令默认还是从仓库的
           * `package.json` 自动发现的 —— 仓库内容于是能指挥 agent 执行任意命令。
           *
           * 判定规则见 `PolicyEngine.evaluateValidation`：bypass-immune 与 deny
           * 规则永远生效；仓库内容发现的命令不能自我授权（必须有显式 allow 规则
           * 或本会话审批记录），用户显式给出的命令视为已授权。
           */
          authorize: async (check) => {
            const executable = check.command[0]
            if (!executable) return
            const decision = await deps.policy.evaluateValidation(
              {
                // 与 `test.run` 同名同形，这样"模型跑过一次并获批"能直接复用
                // 会话放行记录，不必在验证阶段再问一遍。
                toolName: "test.run",
                risk: "command",
                args: {
                  cwd: check.cwd,
                  command: check.command,
                  timeoutMs: VALIDATION_TIMEOUT_MS,
                },
                command: normalizeCommandRequest({
                  executable,
                  args: check.command.slice(1),
                  cwd: check.cwd,
                  timeoutMs: VALIDATION_TIMEOUT_MS,
                  networkProfile: "none",
                  reason: `Validation check: ${check.kind}`,
                  onTimeout: "move-to-background",
                }),
                paths: [check.cwd],
                permissionMode: options.permissionMode,
                taskMode: effectiveTaskMode(),
              },
              { userProvided: check.source !== "discovered" },
            )
            if (decision.effect !== "allow") {
              throw new AppError("TOOL_PERMISSION_DENIED", decision.reason, {
                details: { matchedRule: decision.matchedRule },
              })
            }
          },
          runCommand: deps.runCommand,
          persistArtifact: async (content, kind) =>
            persistArtifact(deps, options.taskId, content, kind),
        })
        if (options.acceptanceCriteria) mapAcceptance(options.acceptanceCriteria, validation)
        yield await sink.emit("validation.completed", {
          status: validation.status,
          checks: validation.checks.length,
        })

        /**
         * 验证没过 → 进 Repair Loop，而不是照常交付。
         *
         * 之前这里无论验证结果一律 `completed + success`，
         * 于是"必过检查挂了"也能交付成功 —— 交付报告里那行 Status: failed 是唯一痕迹，
         * 退出码还是 0，流水线照样往下走。验证的意义就在于它能拦住交付。
         */
        if (validation.status === "failed") {
          const diagnosis = summarizeReport(validation)
          if (usage.repairRounds < state.budget.maxRepairRounds) {
            usage.repairRounds += 1
            deps.metrics.increment("loop.repair")
            yield await sink.emit("task.warning", {
              reason: "validation_failed",
              attempt: usage.repairRounds,
              limit: state.budget.maxRepairRounds,
              diagnosis,
            })
            const toRepairing = await moveTo("repairing")
            if (toRepairing) yield toRepairing
            messages.push({
              role: "user",
              content:
                `[validation-failed] The delivery checks did not pass (repair ${usage.repairRounds}/${state.budget.maxRepairRounds}).\n\n` +
                `${diagnosis}\n\n` +
                "Fix the root cause, then reply with a final summary when you believe it passes. " +
                "Do not weaken or skip the checks to make them green.",
            })
            progressGuard.reset()
            await flushMessages()
            const repaired = await saveCheckpoint(
              deps,
              options,
              currentStatus,
              messages,
              changedFiles,
              sink,
            )
            yield repaired
            continue
          }
          yield await sink.emit("task.failed", {
            code: "TEST_FAILED",
            message: `Validation failed after ${usage.repairRounds} repair round(s)`,
            diagnosis,
          })
          const settled = await finish(
            "failed",
            "error_during_execution",
            `Validation did not pass and repair budget (${state.budget.maxRepairRounds}) is exhausted.\n\n${diagnosis}`,
            validation,
          )
          if (settled.event) yield settled.event
          return settled.outcome
        }
      }

      const report = buildDeliverySummary(decided.summary, validation, [...changedFiles])
      await persistArtifact(deps, options.taskId, report, "delivery-report")
      yield await sink.emit("task.completed", {
        subtype: "success",
        summary: decided.summary,
        validationStatus: validation?.status ?? "not_run",
        changedFiles: [...changedFiles],
        turns,
        permissionDenials,
      })
      const settled = await finish("completed", "success", decided.summary, validation)
      if (settled.event) yield settled.event
      return settled.outcome
    }

    /* ---- ⑥ ask：暂等人 ---- */
    if (decided?.type === "ask") {
      messages.push({ role: "assistant", content: decided.question })
      await flushMessages()
      yield await sink.emit("task.warning", {
        reason: "clarification_required",
        question: decided.question,
      })
      const settled = await finish("paused", "approval_required", decided.question)
      if (settled.event) yield settled.event
      return settled.outcome
    }

    /* ---- ⑦ 工具执行：本轮所有 tool_use 按序执行 ---- */
    /**
     * assistant 消息**一次写入全部 tool_use**，再逐条执行。
     *
     * 配对是硬约束：N 个 `tool_use` 必须对应 N 个 `tool_result`，缺一个后端就报错。
     * 所以"提前退出"的每一条路径（审批、进度守卫、拒绝上限）都必须先把
     * 未执行的那几条补成失败结果，否则这一批历史就永久损坏了。
     */
    messages.push({
      role: "assistant",
      content: batch.map((call) => ({
        type: "tool_use" as const,
        id: call.callId,
        name: call.toolName,
        input: call.args,
      })),
    })

    const batchResults: ContentBlock[] = []
    /**
     * 本批要额外对模型说的话（进度守卫的诊断、参数格式提示……）。
     *
     * 必须单独攒着、**在结果之后**追加成 text 块，不能塞成 `tool_result`：
     * 一个 `tool_use` 只能有一个 `tool_result`，多补一条会让配对关系失效
     * （后端按 id 找结果，看到两条会直接报错）。
     */
    const batchNotes: string[] = []

    /** 把 `from` 之后（含）尚未执行的调用补成失败结果，保证配对完整。 */
    const closeBatch = (from: number, reason: string): void => {
      for (let j = from; j < batch.length; j += 1) {
        const rest = batch[j]
        if (!rest) continue
        batchResults.push({
          type: "tool_result",
          toolUseId: rest.callId,
          content: reason,
          isError: true,
        })
      }
    }

    /** 一次性写回整批结果：同一条 user 消息里的 N 个 tool_result 才是合法形状。 */
    const flushBatch = async (): Promise<void> => {
      if (batchResults.length === 0 && batchNotes.length === 0) return
      messages.push({
        role: "user",
        content: [
          ...batchResults.splice(0, batchResults.length),
          ...batchNotes.splice(0, batchNotes.length).map((text) => ({
            type: "text" as const,
            text,
          })),
        ],
      })
      await flushMessages()
    }

    for (let index = 0; index < batch.length; index += 1) {
      const call = batch[index]
      if (!call) continue
      const callId = call.callId
      const tool = deps.registry.get(call.toolName)

      /**
       * 参数 JSON 解析失败：**不执行**，回一条可读的错误。
       *
       * 之前这里是一句 `...(call.argsParseError ? {} : {})` —— 恒等空展开，
       * 解析错误被完全丢弃，于是"参数是坏 JSON"的调用会拿着空对象去执行。
       */
      if (call.argsParseError) {
        batchResults.push({
          type: "tool_result",
          toolUseId: callId,
          content:
            `Your tool call arguments were not valid JSON: ${call.argsParseError}. ` +
            "Nothing was executed. Re-issue the call with valid JSON.",
          isError: true,
        })
        deps.metrics.increment("tool.invalid_args")
        continue
      }

      const argsRecord = call.args

      yield await sink.emit("tool.started", {
        callId,
        tool: call.toolName,
        risk: tool?.risk ?? "read",
      })
      const startedAt = now()
      deps.metrics.increment(`tool.invoked`)
      deps.metrics.increment(`tool.${call.toolName}.invoked`)

      /**
       * 调用开始前先落一条 `started` 记录（ADR-2）。
       *
       * 这条记录是**崩溃恢复**唯一的判据：进程被杀时它仍是 started，恢复方据此
       * 决定"重跑 / 查证 / 标记未知"（development-guide.md §5 第四件）。
       * 不写它，`openToolCalls()` 永远为空，`outcome_unknown` 那条分支就是死代码 ——
       * 恢复时会把一个"可能已经执行过、也可能没有"的非幂等动作当成没发生过。
       */
      await deps.store.startToolCall({
        id: callId,
        taskId: options.taskId,
        toolName: call.toolName,
        inputHash: sha256(stableStringify(argsRecord)),
        idempotencyKey: parameterHash({ tool: call.toolName, args: argsRecord }),
        idempotency: tool?.idempotency ?? "non_idempotent",
        status: "started",
        startedAt: startedAt.toISOString(),
        retryCount: 0,
      })

      /**
       * 本次调用**自己**改了哪些文件。
       *
       * 必须与累计集合分开：进度守卫按"每次观测改了哪些文件"判断是否在反复churn，
       * 若传累计集合，改过一次文件之后每个只读调用都会被算成"又改了一次"，
       * 四次调用后就会误报"这个文件已被重写 4 次"，把模型推进无意义的重新规划。
       */
      const callChangedFiles = new Set<string>()
      const outcome = await deps.executor.execute({
        toolName: call.toolName,
        args: argsRecord,
        ctx: buildToolContext(
          deps,
          options,
          callId,
          (file) => {
            callChangedFiles.add(file)
            changedFiles.add(file)
          },
          state.workspaceRoot,
        ),
        /**
         * 策略判定的输入**必须在工具校验之后**再求值。
         *
         * `policyCommand` / `policyPaths` 读的是工具入参，而有些工具会在 `validate`
         * 阶段把入参补全（例如 `test.run` 省略 command 时从 package.json 自动发现）。
         * 若在 `execute` 之前用原始 args 先算一遍，策略批准的是"猜出来的那条命令"、
         * 真正执行的却是"发现出来的那条"，审批与执行就对不上了 ——
         * 这正是 ADR-8 要求"判定只认结构化请求"要防的那类偏差。
         *
         * 另外执行器会把 PreToolUse 钩子放在判定**之前**跑，
         * 所以这里拿到的 `args` 已经是钩子改过、并重新校验过的最终入参。
         */
        decide: async (args) => {
          const command = tool?.policyCommand?.(args)
          return deps.policy.evaluate({
            toolName: call.toolName,
            risk: tool?.risk ?? "read",
            args,
            ...(command ? { command: normalizeCommandRequest(command) } : {}),
            ...(tool?.policyPaths ? { paths: tool.policyPaths(args) } : {}),
            ...(tool?.policyDomains ? { domains: tool.policyDomains(args) } : {}),
            permissionMode: options.permissionMode,
            taskMode: effectiveTaskMode(),
          })
        },
        taskMode: effectiveTaskMode(),
        permissionMode: options.permissionMode,
      })

      usage.toolCalls += 1

      /* ---- ⑦-a 需要审批：存下请求就退出，不阻塞 ---- */
      if (outcome.kind === "approval") {
        const approvalId = `apr_${sha256(`${options.taskId}:${callId}`).slice(0, 12)}`
        await deps.store.createApproval({
          id: approvalId,
          taskId: options.taskId,
          toolCallId: callId,
          toolName: outcome.approval.toolName,
          requestSummary: outcome.approval.reason,
          parameterHash: outcome.approval.parameterHash,
          policyVersion: outcome.approval.policyVersion,
          status: "pending",
          requestedAt: startedAt.toISOString(),
          expiresAt: new Date(startedAt.getTime() + 30 * 60_000).toISOString(),
        })
        batchResults.push({
          type: "tool_result",
          toolUseId: callId,
          content: `Approval required: ${outcome.approval.reason}. The task is paused pending a decision.`,
          isError: true,
        })
        closeBatch(
          index + 1,
          "Not executed: an earlier tool call in this batch is awaiting approval. Re-issue it after the decision.",
        )
        await flushBatch()
        const awaiting = await saveCheckpoint(
          deps,
          options,
          "awaiting_approval",
          messages,
          changedFiles,
          sink,
        )
        yield awaiting
        yield await sink.emit("approval.required", {
          approvalId,
          tool: outcome.approval.toolName,
          parameterHash: outcome.approval.parameterHash,
          reason: outcome.approval.reason,
        })
        deps.metrics.increment("policy.decision.ask")

        const latestState = await deps.store.getTask(options.taskId)
        if (latestState) {
          // 审批前落库同样要抗竞争：用户可能正在取消，不该把状态写回 awaiting_approval
          await updateTaskWithRetry(
            deps.store,
            options.taskId,
            { status: "awaiting_approval", usage },
            { stopIf: (current) => !assertSafeTransition(current.status, "awaiting_approval") },
          )
        }
        const settled = await finish(
          "awaiting_approval",
          "approval_required",
          outcome.approval.reason,
        )
        if (settled.event) yield settled.event
        return settled.outcome
      }

      const result = outcome.result
      yield await sink.emit("tool.completed", {
        callId,
        tool: result.toolName,
        status: result.status,
        durationMs: result.durationMs,
        errorCode: result.error?.code,
        truncated: result.truncated,
      })
      deps.metrics.recordTiming("tool.duration_ms", result.durationMs)

      // 闭合调用记录：未闭合 = 恢复时要按 outcome_unknown 处理
      await deps.store.finishToolCall(callId, {
        status: toolCallStatusFor(result.status),
        finishedAt: now().toISOString(),
        durationMs: result.durationMs,
        ...(result.error ? { errorCode: result.error.code } : {}),
      })

      // file.changed：事件流里必须能看到"改了哪个文件"，否则消费端只能等到最后
      // 从 outcome.changedFiles 里一次性知道，中途无法做任何增量展示或拦截。
      for (const file of changedFiles) {
        if (emittedChangedFiles.has(file)) continue
        emittedChangedFiles.add(file)
        yield await sink.emit("file.changed", { path: file }, callId)
      }

      if (result.status === "succeeded") deps.metrics.increment("tool.succeeded")
      else deps.metrics.increment("tool.failed")

      if (
        result.error?.code === "TOOL_PERMISSION_DENIED" ||
        result.error?.code === "DENIAL_LIMIT_REACHED"
      ) {
        permissionDenials.push({ toolName: result.toolName, reason: result.error.message })
        deps.metrics.increment("policy.decision.deny")
      } else {
        deps.metrics.increment("policy.decision.allow")
      }

      // 计划提交成功 → 对外发一条可审计的 `task.plan_ready`
      if (call.toolName === "plan.exit_plan_mode" && result.status === "succeeded") {
        const submitted = result.output as { steps?: number; plan?: unknown } | undefined
        yield await sink.emit("task.plan_ready", {
          steps: submitted?.steps ?? 0,
          plan: submitted?.plan ?? null,
        })
      }

      /* ---- ⑧ 结果回灌（错误也是数据） ---- */
      batchResults.push({
        type: "tool_result",
        toolUseId: callId,
        content: renderToolResultForModel(result),
        isError: result.status !== "succeeded",
      })

      /**
       * 累计拒绝到上限：**这是唯一一条"不许再试"的终止信号**。
       *
       * 它必须在这里收口，不能只把结果回喂给模型 —— 模型的合理反应是"换个做法
       * 再试"，于是拒绝数继续涨，任务无限空转。也不能像之前那样从策略层抛异常：
       * 那会抛穿生成器，任务死在 `executing`，库里状态再也不会更新。
       */
      if (result.error?.code === "DENIAL_LIMIT_REACHED") {
        closeBatch(index + 1, "Not executed: the cumulative denial limit was reached.")
        await flushBatch()
        yield await sink.emit("task.warning", {
          reason: "denial_limit_reached",
          message: result.error.message,
          denials: permissionDenials.length,
        })
        const settled = await finish("failed", "error_during_execution", result.error.message)
        if (settled.event) yield settled.event
        return settled.outcome
      }

      /* ---- ⑨ 进度守卫 ---- */
      try {
        progressGuard.assertProgress({
          toolName: result.toolName,
          argsFingerprint: sha256(stableStringify(argsRecord)),
          resultFingerprint: fingerprintResult(result.output ?? result.error),
          ok: result.status === "succeeded",
          changedFiles: [...callChangedFiles],
          ...(result.error ? { errorCode: result.error.code } : {}),
        })
      } catch (err) {
        const appError = toAppError(err, "NO_PROGRESS")
        const diagnosis = progressGuard.buildDiagnosis()
        if (appError.details?.action === "stop-and-escalate") {
          closeBatch(index + 1, "Not executed: the task stopped because it made no progress.")
          await flushBatch()
          yield await sink.emit("task.warning", { reason: "no_progress", diagnosis })
          yield await sink.emit("task.failed", {
            code: appError.code,
            message: appError.message,
            diagnosis,
          })
          const settled = await finish(
            "failed",
            "error_no_progress",
            `${appError.message}\n\n${diagnosis}`,
          )
          if (settled.event) yield settled.event
          return settled.outcome
        }
        // 压成诊断重新规划，而不是放任它原地空转
        batchNotes.push(
          `[progress-guard] ${appError.message}\n\n${diagnosis}\n\nForm a new hypothesis and change your approach.`,
        )
        progressGuard.reset()
        deps.metrics.increment("loop.no_progress")
        yield await sink.emit("task.warning", { reason: "no_progress_compressed", diagnosis })
      }
    }

    await flushBatch()

    /* ---- ⑩ 检查点 ---- */
    currentStatus = (await deps.store.getTask(options.taskId))?.status ?? currentStatus
    const check = await saveCheckpoint(deps, options, currentStatus, messages, changedFiles, sink)
    yield check

    const pressure = budgetPressure(state.budget, usage, now().getTime())
    if (pressure >= 1) {
      yield await sink.emit("task.failed", { code: "BUDGET_EXCEEDED", message: "Budget exhausted" })
      const settled = await finish(
        "expired",
        "error_max_turns",
        "Budget exhausted before completion",
      )
      if (settled.event) yield settled.event
      return settled.outcome
    }
  }

  const settled = await finish(currentStatus, "error_max_turns", "Loop exited")
  if (settled.event) yield settled.event
  return settled.outcome
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

/** 只允许在这里放宽：终态之后不再转换。 */
function assertSafeTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (isTerminalStatus(from)) return false
  try {
    assertTransition(from, to)
    return true
  } catch {
    return false
  }
}

/**
 * 把"有 tool_use 但缺 tool_result"的历史补齐。
 *
 * 只处理**最后一条**含 tool_use 的 assistant 消息：更早的缺口属于历史数据损坏，
 * 不在运行期悄悄改写（那样会把真正的 bug 掩盖成"看起来正常"）。
 *
 * 补的是 `is_error` 结果而不是空成功：模型必须知道"这次调用没有拿到结果"，
 * 它才会决定重试；谎报成功会让它基于不存在的事实继续往下做。
 *
 * @returns 是否发生了修补（调用方据此决定要不要整体回写存储）
 */
export function closeDanglingToolUses(messages: ModelMessage[]): boolean {
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (
      message?.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "tool_use")
    ) {
      lastAssistant = i
      break
    }
  }
  if (lastAssistant < 0) return false

  const assistant = messages[lastAssistant]
  if (!assistant || !Array.isArray(assistant.content)) return false
  const requested = assistant.content
    .filter(
      (block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use",
    )
    .map((block) => block.id)

  const answered = new Set<string>()
  for (let i = lastAssistant + 1; i < messages.length; i += 1) {
    const message = messages[i]
    if (!message || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === "tool_result") answered.add(block.toolUseId)
    }
  }

  const missing = requested.filter((id) => !answered.has(id))
  if (missing.length === 0) return false

  const blocks: ContentBlock[] = missing.map((id) => ({
    type: "tool_result" as const,
    toolUseId: id,
    content:
      "This tool call did not complete: the process stopped before a result was recorded. " +
      "It may or may not have taken effect; verify the actual state before retrying.",
    isError: true,
  }))

  // 后端要求角色交替：能并进最后一条 tool_result 消息就并进去，否则另起一条
  const last = messages[messages.length - 1]
  if (
    last &&
    last.role === "user" &&
    Array.isArray(last.content) &&
    last.content.some((block) => block.type === "tool_result")
  ) {
    last.content = [...last.content, ...blocks]
  } else {
    messages.push({ role: "user", content: blocks })
  }
  return true
}

/** 工具的 `ToolExecutionStatus` → 存储的 `ToolCallStatus`。 */
function toolCallStatusFor(status: ToolExecutionResult["status"]): ToolCallStatus {
  switch (status) {
    case "succeeded":
      return "succeeded"
    case "failed":
      return "failed"
    case "timed_out":
      return "timed_out"
    case "cancelled":
      return "cancelled"
    default:
      return "failed"
  }
}

/** 首轮种子：用户请求包一层不可信标记（context-engineering.md §6）。 */
async function seedMessages(
  _deps: LoopDeps,
  options: LoopOptions,
  userRequest: string,
): Promise<ModelMessage[]> {
  const { buildUserRequest, buildRulesReminder } = await import("../context/system-prompt.js")
  const messages: ModelMessage[] = [{ role: "user", content: buildUserRequest(userRequest) }]
  /**
   * 规则跟在用户请求**之后**：先让模型知道"要做什么"，再给"这个仓库的约定"。
   * 顺序反过来的话，长规则文件会把真正的任务挤到后面，模型更容易跑偏。
   */
  if (options.projectRules && options.projectRules.length > 0) {
    messages.push({ role: "user", content: buildRulesReminder(options.projectRules) })
  }
  return messages
}

function buildToolContext(
  deps: LoopDeps,
  options: LoopOptions,
  callId: string,
  onWrite: (file: string) => void,
  workspaceRoot: string,
): ToolExecutionContext {
  const controller = new AbortController()
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason)
    else
      options.signal.addEventListener("abort", () => controller.abort(options.signal?.reason), {
        once: true,
      })
  }
  return {
    callId,
    taskId: options.taskId,
    workspaceRoot,
    cwd: workspaceRoot,
    signal: controller.signal,
    timeoutMs: deps.settings.limits.commandTimeoutMs,
    budgetTokens: deps.settings.limits.readMaxOutputTokens,
    runCommand: deps.runCommand,
    logger: deps.logger,
    trackRead: (p: string, mtimeMs: number, content: string) => {
      // 已读表由本任务的 EditEngine 持有（read-before-edit 的唯一来源）
      deps.editEngine.recordRead(p, mtimeMs, content)
    },
    readState: (p: string) => {
      const record = deps.editEngine.readRecord(p)
      return record ? { read: true, mtimeMs: record.mtimeMs } : undefined
    },
    trackWrite: (p: string) => {
      onWrite(p)
    },
    persistArtifact: async (content: string, kind: string) =>
      persistArtifact(deps, options.taskId, content, kind),
    editEngine: deps.editEngine,
  }
}

async function persistArtifact(
  deps: LoopDeps,
  taskId: string,
  content: string,
  kind: string,
): Promise<{ uri: string; sha256: string }> {
  const digest = sha256(content)
  const dir = path.join(deps.pathGuard.root, ".mod", "artifacts")
  await fs.mkdir(dir, { recursive: true })
  const uri = path.join(dir, `${kind}-${digest.slice(0, 12)}.txt`)
  await fs.writeFile(uri, content, "utf8")
  await deps.store.createArtifact({
    id: `art_${digest.slice(0, 12)}`,
    taskId,
    kind,
    uri,
    sha256: digest,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    createdAt: new Date().toISOString(),
  })
  return { uri, sha256: digest }
}

/**
 * 落检查点。
 *
 * 事件必须走 `sink` 而不是自己另算 seq：sink 内部维护自增序号并即时落库，
 * 另一条"读全量事件再 +1"的路径会和它算出同一个号，撞 `(task_id, seq)` 唯一约束。
 */
async function saveCheckpoint(
  deps: LoopDeps,
  options: LoopOptions,
  status: TaskStatus,
  messages: readonly ModelMessage[],
  changedFiles: ReadonlySet<string>,
  sink: EventSink,
): Promise<TaskEvent> {
  const existing = await deps.store.latestCheckpoint(options.taskId)
  const version = (existing?.version ?? 0) + 1
  const checkpoint = {
    id: newCheckpointId(),
    taskId: options.taskId,
    version,
    status,
    /**
     * `completedStepIds` 记的是**计划步骤**的完成情况；当前主循环是平铺的单循环，
     * 不按计划步骤推进，所以沿用上一个检查点的值（没有计划就是空数组），
     * 绝不拿 `changedFiles` 顶替 —— 那会让恢复方把改动过的文件当成已完成的步骤。
     */
    completedStepIds: existing?.completedStepIds ?? [],
    changedFiles: [...changedFiles],
    messageCount: messages.length,
    createdAt: new Date().toISOString(),
  } satisfies Checkpoint
  await deps.store.saveCheckpoint(checkpoint)
  // 返回事件由调用方 yield：异步函数里不能 yield，否则消费端永远看不到检查点
  return sink.emit("checkpoint.created", { checkpointId: checkpoint.id, version })
}

/** 把工具结果渲染给模型：成功/失败都是数据，形状统一。 */
export function renderToolResultForModel(result: ToolExecutionResult): string {
  if (result.status === "succeeded") {
    const text =
      typeof result.output === "string"
        ? result.output
        : JSON.stringify(result.output ?? "", null, 2)
    return text.trim().length === 0
      ? "Your command ran successfully and did not produce any output."
      : text
  }
  const code = result.error?.code ?? "TOOL_FAILED"
  const message = result.error?.message ?? "Tool failed"
  const retryable = result.error?.retryable ? " (retryable)" : ""
  return `Error [${code}]${retryable}: ${message}`
}

function buildDeliverySummary(
  summary: string,
  validation: ValidationReport | undefined,
  changedFiles: readonly string[],
): string {
  const lines = [
    "# Delivery report",
    "",
    summary.trim(),
    "",
    `## Changed files (${changedFiles.length})`,
    ...(changedFiles.length > 0 ? changedFiles.map((f) => `- ${f}`) : ["- (none)"]),
    "",
    "## Validation",
  ]
  if (!validation) {
    lines.push(
      "No validation commands were run for this task. This is a verification gap, not a pass.",
    )
  } else {
    lines.push(`Status: ${validation.status}`)
    for (const check of validation.checks) {
      lines.push(
        `- [${check.status}] ${check.id}: ${check.command.join(" ")}${
          check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ""
        }`,
      )
    }
  }
  return lines.join("\n")
}

/** 计算当前 diff（交付前用）。 */
export async function computeDiff(
  changedFiles: readonly string[],
  readBefore: (file: string) => Promise<string | undefined>,
  readAfter: (file: string) => Promise<string | undefined>,
): Promise<ReturnType<typeof summarize>> {
  const diffs = []
  for (const file of changedFiles) {
    const before = (await readBefore(file)) ?? ""
    const after = (await readAfter(file)) ?? ""
    if (before === after) continue
    diffs.push(diffText(before, after, file))
  }
  return summarize(diffs)
}

export { parameterHash }
