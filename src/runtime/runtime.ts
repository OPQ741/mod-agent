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
  ExecutionPlan,
  PermissionMode,
  TaskEvent,
  TaskMode,
} from "../shared/contracts.js"
import { DEFAULT_BUDGET } from "../shared/contracts.js"
import { AppError } from "../shared/errors.js"
import { newTaskId, shortId } from "../shared/ids.js"
import { sha256 } from "../shared/hash.js"
import { DEFAULT_SETTINGS, type Settings } from "../config/settings.js"
import { PathGuard } from "../policy/pathguard.js"
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
import type { Store } from "../store/types.js"
import { Logger, Metrics } from "../observability/logger.js"
import { bundleRules } from "../context/rules.js"
import {
  buildDynamicContext,
  buildRulesReminder,
  buildStaticSystemPrompt,
} from "../context/system-prompt.js"
import type { ValidationCheck } from "../validation/runner.js"
import { discoverChecks } from "../tools/builtin/command.js"
import { runTask, type LoopDeps, type LoopOptions, type LoopOutcome } from "./loop.js"
import { createUsage } from "../shared/contracts.js"
import { isResumable } from "./state-machine.js"
import { stripInvisibleCharacters } from "../shared/sanitize.js"

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

export class AgentRuntime {
  readonly settings: Settings
  readonly store: Store
  readonly registry: ToolRegistry
  readonly pathGuard: PathGuard
  readonly editEngine: EditEngine
  readonly executor: ToolExecutor
  readonly policy: PolicyEngine
  readonly gateway: ModelGateway
  readonly logger: Logger
  readonly metrics: Metrics
  readonly workspaceRoot: string

  private readonly sandboxSelection: SandboxSelection
  private readonly sandbox: SandboxBackend
  private readonly activatedDeferred = new Set<string>()
  private readonly planFiles = new Map<string, string>()
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
    this.editEngine = new EditEngine()

    this.policy = new PolicyEngine({
      settings: this.settings,
      cwd: this.workspaceRoot,
      hasTty: options.hasTty ?? false,
    })

    this.gateway = new ModelGateway({
      provider: options.provider,
      timeoutMs: this.settings.limits.modelTimeoutMs,
      maxRetries: this.settings.limits.modelMaxRetries,
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
    return new AgentRuntime(options, {
      store: storeResult.store,
      settings,
      sandboxSelection,
      ...(storeResult.degradedReason ? { degradedReason: storeResult.degradedReason } : {}),
    })
  }

  private registerBuiltinTools(): void {
    const repoCtx = {
      pathGuard: this.pathGuard,
      trackRead: (p: string, mtimeMs: number, content: string) => {
        this.editEngine.recordRead(p, mtimeMs, content)
      },
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

    const editDeps = {
      pathGuard: this.pathGuard,
      editEngine: this.editEngine,
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
        activate: (names) => {
          for (const name of names) this.activatedDeferred.add(name)
        },
      }),
    )
  }

