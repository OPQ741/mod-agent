/**
 * AgentRuntime：把各模块装配成一个可跑的系统（development-guide.md §3 依赖顺序）。
 *
 * 依赖拓扑：
 *   shared → model → tools → policy → runtime → store
 *
 * `runtime` 不直接 import `fs` / `child_process` / 模型厂商 SDK，一律通过接口注入
 * （architecture.md §6 边界约束）。CLI 与 SDK 共用这一个内核（ADR-10），
 * 两前端只是入参与输出适配，避免同一 loop 因入口不同而行为漂移。
 */

import path from "node:path"
import { promises as fs } from "node:fs"
import os from "node:os"
import type {
  Budget,
  CommandResult,
  PermissionMode,
  TaskEvent,
  TaskMode,
} from "../shared/contracts.js"
import { DEFAULT_BUDGET, isTerminalStatus } from "../shared/contracts.js"
import { AppError } from "../shared/errors.js"
import { newTaskId } from "../shared/ids.js"
import { sha256 } from "../shared/hash.js"
import { DEFAULT_SETTINGS, type Settings } from "../config/settings.js"
import { PathGuard, loadGitignorePatterns } from "../policy/pathguard.js"
import { PolicyEngine } from "../policy/engine.js"
import { EditEngine } from "../patch/edit.js"
import { ToolRegistry } from "../tools/registry.js"
import { ToolExecutor } from "../tools/executor.js"
import {
  createCommandRunTool,
  createTestRunTool,
  type DiscoveredCheck,
} from "../tools/builtin/command.js"
import { createEditFileTool, createWriteFileTool } from "../tools/builtin/edit.js"
import {
  createGitStatusTool,
  createListFilesTool,
  createReadDiffTool,
  createReadFileTool,
  createSearchTextTool,
} from "../tools/builtin/repo.js"
import {
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createToolSearchTool,
  type DeferredToolEntry,
  type PlanController,
} from "../tools/builtin/plan.js"
import { selectSandbox, type SandboxBackend } from "../sandbox/index.js"
import type { SandboxSelection } from "../sandbox/index.js"
import { ModelGateway } from "../model/gateway.js"
import type { ModelProvider } from "../model/types.js"
import { createStore } from "../store/sqlite.js"
import type { Store, TaskState } from "../store/types.js"
import { Logger, Metrics } from "../observability/logger.js"
import { bundleRules } from "../context/rules.js"
import { buildDynamicContext, buildStaticSystemPrompt } from "../context/system-prompt.js"
import type { ValidationCheck } from "../validation/runner.js"
import { discoverChecks } from "../tools/builtin/command.js"
import { runTask, type LoopDeps, type LoopOptions, type LoopOutcome } from "./loop.js"
import { createUsage } from "../shared/contracts.js"
import { canTransition, isResumable } from "./state-machine.js"
import { updateTaskWithRetry } from "./task-write.js"
import { redactSecrets, stripInvisibleCharacters } from "../shared/sanitize.js"

export interface RuntimeOptions {
  workspaceRoot: string
  settings?: Settings
  provider: ModelProvider
  store?: Store
  logger?: Logger
  metrics?: Metrics
  /** SQLite 文件路径；不传则用内存 store。 */
  sqliteFile?: string
  hasTty?: boolean
  /**
   * 关闭流式（`--no-stream`）。
   *
   * 只影响"这次运行用不用流式"，不改变 provider 的协议能力声明；
   * 网关会把两者取交集后交给主循环判断。
   */
  streaming?: boolean
  now?: () => Date
}

export interface CreateTaskInput {
  title: string
  userRequest: string
  mode?: TaskMode
  permissionMode?: PermissionMode
  budget?: Partial<Budget>
  acceptanceCriteria?: Array<{ id: string; description: string }>
}

export interface RunOptions {
  signal?: AbortSignal
  /** 交付前要跑的验证命令；不传则自动从 package.json 发现。 */
  validationChecks?: readonly ValidationCheck[]
  compactionEnabled?: boolean
  /**
   * 不加载仓库的 AGENTS.md / CLAUDE.md（`--bare`）。
   * CI 里跑无人值守任务时，仓库自带的规则不该成为影响结果的隐藏变量。
   */
  skipProjectRules?: boolean
}

