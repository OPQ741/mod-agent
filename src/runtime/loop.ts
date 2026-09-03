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
  isTerminalStatus,
  normalizeCommandRequest,
  type TaskStatus,
} from "../shared/contracts.js"
import { AppError, toAppError } from "../shared/errors.js"
import { newCallId, newCheckpointId } from "../shared/ids.js"
import { parameterHash, sha256, stableStringify } from "../shared/hash.js"
import type { ModelMessage, ModelResponse } from "../model/types.js"
import type { ModelGateway } from "../model/gateway.js"
import type { Store } from "../store/types.js"
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
import { runChecks, mapAcceptance, summarizeReport } from "../validation/runner.js"
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
  /** 计划模式的当前计划文件路径；未进入计划模式为 undefined。 */
  planFilePath: () => string | undefined
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
  let turns = 0
  const messages: ModelMessage[] = isFreshTask
    ? await seedMessages(deps, options, state.userRequest)
    : [...state.messages]

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
      await deps.store.updateTask(options.taskId, { status, usage }, latest.stateVersion)
      event = await sink.emit("task.status_changed", { from, to: status, subtype })
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
    await deps.store.updateTask(options.taskId, { status: "executing" }, state.stateVersion)
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
    await deps.store.updateTask(options.taskId, { status: to, usage }, latest.stateVersion)
    currentStatus = to
    return sink.emit("task.status_changed", { from: latest.status, to })
  }

  while (!isTerminalStatus(currentStatus)) {
    /* ---- ① 取消与预算 ---- */
    if (options.signal?.aborted) {
      yield await sink.emit("task.warning", {
        reason: "cancelled",
        message: "Abort signal received",
      })
      const settled = await finish("cancelled", "cancelled", "Cancelled by user or caller")
      if (settled.event) yield settled.event
      return settled.outcome
    }
    const latest = await deps.store.getTask(options.taskId)
    if (latest?.cancelRequestedAt) {
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
      taskMode: options.mode,
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
    let response: ModelResponse
    try {
      response = await deps.gateway.generate(
        {
          model: deps.settings.model ?? "default",
          system:
            typeof sentMessages[0]?.content === "string"
              ? sentMessages[0].content
              : options.systemPrompt,
          messages: sentMessages.filter((m) => m.role !== "system"),
          tools: assembled.specs,
          maxTokens: 8_192,
        },
        options.signal,
      )
    } catch (err) {
      const appError = toAppError(err, "MODEL_INVALID_OUTPUT")
      deps.metrics.increment("model.error")
      yield await sink.emit("task.failed", { code: appError.code, message: appError.message })
      const settled = await finish("failed", "error_during_execution", appError.message)
      if (settled.event) yield settled.event
      return settled.outcome
    }

    usage.inputTokens += response.usage.inputTokens
    usage.outputTokens += response.usage.outputTokens
    usage.costUsd = Number((usage.costUsd + (response.costUsd ?? 0)).toFixed(6))

    /* ---- ④ 解析决策 ---- */
    let decision
    if (response.toolCalls.length > 0) {
      const call = response.toolCalls[0]
      if (!call) {
        const fallback: Decision = { type: "final", summary: "" }
        decision = fallback
      } else {
        decision = {
          type: "tool_use" as const,
          callId: call.id,
          toolName: call.name,
          args: call.args,
          ...(call.argsParseError ? {} : {}),
        }
      }
    } else if (response.decisionHint === "ask") {
      // 只有后端显式标注"这是提问"才走 ask 分支；猜文本里有没有问号是靠不住的
      decision = { type: "ask" as const, question: response.text }
    } else {
      decision = { type: "final" as const, summary: response.text }
    }

    const parsed = DecisionSchema.safeParse(decision)
    if (!parsed.success) {
      // 格式错误是模型自己能纠的，不该终止：回喂一条纠错消息，并把重试计入步数
      messages.push({
        role: "user",
        content: `Your last output could not be parsed: ${parsed.error.message}. Reply with a single tool call or a final summary.`,
      })
      deps.metrics.increment("model.format_error")
      continue
    }
    const decided = parsed.data

    // 记录 assistant 这一步（含 tool_use 块），保证后续 tool_result 能配对
    if (decided.type === "tool_use") {
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: decided.callId,
            name: decided.toolName,
            input: decided.args as Record<string, unknown>,
          },
        ],
      })
    }

    /* ---- ⑤ final：验证并交付 ---- */
    if (decided.type === "final") {
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
    if (decided.type === "ask") {
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

    /* ---- ⑦ 工具执行 ---- */
    const tool = deps.registry.get(decided.toolName)
    const callId = decided.callId || newCallId()
    const argsRecord = (decided.args ?? {}) as Record<string, unknown>

    yield await sink.emit("tool.started", {
      callId,
      tool: decided.toolName,
      risk: tool?.risk ?? "read",
    })
    const startedAt = now()
    deps.metrics.increment(`tool.invoked`)
    deps.metrics.increment(`tool.${decided.toolName}.invoked`)

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
      toolName: decided.toolName,
      inputHash: sha256(stableStringify(argsRecord)),
      idempotencyKey: parameterHash({ tool: decided.toolName, args: argsRecord }),
      idempotency: tool?.idempotency ?? "non_idempotent",
      status: "started",
      startedAt: startedAt.toISOString(),
      retryCount: 0,
    })

    const policyArgs = { ...argsRecord }
    // 工具自己声明的"这次要跑哪条命令"：补默认值后交给策略引擎判断，
    // 引擎只认结构化请求，不做任何文本猜测（ADR-8）。
    const policyCommand = tool?.policyCommand?.(argsRecord)
    const outcome = await deps.executor.execute({
      toolName: decided.toolName,
      args: argsRecord,
      ctx: buildToolContext(deps, options, callId, changedFiles, state.workspaceRoot),
      decide: async (args) =>
        deps.policy.evaluate({
          toolName: decided.toolName,
          risk: tool?.risk ?? "read",
          args,
          ...(policyCommand ? { command: normalizeCommandRequest(policyCommand) } : {}),
          ...(tool?.policyPaths ? { paths: tool.policyPaths(argsRecord) } : {}),
          ...(tool?.policyDomains ? { domains: tool.policyDomains(argsRecord) } : {}),
          permissionMode: options.permissionMode,
          taskMode: options.mode,
        }),
      taskMode: options.mode,
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
      await flushMessages()
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
        await deps.store.updateTask(
          options.taskId,
          { status: "awaiting_approval", usage },
          latestState.stateVersion,
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

    if (result.error?.code === "TOOL_PERMISSION_DENIED") {
      permissionDenials.push({ toolName: result.toolName, reason: result.error.message })
      deps.metrics.increment("policy.decision.deny")
    } else {
      deps.metrics.increment("policy.decision.allow")
    }

    /* ---- ⑧ 结果回灌（错误也是数据） ---- */
    const resultText = renderToolResultForModel(result)
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: callId,
          content: resultText,
          isError: result.status !== "succeeded",
        },
      ],
    })
    // 把 assistant 的 tool_use 与本轮的 tool_result 一起落库（配对关系不能拆开）
    await flushMessages()

    /* ---- ⑨ 进度守卫 ---- */
    try {
      progressGuard.assertProgress({
        toolName: result.toolName,
        argsFingerprint: sha256(stableStringify(policyArgs)),
        resultFingerprint: fingerprintResult(result.output ?? result.error),
        ok: result.status === "succeeded",
        changedFiles: [...changedFiles],
        ...(result.error ? { errorCode: result.error.code } : {}),
      })
    } catch (err) {
      const appError = toAppError(err, "NO_PROGRESS")
      const diagnosis = progressGuard.buildDiagnosis()
      if (appError.details?.action === "stop-and-escalate") {
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
      messages.push({
        role: "user",
        content: `[progress-guard] ${appError.message}\n\n${diagnosis}\n\nForm a new hypothesis and change your approach.`,
      })
      progressGuard.reset()
      deps.metrics.increment("loop.no_progress")
      yield await sink.emit("task.warning", { reason: "no_progress_compressed", diagnosis })
    }

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
    void policyArgs
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
  _options: LoopOptions,
  userRequest: string,
): Promise<ModelMessage[]> {
  const { buildUserRequest } = await import("../context/system-prompt.js")
  return [{ role: "user", content: buildUserRequest(userRequest) }]
}

function buildToolContext(
  deps: LoopDeps,
  options: LoopOptions,
  callId: string,
  changedFiles: Set<string>,
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
    trackRead: (p: string, mtimeMs: number) => {
      // 已读表由 EditEngine 持有（read-before-edit 的唯一来源）
      void p
      void mtimeMs
    },
    readState: (p: string) => {
      const record = deps.editEngine.readRecord(p)
      return record ? { read: true, mtimeMs: record.mtimeMs } : undefined
    },
    trackWrite: (p: string) => {
      changedFiles.add(p)
    },
    persistArtifact: async (content: string, kind: string) =>
      persistArtifact(deps, options.taskId, content, kind),
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