  private planController(): PlanController {
    return {
      enter: () => {
        const taskId = "session"
        const planFilePath = path.join(
          this.workspaceRoot,
          ".mod",
          "plans",
          `plan-${taskId}-${shortId(6)}.md`,
        )
        this.planFiles.set(taskId, planFilePath)
        return { planFilePath }
      },
      exit: (plan: ExecutionPlan) => {
        const existing = this.planFiles.get("session")
        if (!existing) throw new AppError("INVALID_INPUT", "Not in plan mode")
        this.logger.info("plan.submitted", { steps: plan.steps.length })
        return { status: "submitted" as const, planFilePath: existing }
      },
      isActive: () => {
        return this.planFiles.has("session")
      },
      planFilePath: () => {
        return this.planFiles.get("session") ?? ""
      },
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
      // 默认值来自 BudgetSchema 本身（DEFAULT_BUDGET），不在此处另写一份
      budget: { ...DEFAULT_BUDGET, ...input.budget },
      usage: createUsage(this.now().getTime()),
    })
    this.logger.info("task.created", { taskId, mode: input.mode })
    return taskId
  }

  /**
   * 运行任务。返回 async generator —— 消费端不消费就不会继续跑（背压）。
   */
  async *run(
    taskId: string,
    options: RunOptions = {},
  ): AsyncGenerator<TaskEvent, LoopOutcome, void> {
    const state = await this.store.getTask(taskId)
    if (!state) throw new AppError("INVALID_INPUT", `Task not found: ${taskId}`)

    // 规则只注入一次：审批后 `--resume` 会再次调用 run()，
    // 若每次都 append 一份规则提醒，上下文里会攒出 N 份同样的 AGENTS.md。
    const existingMessages = await this.store.getMessages(taskId)
    const isFirstRun = existingMessages.length === 0
    const wantRules = isFirstRun && options.skipProjectRules !== true
    const rules = wantRules ? await bundleRules(this.workspaceRoot) : { combined: "" }
    if (wantRules && rules.combined.length > 0) {
      await this.store.appendMessages(taskId, [
        { role: "user", content: buildRulesReminder(rules.combined) },
      ])
    }
    const assembled = this.registry.assemble({
      taskMode: state.mode,
      permissionMode: this.settings.permissionMode ?? "default",
      activatedDeferred: this.activatedDeferred,
    })

    const systemPrompt = buildStaticSystemPrompt({
      toolNames: assembled.specs.map((spec) => spec.name),
      deferredToolNames: assembled.deferredNames,
      toolPrompts: assembled.executable
        .map((name) => this.registry.get(name)?.prompt?.())
        .filter((p): p is string => typeof p === "string" && p.length > 0),
    })

    const validationChecks = options.validationChecks ?? (await this.autoDiscoverChecks())

    const deps: LoopDeps = {
      store: this.store,
      registry: this.registry,
      executor: this.executor,
      gateway: this.gateway,
      policy: this.policy,
      pathGuard: this.pathGuard,
      editEngine: this.editEngine,
      settings: this.settings,
      logger: this.logger,
      metrics: this.metrics,
      runCommand: (req) => this.sandbox.exec(normalize(req), options.signal),
      planFilePath: () => this.planFiles.get("session"),
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
          // round 是**本次 run 内**的轮次；恢复续跑时 state.usage.rounds 才是总账，
          // 两者相加，否则每次 resume 都会把"还剩多少轮"重新报满。
          roundsLeft: Math.max(0, state.budget.maxRounds - (state.usage.rounds + round)),
          changedFiles: this.editEngine.trackedFiles,
          now: this.now().toISOString(),
        }),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(validationChecks.length > 0 ? { validationChecks } : {}),
      ...(options.compactionEnabled !== undefined
        ? { compactionEnabled: options.compactionEnabled }
        : {}),
    }

    // `return yield*`：把内层生成器的返回值透传为本生成器的返回值，
    // 这样消费端 `await gen.next()` 拿到的 done.value 就是 LoopOutcome。
    return yield* runTask(deps, loopOptions)
  }

  /** 暂停：不再开始新的工具调用，保存现场后退出。 */
  async pause(taskId: string): Promise<void> {
    const state = await this.store.getTask(taskId)
    if (!state) throw new AppError("INVALID_INPUT", `Task not found: ${taskId}`)
    await this.store.updateTask(taskId, { status: "paused" }, state.stateVersion)
    await this.appendEvent(taskId, "task.status_changed", { from: state.status, to: "paused" })
  }

  /** 取消：记录原因，不假装能回滚已发生的外部副作用。 */
  async cancel(taskId: string, reason = "cancelled by user"): Promise<void> {
    const state = await this.store.getTask(taskId)
    if (!state) throw new AppError("INVALID_INPUT", `Task not found: ${taskId}`)
    await this.store.updateTask(
      taskId,
      { status: "cancelled", cancelRequestedAt: this.now().toISOString() },
      state.stateVersion,
    )
    await this.appendEvent(taskId, "task.cancelled", { reason })
  }

  /** 恢复：先检查未闭合的工具调用，再决定重跑 / 查证 / 标记未知。 */
  async resume(
    taskId: string,
  ): Promise<{ resumed: boolean; openCalls: number; unknownOutcomes: string[] }> {
    const state = await this.store.getTask(taskId)
    if (!state) throw new AppError("INVALID_INPUT", `Task not found: ${taskId}`)
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

    await this.store.updateTask(taskId, { status: "queued" }, state.stateVersion)
    await this.appendEvent(taskId, "task.status_changed", {
      from: state.status,
      to: "queued",
      openCalls: openCalls.length,
      unknownOutcomes,
    })
    return { resumed: true, openCalls: openCalls.length, unknownOutcomes }
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
      normalize({
        executable: "git",
        args: options.statOnly ? ["diff", "--stat"] : ["diff"],
        cwd: options.cwd ?? this.workspaceRoot,
        timeoutMs: 30_000,
        networkProfile: "none",
        reason: "Show the current workspace diff to the user",
        onTimeout: "kill",
      }),
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
): import("../shared/contracts.js").CommandRequest {
  return {
    executable: req.executable,
    args: req.args ?? [],
    cwd: req.cwd,
    timeoutMs: req.timeoutMs ?? DEFAULT_SETTINGS.limits.commandTimeoutMs,
    networkProfile: req.networkProfile ?? "none",
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