/** 单个任务独占的运行态；任务结束即销毁，不复用到下一个任务。 */
interface TaskScopedState {
  planModeActive: boolean
  activatedDeferred: Set<string>
}

export class AgentRuntime {
  readonly settings: Settings
  readonly store: Store
  readonly registry: ToolRegistry
  readonly pathGuard: PathGuard
  readonly executor: ToolExecutor
  readonly policy: PolicyEngine
  readonly gateway: ModelGateway
  readonly logger: Logger
  readonly metrics: Metrics
  readonly workspaceRoot: string

  private readonly sandboxSelection: SandboxSelection
  private readonly sandbox: SandboxBackend
  /**
   * **任务级**运行态：计划模式开关 + 已被 `tool_search` 激活的延迟工具。
   *
   * 曾经这里是两个 runtime 级字段（`planModeActive` 布尔 + 全局
   * `activatedDeferred` 集合）。只要上层把同一个 Runtime 交给两个任务
   * （SDK、调度器、并行 CLI），就会互相污染：任务 A 进了计划模式，
   * 任务 B 也被降成只读；A 激活的延迟工具，B 的上下文里也会多出 schema。
   * 计划模式与延迟加载本来都只对"当前这个任务"有意义，作用域必须是 taskId。
   */
  private readonly taskStates = new Map<string, TaskScopedState>()
  /**
   * 正在运行的任务集合（单飞锁）。
   *
   * 主循环对同一个 taskId 跑两次会同时请求模型、同时执行工具，
   * 事件序号按"已有事件数 + 1"分配、`(task_id, seq)` 又是唯一约束：
   * 两个循环会撞序号、重复副作用、互相覆盖状态。Runtime 一旦暴露给 SDK，
   * 这是必须明确的并发契约 —— 第一版先拒绝，而不是"看起来能用"。
   */
  private readonly runningTasks = new Set<string>()
  private readonly storeDegradedReason: string | undefined
  private readonly now: () => Date

  private constructor(
    options: RuntimeOptions,
    assembled: {
      store: Store
      settings: Settings
      sandboxSelection: SandboxSelection
      degradedReason?: string
    },
  ) {
    this.workspaceRoot = path.resolve(options.workspaceRoot)
    this.settings = assembled.settings
    this.store = assembled.store
    this.sandboxSelection = assembled.sandboxSelection
    this.sandbox = assembled.sandboxSelection.backend
    this.storeDegradedReason = assembled.degradedReason
    this.logger = options.logger ?? new Logger({ level: "warn" })
    this.metrics = options.metrics ?? new Metrics()
    this.now = options.now ?? (() => new Date())

    this.pathGuard = new PathGuard({
      workspaceRoot: this.workspaceRoot,
      respectGitignore: this.settings.respectGitignore,
    })
    /**
     * 这里**不再**建一个 runtime 级的 EditEngine。
     *
     * 已读表是 read-before-edit 的唯一依据，必须是任务级状态（见 `run()`）。
     * 曾经这里有 `this.editEngine = new EditEngine()`，整个 REPL 共用一张表：
     * 任务 A 读过 `src/a.ts` 之后，任务 B 不读直接改也会通过校验。
     */

    this.policy = new PolicyEngine({
      settings: this.settings,
      cwd: this.workspaceRoot,
      hasTty: options.hasTty ?? false,
    })

    this.gateway = new ModelGateway({
      provider: options.provider,
      timeoutMs: this.settings.limits.modelTimeoutMs,
      maxRetries: this.settings.limits.modelMaxRetries,
      ...(options.streaming === false ? { streaming: false } : {}),
      onRetry: (event) => {
        this.metrics.increment("model.retry")
        this.logger.info("retry.api", { ...event })
      },
    })

    this.registry = new ToolRegistry()
    this.registerBuiltinTools()

    this.executor = new ToolExecutor({
      registry: this.registry,
      policyVersion: this.policyVersion(),
      persistThresholdTokens: Math.floor(this.settings.limits.readMaxOutputTokens / 3),
    })
  }

  /* ---------------- 构造 ---------------- */

  static async create(options: RuntimeOptions): Promise<AgentRuntime> {
    const settings = options.settings ?? DEFAULT_SETTINGS
    const storeResult = options.store
      ? { store: options.store, degradedReason: undefined as string | undefined }
      : await createStore({ sqliteFile: options.sqliteFile })
    const sandboxSelection = await selectSandbox({
      settings,
      workspaceRoot: path.resolve(options.workspaceRoot),
      assertCwd: (cwd) =>
        new PathGuard({ workspaceRoot: path.resolve(options.workspaceRoot) }).assertCwd(cwd),
    })
    const runtime = new AgentRuntime(options, {
      store: storeResult.store,
      settings,
      sandboxSelection,
      ...(storeResult.degradedReason ? { degradedReason: storeResult.degradedReason } : {}),
    })
    /**
     * gitignore 规则必须在这里补进去：`PathGuard` 的构造是同步的，
     * 读 `.gitignore` 是异步的，只能分两步。
     * `respectGitignore` 关掉时不必读盘 —— 读来的规则也不会被用到。
     */
    if (settings.respectGitignore) {
      runtime.pathGuard.setGitignorePatterns(await loadGitignorePatterns(runtime.workspaceRoot))
    }
    return runtime
  }

  private registerBuiltinTools(): void {
    const repoCtx = {
      pathGuard: this.pathGuard,
      excludeDirs: this.settings.excludeDirs,
    }

    this.registry.register(createListFilesTool(repoCtx))
    this.registry.register(
      createReadFileTool(repoCtx, {
        maxBytes: this.settings.limits.readMaxBytes,
        maxOutputTokens: this.settings.limits.readMaxOutputTokens,
      }),
    )
    this.registry.register(createSearchTextTool(repoCtx))
    this.registry.register(createGitStatusTool(repoCtx))
    this.registry.register(createReadDiffTool(repoCtx))

    /**
     * 编辑工具不再持有引擎：它从 `ctx.editEngine` 取**当前任务**的会话。
     * 工具是在 runtime 构造期注册的、任务是在运行期创建的，若在这里绑定一个
     * 引擎实例，就等于把"一个任务一套已读表"变成"一个 runtime 一套"。
     */
    const editDeps = {
      pathGuard: this.pathGuard,
    }
    this.registry.register(createEditFileTool(editDeps))
    this.registry.register(createWriteFileTool(editDeps))

    this.registry.register(createCommandRunTool({ pathGuard: this.pathGuard }))
    this.registry.register(
      createTestRunTool({
        pathGuard: this.pathGuard,
        readPackageJson: async (cwd) => readPackageJson(cwd),
      }),
    )

    const planController = this.planController()
    this.registry.registerWithLengthCheck(createEnterPlanModeTool(planController), "builtin")
    this.registry.registerWithLengthCheck(createExitPlanModeTool(planController), "builtin")
    this.registry.register(
      createToolSearchTool({
        listDeferred: () => this.deferredToolEntries(),
        activate: (names, taskId) => {
          const state = this.taskState(taskId)
          for (const name of names) state.activatedDeferred.add(name)
        },
      }),
    )
  }

  /**
   * 取（必要时创建）某个任务的运行态。
   *
   * 只有真正跑起来的任务才会走到这里；`run()` 结束时会删掉对应条目，
   * 所以 Map 的大小与"当前活跃任务数"成正比，不会随历史任务无限增长。
   */
  private taskState(taskId: string): TaskScopedState {
    let state = this.taskStates.get(taskId)
    if (!state) {
      state = { planModeActive: false, activatedDeferred: new Set<string>() }
      this.taskStates.set(taskId, state)
    }
    return state
  }

  private planController(): PlanController {
    return {
      enter: (taskId) => {
        this.taskState(taskId).planModeActive = true
        this.logger.info("plan.entered", { taskId, workspaceRoot: this.workspaceRoot })
        return { active: true as const }
      },
      exit: (plan, taskId) => {
        const state = this.taskStates.get(taskId)
        if (!state?.planModeActive) throw new AppError("INVALID_INPUT", "Not in plan mode")
        state.planModeActive = false
        this.logger.info("plan.submitted", { taskId, steps: plan.steps.length })
        return { status: "submitted" as const, steps: plan.steps.length }
      },
      isActive: (taskId) => this.taskStates.get(taskId)?.planModeActive ?? false,
    }
  }

  private deferredToolEntries(): DeferredToolEntry[] {
    return this.registry
      .entries()
      .filter((entry) => entry.tool.deferred)
      .map((entry) => ({
        name: entry.name,
        description: entry.tool.description,
        keywords: entry.name.split(/[._]/),
      }))
  }

  /** 策略版本：配置变化时版本号随之变化，审批因此不会跨策略复用。 */
  policyVersion(): string {
    return sha256(
      JSON.stringify({
        allow: this.settings.permissions.allow,
        ask: this.settings.permissions.ask,
        deny: this.settings.permissions.deny,
        mode: this.settings.permissionMode,
      }),
    ).slice(0, 16)
  }

  /* ---------------- 任务生命周期 ---------------- */

  async createTask(input: CreateTaskInput): Promise<string> {
    const sanitized = stripInvisibleCharacters(input.userRequest)
    const taskId = newTaskId()
    await this.store.createTask({
      id: taskId,
      title: input.title,
      userRequest: sanitized.text,
      mode: input.mode ?? this.settings.mode ?? "plan",
      status: "queued",
      workspaceRoot: this.workspaceRoot,
      // 三层来源，后者覆盖前者：schema 默认值 → 配置文件 budget → 调用方显式预算。
      // 之前只合并了后两者，`settings.budget`（配置文件里写的 maxRounds / maxCostUsd）
      // 从来没被读过，等于一份沉默的配置。
      budget: { ...DEFAULT_BUDGET, ...this.settings.budget, ...input.budget },
      usage: createUsage(this.now().getTime()),
    })
    this.logger.info("task.created", { taskId, mode: input.mode })
    return taskId
  }

  /**
   * 运行任务。返回 async generator —— 消费端不消费就不会继续跑（背压）。
   *
   * 这一层只负责两件事：**单飞锁**与**任务级状态的生命周期**。
   * 真正的循环逻辑在 `runInternal`；把锁放在生成器体里（而不是 `run()` 调用时），
   * 保证"创建了生成器但从未消费"不会占用锁，也不会残留计划模式状态。
   */
  async *run(
    taskId: string,
    options: RunOptions = {},
  ): AsyncGenerator<TaskEvent, LoopOutcome, void> {
    const existing = await this.store.getTask(taskId)
    if (!existing) throw new AppError("INVALID_INPUT", `Task not found: ${taskId}`)
    if (this.runningTasks.has(taskId)) {
      throw new AppError(
        "INVALID_INPUT",
        `Task ${taskId} is already running in this runtime. ` +
          "Two concurrent loops on the same task would duplicate tool side effects and collide on event seq. " +
          "Wait for the current run to finish (or cancel it) before starting another.",
        { details: { taskId } },
      )
    }

    this.runningTasks.add(taskId)
    const scoped = this.taskState(taskId)
    try {
      return yield* this.runInternal(taskId, existing, options, scoped)
    } finally {
      /**
       * 任务收尾即销毁任务级状态。
       *
       * 计划模式是"这个任务此刻只读"的表达，不是会话设置：任务以取消、失败、
       * 预算耗尽等任何方式结束时，都必须把开关收回去。否则一个没来得及调用
       * `exit_plan_mode` 的任务会让**下一个**任务也变成只读 —— 而且是静默的。
       */
      this.runningTasks.delete(taskId)
      this.taskStates.delete(taskId)
    }
  }

  private async *runInternal(
    taskId: string,
    state: TaskState,
    options: RunOptions,
    scoped: TaskScopedState,
  ): AsyncGenerator<TaskEvent, LoopOutcome, void> {
    // 规则只注入一次：审批后 `--resume` 会再次调用 run()，
    // 若每次都拼一份规则提醒，上下文里会攒出 N 份同样的 AGENTS.md。
    //
    // 注意：这里**不能**先把规则写进 store 再交给循环 —— 循环用
    // `state.messages.length === 0` 判断"是否全新任务"，一旦 store 里先有了
    // 规则消息，它就再也不会 seed 用户请求，模型只看到规则、不知道要做什么。
    // 所以规则作为参数传下去，由循环在种子消息里一起写入。
    const existingMessages = await this.store.getMessages(taskId)
    const isFirstRun = existingMessages.length === 0
    const wantRules = isFirstRun && options.skipProjectRules !== true
    const rules = wantRules ? await bundleRules(this.workspaceRoot) : { combined: "" }
    const assembled = this.registry.assemble({
      taskMode: state.mode,
      permissionMode: this.settings.permissionMode ?? "default",
      activatedDeferred: scoped.activatedDeferred,
    })

    const systemPrompt = buildStaticSystemPrompt({
      toolNames: assembled.specs.map((spec) => spec.name),
      deferredToolNames: assembled.deferredNames,
      toolPrompts: assembled.executable
        .map((name) => this.registry.get(name)?.prompt?.())
        .filter((p): p is string => typeof p === "string" && p.length > 0),
    })

    const validationChecks = options.validationChecks ?? (await this.autoDiscoverChecks())

    /**
     * **每个任务一套编辑会话。**
     *
     * 已读表、mtime 记录都挂在这里，任务结束即弃。同一 Runtime 连续跑多个任务时，
     * 后一个任务不会继承前一个任务的"已读"状态 —— read-before-edit 才是真的
     * 按任务生效，而不是按进程生效。
     */
    const editEngine = new EditEngine()

    const deps: LoopDeps = {
      store: this.store,
      registry: this.registry,
      executor: this.executor,
      gateway: this.gateway,
      policy: this.policy,
      pathGuard: this.pathGuard,
      editEngine,
      settings: this.settings,
      logger: this.logger,
      metrics: this.metrics,
      runCommand: (req, runOptions) =>
        this.sandbox.exec(
          normalize(req, this.sandbox.defaultNetworkProfile),
          options.signal,
          /**
           * 增量输出在离开内核前就脱敏。
           *
           * 这条路径直接通往用户终端（`tool.progress`），不经过"工具结果回灌模型"
           * 那一步的脱敏处理。若把 `npm run deploy` 打出来的 token 原样转发，
           * 它就会同时出现在终端和事件表里 —— 两份都是不该留的副本。
           */
          {
            ...(runOptions?.onOutput
              ? {
                  onOutput: (chunk) =>
                    runOptions.onOutput?.({
                      stream: chunk.stream,
                      text: redactSecrets(chunk.text).text,
                    }),
                }
              : {}),
          },
        ),
      isPlanModeActive: () => scoped.planModeActive,
      activatedDeferred: () => scoped.activatedDeferred,
    }

    const loopOptions: LoopOptions = {
      taskId,
      mode: state.mode,
      permissionMode: this.settings.permissionMode ?? "default",
      systemPrompt,
      dynamicContext: (round) =>
        buildDynamicContext({
          cwd: this.workspaceRoot,
          workspaceRoot: this.workspaceRoot,
          platform: process.platform,
          mode: state.mode,
          // `round` 是**累计**轮次（主循环从 `state.usage.rounds` 接着数），
          // 所以这里不能再加一遍 `state.usage.rounds`：那会把剩余轮次算少一半，
          // 恢复续跑时表现为"模型突然觉得只剩几轮了"，开始草率收尾。
          roundsLeft: Math.max(0, state.budget.maxRounds - round),
          changedFiles: editEngine.trackedFiles,
          now: this.now().toISOString(),
        }),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(validationChecks.length > 0 ? { validationChecks } : {}),
      ...(rules.combined.length > 0 ? { projectRules: rules.combined } : {}),
      ...(options.compactionEnabled !== undefined
        ? { compactionEnabled: options.compactionEnabled }
        : {}),
    }

    // `return yield*`：把内层生成器的返回值透传为本生成器的返回值，
    // 这样消费端 `await gen.next()` 拿到的 done.value 就是 LoopOutcome。
    return yield* runTask(deps, loopOptions)
  }

  /**
   * 暂停：不再开始新的工具调用，保存现场后退出。
   *
   * 三条纪律与 `cancel()` 相同：走状态机（不是硬写）、幂等、冲突重试。
   * 之前这里既没校验迁移合法性（`completed → paused` 会写进去，破坏状态机），
   * 也没重试（与循环收尾竞争时把 `VersionConflictError` 抛给调用方）。
   */
  async pause(taskId: string): Promise<void> {
    const result = await updateTaskWithRetry(
      this.store,
      taskId,
      { status: "paused" },
      {
        stopIf: (state) =>
          state.status === "paused" || !canTransition(state.status, "paused").allowed,
      },
    )
    if (!result.applied) {
      await this.appendEvent(taskId, "task.warning", {
        reason: "pause_ignored",
        status: result.state.status,
        detail: result.reason,
      })
      return
    }
    await this.appendEvent(taskId, "task.status_changed", {
      from: result.previous?.status ?? result.state.status,
      to: "paused",
    })
  }

  /**
   * 取消：记录"取消请求"并把状态推进到 `cancelling`，由主循环收口为 `cancelled`。
   *
   * 为什么不直接写 `cancelled`：`executing → cancelled` **不在状态机迁移表里**
   * （必须经 `cancelling`）。直接写会让库停在 executing、而调用方以为已取消；
   * 之后 `--continue` 还会把它当成可恢复任务再跑一遍。
   *
   * 取消是**幂等**的：任务已在 `cancelling` 或已到终态时不再改状态，只留一条告警，
   * 不抛错 —— 用户连点两次取消不该收到一个异常。
   */
  async cancel(taskId: string, reason = "cancelled by user"): Promise<void> {
    const result = await updateTaskWithRetry(
      this.store,
      taskId,
      { status: "cancelling", cancelRequestedAt: this.now().toISOString() },
      {
        stopIf: (state) =>
          isTerminalStatus(state.status) ||
          state.status === "cancelling" ||
          !canTransition(state.status, "cancelling").allowed,
      },
    )
    if (!result.applied) {
      await this.appendEvent(taskId, "task.warning", {
        reason: "cancel_ignored",
        status: result.state.status,
        detail: result.reason,
      })
      return
    }
    await this.appendEvent(taskId, "task.cancelled", { reason, phase: "requested" })
  }

  /** 恢复：先检查未闭合的工具调用，再决定重跑 / 查证 / 标记未知。 */
  async resume(
    taskId: string,
  ): Promise<{ resumed: boolean; openCalls: number; unknownOutcomes: string[] }> {
    const state = await this.store.getTask(taskId)
    if (!state) throw new AppError("INVALID_INPUT", `Task not found: ${taskId}`)
    /**
     * 停在 `cancelling` 的任务不该可恢复。
     *
     * 这通常意味着"取消请求已经落库、但收口没来得及执行"（进程在中间被杀）。
     * 以前这里会抛"不可恢复"，任务就永远卡在 `cancelling` —— 既不能续跑，
     * 也不能被 `--continue` 清理。这里顺手把终态补上，再如实告诉调用方。
     */
    if (state.status === "cancelling") {
      await updateTaskWithRetry(
        this.store,
        taskId,
        { status: "cancelled" },
        { stopIf: (current) => isTerminalStatus(current.status) },
      )
      await this.appendEvent(taskId, "task.status_changed", {
        from: "cancelling",
        to: "cancelled",
        reason: "closed_dangling_cancelling",
      })
      throw new AppError(
        "INVALID_INPUT",
        `Task ${taskId} had a pending cancel request; it is now closed as cancelled`,
      )
    }
    if (!isResumable(state.status)) {
      throw new AppError(
        "INVALID_INPUT",
        `Task ${taskId} is in status "${state.status}" and cannot be resumed`,
      )
    }

    const openCalls = await this.store.openToolCalls(taskId)
    const unknownOutcomes: string[] = []
    for (const call of openCalls) {
      if (call.idempotency === "safe") {
        // 只读工具：重跑无害
        continue
      }
      // 非幂等且结果未知：进终态、问人，不自动重放（development-guide.md §5 第四件）
      await this.store.finishToolCall(call.id, { status: "outcome_unknown" })
      unknownOutcomes.push(call.id)
    }

    const requeued = await updateTaskWithRetry(
      this.store,
      taskId,
      { status: "queued" },
      /**
       * 守卫只看终态与 `cancelling`。
       *
       * 恢复的真实路径是 `awaiting_approval → queued`（审批后重新排队），
       * 而这一条不在迁移表里 —— 套用 `canTransition` 会把所有"审批后续跑"挡成 `resumed: false`。
       */
      {
        stopIf: (current) => isTerminalStatus(current.status) || current.status === "cancelling",
      },
    )
    await this.appendEvent(taskId, "task.status_changed", {
      from: state.status,
      to: "queued",
      openCalls: openCalls.length,
      unknownOutcomes,
    })
    return { resumed: requeued.applied, openCalls: openCalls.length, unknownOutcomes }
  }

  /**
   * 审批决策。
   *
   * 审批**只生效一次**且与 `parameterHash` 绑定：批准 `npm test` 不等于批准
   * `npm install lodash`。参数变了必须重新问。
   */
  async decideApproval(
    approvalId: string,
    decision: "allowed" | "denied",
    by: string,
    options?: { parameterHash?: string; reason?: string },
  ): Promise<void> {
    const approval = await this.store.getApproval(approvalId)
    if (!approval) throw new AppError("INVALID_INPUT", `Approval not found: ${approvalId}`)
    if (options?.parameterHash && options.parameterHash !== approval.parameterHash) {
      throw new AppError(
        "APPROVAL_DENIED",
        "Parameter hash mismatch: the action changed since it was requested. Re-approval is required.",
      )
    }
    const record = await this.store.decideApproval(approvalId, decision, by, options?.reason)
    if (decision === "allowed") {
      // 会话级放行：只在本会话有效、不写回配置，且按 parameterHash 记账
      this.policy.grantSessionAllowHash(approval.toolName, approval.parameterHash)
    }
    await this.appendEvent(approval.taskId, "approval.decided", {
      approvalId,
      tool: approval.toolName,
      decision,
      by,
      parameterHash: approval.parameterHash,
    })
    void record
  }

  /**
   * 校验一次带参数的动作是否已被批准（审批绑定参数的具体落点）。
   *
   * 只查「会话级放行表」：批准动作在 `decideApproval` 里已经写入该表，
   * 而 store 层保证审批**只生效一次**（重复 decide 直接报错），
   * 所以这里不需要再去查审批记录 —— 查到 `pending` 恰恰说明还没批。
   * 判定按 `parameterHash` 而非参数对象，换键序不能绕过（shared/hash.ts）。
   */
  async isApproved(toolName: string, args: Record<string, unknown>): Promise<boolean> {
    return this.policy.hasSessionAllow(toolName, args)
  }

  /**
   * 只读取回工作区 diff（`/diff`、交付报告用）。
   *
   * 走的是**同一个沙箱通道**，不另外开一条 exec 路径 —— 否则"给 CLI 看一眼 diff"
   * 就会变成绕过策略与审计的第二条命令通道，这是最容易在后期被滥用的口子。
   */
  async diff(options: { statOnly?: boolean; cwd?: string } = {}): Promise<CommandResult> {
    return this.sandbox.exec(
      normalize(
        {
          executable: "git",
          args: options.statOnly ? ["diff", "--stat"] : ["diff"],
          cwd: options.cwd ?? this.workspaceRoot,
          timeoutMs: 30_000,
          networkProfile: "none",
          reason: "Show the current workspace diff to the user",
          onTimeout: "kill",
        },
        this.sandbox.defaultNetworkProfile,
      ),
    )
  }

  /** 自动发现验证命令（verification-and-multiagent.md §2）。 */
  async autoDiscoverChecks(): Promise<ValidationCheck[]> {
    const packageJson = await readPackageJson(this.workspaceRoot)
    const checks: DiscoveredCheck[] = discoverChecks(packageJson)
    return checks.map((check) => ({
      id: check.id,
      kind: toKind(check.id),
      command: check.command,
      required: check.id === "test" || check.id === "typecheck",
      cwd: this.workspaceRoot,
      /**
       * 来源必须标出来。这些命令来自仓库里的 `package.json`，属于**仓库内容**，
       * 不能自己授权自己去执行 —— 判定见 `PolicyEngine.evaluateValidation`。
       */
      source: "discovered" as const,
    }))
  }

  /** 环境自检（CLI 的 `doctor` 子命令）。 */
  async doctor(): Promise<DoctorReport> {
    const packageJson = await readPackageJson(this.workspaceRoot)
    return {
      workspaceRoot: this.workspaceRoot,
      node: process.version,
      platform: process.platform,
      storeKind: this.store.kind,
      ...(this.storeDegradedReason ? { storeDegradedReason: this.storeDegradedReason } : {}),
      sandbox: {
        backend: this.sandbox.id,
        degraded: this.sandboxSelection.degraded,
        coverage: this.sandboxSelection.coverage,
      },
      tools: this.registry.names(),
      discoveredChecks: discoverChecks(packageJson).map((c) => ({ id: c.id, command: c.command })),
      settingsLayers: {
        mode: this.settings.mode,
        permissionMode: this.settings.permissionMode,
        allowRules: this.settings.permissions.allow.length,
        denyRules: this.settings.permissions.deny.length,
        askRules: this.settings.permissions.ask.length,
      },
      policyVersion: this.policyVersion(),
    }
  }

  async appendEvent(taskId: string, type: string, payload: unknown): Promise<void> {
    const events = await this.store.readAllEvents(taskId)
    const seq = events.length + 1
    await this.store.appendEvents(taskId, [
      {
        eventId: `${taskId}:${seq}`,
        taskId,
        seq,
        type,
        timestamp: this.now().toISOString(),
        payload,
        parentCallId: null,
      },
    ])
  }

  async close(): Promise<void> {
    await this.store.close()
  }
}

export interface DoctorReport {
  workspaceRoot: string
  node: string
  platform: NodeJS.Platform
  storeKind: "memory" | "sqlite"
  storeDegradedReason?: string
  sandbox: { backend: string; degraded: boolean; coverage: string[] }
  tools: string[]
  discoveredChecks: Array<{ id: string; command: string[] }>
  settingsLayers: {
    mode?: string
    permissionMode?: string
    allowRules: number
    denyRules: number
    askRules: number
  }
  policyVersion: string
}

function toKind(id: string): ValidationCheck["kind"] {
  switch (id) {
    case "typecheck":
      return "typecheck"
    case "lint":
      return "lint"
    case "build":
      return "build"
    default:
      return "test"
  }
}

function normalize(
  req: import("../shared/contracts.js").CommandRequestInput,
  defaultNetworkProfile: import("../shared/contracts.js").NetworkProfile,
): import("../shared/contracts.js").CommandRequest {
  return {
    executable: req.executable,
    args: req.args ?? [],
    cwd: req.cwd,
    timeoutMs: req.timeoutMs ?? DEFAULT_SETTINGS.limits.commandTimeoutMs,
    /**
     * 默认档位来自**后端能力**，不是写死的常量：
     * Docker 后端能真的断网 → 默认 `none`；受限子进程断不了 → 默认 `inherit`。
     */
    networkProfile: req.networkProfile ?? defaultNetworkProfile,
    reason: req.reason,
    onTimeout: req.onTimeout ?? "kill",
    ...(req.env ? { env: req.env } : {}),
  }
}

async function readPackageJson(cwd: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(path.join(cwd, "package.json"), "utf8")
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}

export { os }
