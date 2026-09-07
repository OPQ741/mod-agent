/**
 * 跨模块共享的契约定义（类型 + Zod schema）。
 *
 * 这一层是 ADR-8 与 ADR-3 的落点：
 * - 工具入参过 Zod（不靠提示词约束）；
 * - 命令拆成 `executable` + `args[]` 两个字段，而不是一整段字符串
 *   （否则策略引擎只能对字符串做正则，`&&` 串联与引号转义都能绕过去）。
 *
 * 字段命名沿用 docs/ 里已定义的名字，不新造一套。
 */

import { z } from "zod"

/* ------------------------------------------------------------------ *
 * 基础枚举
 * ------------------------------------------------------------------ */

/** overview.md §1.2：任务模式，决定 Agent 能执行的动作范围。 */
export const TaskModeSchema = z.enum(["ask", "plan", "edit", "autopilot"])
export type TaskMode = z.infer<typeof TaskModeSchema>

/**
 * security.md §4.2：权限档位。与 TaskMode 是两个正交轴 ——
 * 模式决定"做不做"，档位决定"做的时候要不要问人"。
 */
export const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
])
export type PermissionMode = z.infer<typeof PermissionModeSchema>

/** agent-loop.md §1：顶层状态机，14 态。 */
export const TASK_STATUSES = [
  "queued",
  "initializing",
  "exploring",
  "planning",
  "awaiting_approval",
  "executing",
  "validating",
  "repairing",
  "paused",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const
export const TaskStatusSchema = z.enum(TASK_STATUSES)
export type TaskStatus = z.infer<typeof TaskStatusSchema>

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
  "expired",
])

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/** tools-and-extensions.md §2：风险标签。 */
export const ToolRiskSchema = z.enum(["read", "workspace_write", "command", "external_side_effect"])
export type ToolRisk = z.infer<typeof ToolRiskSchema>

export const ToolIdempotencySchema = z.enum(["safe", "keyed", "non_idempotent"])
export type ToolIdempotency = z.infer<typeof ToolIdempotencySchema>

/**
 * 网络档位。
 *
 * - `none`：要求真正阻断出口。**只有具备内核级隔离的后端才能兑现**（Docker `--network none`）；
 *   受限子进程后端只能做"意图拦截"，见 `sandbox/index.ts` 的 `networkIntentGuard`。
 * - `package_registry` / `approved_domains`：允许特定出口（当前由策略层表达，沙箱不强制）。
 * - `inherit`：不承诺任何网络限制，继承宿主网络。受限子进程后端的默认档位。
 *
 * 之所以要有 `inherit`：默认值必须反映**实际防护能力**，而不是愿望。
 * 没有这一档时，"默认 none"等于让每个命令都声称自己被隔离了，而事实并非如此。
 */
export const NetworkProfileSchema = z.enum([
  "none",
  "package_registry",
  "approved_domains",
  "inherit",
])
export type NetworkProfile = z.infer<typeof NetworkProfileSchema>

/* ------------------------------------------------------------------ *
 * 命令请求（security.md §4）
 * ------------------------------------------------------------------ */

export const CommandRequestSchema = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1),
  env: z.record(z.string()).optional(),
  /** 默认与 `settings.limits.commandTimeoutMs` 对齐；省略时由 normalize 补齐。 */
  timeoutMs: z.number().int().positive().max(600_000).default(120_000),
  /**
   * 网络档位。**省略时由执行方按后端能力补齐**（见 `normalizeCommandRequest` 的 `defaults`）。
   * 这里不写死 `none`：那会让"默认不许联网"成为一句与后端能力无关的口号。
   */
  networkProfile: NetworkProfileSchema.optional(),
  reason: z.string().min(1),
  /** 超时后的处置：kill 或转后台（tools-and-extensions.md §2.5）。 */
  onTimeout: z.enum(["kill", "move-to-background"]).default("kill"),
})
/** 规范化后的请求：`normalizeCommandRequest` 保证 `networkProfile` 一定存在。 */
export type CommandRequest = z.infer<typeof CommandRequestSchema> & {
  networkProfile: NetworkProfile
}
/**
 * 调用方视角的命令请求：`args` / `networkProfile` / `onTimeout` 可省略。
 * 执行前一律经 `normalizeCommandRequest()` 补默认值，避免"改一个默认值要同步改三处"。
 */
export type CommandRequestInput = z.input<typeof CommandRequestSchema>

/**
 * 补全默认值并做一次结构校验。
 *
 * `defaults.networkProfile` 由**沙箱后端**决定（Docker → `none`，受限子进程 → `inherit`），
 * 调用方不该自己猜。都没有时回落到 `inherit`：不承诺隔离，总比声称隔离却不做要好。
 */
export function normalizeCommandRequest(
  input: CommandRequestInput,
  defaults: { networkProfile?: NetworkProfile } = {},
): CommandRequest {
  const parsed = CommandRequestSchema.parse(input)
  return {
    ...parsed,
    networkProfile: parsed.networkProfile ?? defaults.networkProfile ?? "inherit",
  }
}

export const CommandResultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  /** 输出是否被硬上限截断。 */
  truncated: z.boolean(),
  /** 总输出字节超过 kill 阈值时为 true（tools-and-extensions.md §2.5 的 5GB 规则）。 */
  outputLimitExceeded: z.boolean().default(false),
})
export type CommandResult = z.infer<typeof CommandResultSchema>

/* ------------------------------------------------------------------ *
 * 工具契约（tools-and-extensions.md §2 / §3 / §2.5）
 * ------------------------------------------------------------------ */

export const ToolErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
})
export type ToolError = z.infer<typeof ToolErrorSchema>

export const ToolArtifactSchema = z.object({
  kind: z.string(),
  uri: z.string(),
  sha256: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
})
export type ToolArtifact = z.infer<typeof ToolArtifactSchema>

export const ToolExecutionResultSchema = z.object({
  callId: z.string(),
  toolName: z.string(),
  status: z.enum(["succeeded", "failed", "timed_out", "cancelled"]),
  output: z.unknown().optional(),
  error: ToolErrorSchema.optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  /** observation 一律标注截断，让模型知道结果不完整。 */
  truncated: z.boolean().default(false),
  artifacts: z.array(ToolArtifactSchema).default([]),
  usage: z
    .object({
      inputTokens: z.number().nonnegative().optional(),
      outputTokens: z.number().nonnegative().optional(),
      costUsd: z.number().nonnegative().optional(),
    })
    .optional(),
})
export type ToolExecutionResult = z.infer<typeof ToolExecutionResultSchema>

/** 工具输入的硬阈值（tools-and-extensions.md §2.5）—— 契约的一部分，不是实现细节。 */
export interface ToolLimits {
  /** 单次返回的最大 token 数。 */
  maxOutputTokens: number
  /** 整读文件的字节硬顶。 */
  maxReadBytes: number
  /** 搜索结果条数上限，超过即要求收窄查询而非硬塞。 */
  maxSearchResults: number
}

export const DEFAULT_TOOL_LIMITS: ToolLimits = {
  maxOutputTokens: 25_000,
  maxReadBytes: 256 * 1024,
  maxSearchResults: 100,
}

/** 工具执行的上下文：由运行时注入，工具不得自己造。 */
export interface ToolExecutionContext {
  callId: string
  taskId: string
  /** 授权工作区根（realpath 后的绝对路径）。 */
  workspaceRoot: string
  cwd: string
  signal: AbortSignal
  timeoutMs: number
  budgetTokens: number
  /** 执行有副作用的命令的命令运行器（sandbox 注入）。 */
  runCommand: (req: CommandRequestInput) => Promise<CommandResult>
  logger: ToolLogger
  /**
   * 记录本次调用读取了哪个文件（read-before-edit 的依据）。
   *
   * 第三个参数 `content` 不能省：已读表里还要存读取时的内容 hash，
   * 供补丁基准校验用。少了它，记录只能记下 mtime。
   */
  trackRead: (path: string, mtimeMs: number, content: string) => void
  /** 查询某文件是否已读、读取时的 mtime。 */
  readState: (path: string) => { read: boolean; mtimeMs?: number } | undefined
  /** 记录文件被本 Agent 修改，刷新 mtime 记录。 */
  trackWrite: (path: string) => void
  /** 大结果落盘（返回可回取的 URI）。 */
  persistArtifact: (content: string, kind: string) => Promise<{ uri: string; sha256: string }>
  /**
   * **当前任务**的编辑会话（read-before-edit 的唯一来源）。
   *
   * 必须是任务级的，不能是 runtime 级的：同一个 REPL 里连续跑两个任务时，
   * 任务 A 读过 `src/a.ts`、任务 B 没读就直接改 —— 若共用一张已读表，
   * 任务 B 会被误判为"已经读过"，read-before-edit 在第二个任务上直接失效。
   */
  editEngine: EditSession
}

/** 已读表的只读视图。 */
export interface ReadRecordView {
  mtimeMs: number
  hash: string
  readAt: number
}

export interface ReplaceEditRequest {
  path: string
  oldString: string
  newString: string
  allowMultiple?: boolean
  expectedMatches?: number
}

export interface EditOutcomeView {
  path: string
  /** 应用后的完整内容。 */
  content: string
  baseHash: string
  newHash: string
  matches: number
  additions: number
  deletions: number
}

/**
 * 编辑会话接口。
 *
 * 定义在 shared 而不是 patch，是因为**工具层**要拿它（`ToolExecutionContext`），
 * 而 shared 不能反向依赖 patch。实现类在 `patch/edit.ts`，用 `implements`
 * 强制两边签名同步，避免契约与实现各写一份形状。
 */
export interface EditSession {
  recordRead(absolutePath: string, mtimeMs: number, content: string): void
  recordWrite(absolutePath: string, content: string): Promise<void>
  readRecord(absolutePath: string): ReadRecordView | undefined
  hasRead(absolutePath: string): boolean
  readonly trackedFiles: string[]
  replace(input: ReplaceEditRequest): Promise<EditOutcomeView>
  writeWhole(
    absolutePath: string,
    content: string,
    options?: { maxBytes?: number },
  ): Promise<EditOutcomeView>
}

export interface ToolLogger {
  debug(event: string, data?: Record<string, unknown>): void
  info(event: string, data?: Record<string, unknown>): void
  warn(event: string, data?: Record<string, unknown>): void
  error(event: string, data?: Record<string, unknown>): void
}

export interface AgentTool<I = unknown> {
  name: string
  description: string
  /**
   * 入参 schema。第三个类型参数取 `unknown`，允许字段带 `.default()` /
   * `.optional()`（此时输入类型与输出类型不同），否则 `z.ZodType<I>` 的
   * 不变性会让所有带默认值的 schema 都编译不过。
   */
  inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>
  outputSchema?: z.ZodType
  risk: ToolRisk
  idempotency: ToolIdempotency
  timeoutMs: number
  limits?: Partial<ToolLimits>

  /** fail-closed 默认值：未显式声明时按 false 处理。 */
  isConcurrencySafe?: (input: I) => boolean
  isReadOnly?: boolean
  isDestructive?: boolean

  /** 延迟加载：只给名字不给 schema，靠 tool_search 按需激活。 */
  deferred?: boolean
  /** 是否在本轮启用（任务模式 / 功能开关）。 */
  isEnabled?: (ctx: { mode: TaskMode; permissionMode: PermissionMode }) => boolean
  /** 向系统提示词注入该工具的专属使用指南（内聚于工具，无需改全局渲染）。 */
  prompt?: () => string

  /**
   * 策略引擎需要结构化的判定输入（ADR-8：判定不读模型自然语言）。
   * 工具自己声明"这次调用涉及哪条命令 / 哪些路径 / 哪些域名"，
   * 引擎不做文本猜测，也就不存在被绕过的空间。
   */
  /**
   * 返回 `CommandRequestInput`（可选字段由 `normalizeCommandRequest()` 补齐），
   * 这样工具作者只需给出"这次要跑什么"，不必重复填写 onTimeout / networkProfile
   * 这类默认值 —— 默认值只在一处定义，不会因为漏填而漂移。
   */
  policyCommand?: (input: I) => CommandRequestInput | undefined
  policyPaths?: (input: I) => string[]
  policyDomains?: (input: I) => string[]

  /** 便宜的业务校验：在 Zod 之后、读盘之前跑。 */
  validate?: (input: I, ctx: ToolExecutionContext) => void | Promise<void>
  /** 工具自带的权限前置检查。 */
  checkPermissions?: (input: I, ctx: ToolExecutionContext) => boolean | Promise<boolean>

  execute(input: I, ctx: ToolExecutionContext): Promise<unknown>
}

/* ------------------------------------------------------------------ *
 * 模型决策（development-guide.md §4）
 * ------------------------------------------------------------------ */

export const FinalDecisionSchema = z.object({
  type: z.literal("final"),
  summary: z.string(),
})

export const ToolUseDecisionSchema = z.object({
  type: z.literal("tool_use"),
  callId: z.string(),
  toolName: z.string(),
  args: z.record(z.unknown()),
})

export const AskDecisionSchema = z.object({
  type: z.literal("ask"),
  question: z.string(),
})

export const DecisionSchema = z.discriminatedUnion("type", [
  FinalDecisionSchema,
  ToolUseDecisionSchema,
  AskDecisionSchema,
])
export type Decision = z.infer<typeof DecisionSchema>
export type ToolUseDecision = z.infer<typeof ToolUseDecisionSchema>

/* ------------------------------------------------------------------ *
 * 事件（data-and-events.md §1）
 * ------------------------------------------------------------------ */

/**
 * 事件类型白名单。
 *
 * 这里只列**真的会 emit** 的类型：契约是系统对外的承诺，列出永远发不出来的
 * 事件等于给消费端一个假的接口。
 *
 * `agent.message_delta` 在流式落地后重新加回：`capabilities.streaming === true`
 * 的后端走 `gateway.stream()`，主循环把文本增量按阈值合并成该事件
 * （payload `{ turn, text }`）。注意它是**合并后的增量**，不是逐 token ——
 * 事件要落库，逐 token 会把事件表撑爆。`tool.progress` 仍未实现
 * （长命令增量输出不在本轮范围）。
 */
export const TASK_EVENT_TYPES = [
  "task.status_changed",
  "task.plan_ready",
  "tool.started",
  "tool.completed",
  /** data-and-events.md §1.2：模型流式输出的合并增量。 */
  "agent.message_delta",
  "approval.required",
  "approval.decided",
  "file.changed",
  "validation.started",
  "validation.completed",
  "checkpoint.created",
  "task.warning",
  "task.completed",
  "task.failed",
  "task.cancelled",
  /** data-and-events.md §1.3 ②：每次模型退避重试都是一条独立事件，供恢复时判断退避时长。 */
  "retry.api",
] as const
export const TaskEventTypeSchema = z.enum(TASK_EVENT_TYPES)
export type TaskEventType = z.infer<typeof TaskEventTypeSchema>

export interface TaskEvent<T = unknown> {
  eventId: string
  taskId: string
  seq: number
  type: string
  timestamp: string
  payload: T
  /** 谁发起我：主会话为 null，子代理指向派生它的 tool_use_id（data-and-events.md §1.2）。 */
  parentCallId?: string | null
}

export const TaskEventSchema: z.ZodType<TaskEvent> = z.object({
  eventId: z.string(),
  taskId: z.string(),
  seq: z.number().int().nonnegative(),
  type: z.string(),
  timestamp: z.string(),
  payload: z.unknown(),
  parentCallId: z.string().nullable().optional(),
}) as unknown as z.ZodType<TaskEvent>

/* ------------------------------------------------------------------ *
 * 权限判定（security.md §4.2）
 * ------------------------------------------------------------------ */

export type PolicyEffect = "allow" | "ask" | "deny"

export interface PolicyDecision {
  effect: PolicyEffect
  reason: string
  /** 命中的规则原文，便于审计与"为什么这么判"的回归测试。 */
  matchedRule?: string
  /** 命中 bypass-immune 时为 true：即使 bypassPermissions 也拦。 */
  bypassImmune?: boolean
  timeoutMs: number
  networkProfile: NetworkProfile
  /** 需要审批时与参数绑定，防止批准后偷偷改参数。 */
  parameterHash?: string
}

/* ------------------------------------------------------------------ *
 * 计划与验证（verification-and-multiagent.md §1）
 * ------------------------------------------------------------------ */

export const ExecutionPlanStepSchema = z.object({
  id: z.string(),
  objective: z.string(),
  filesLikelyAffected: z.array(z.string()).default([]),
  toolsAllowed: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  doneWhen: z.array(z.string()).default([]),
  risk: z.enum(["low", "medium", "high"]).default("low"),
})

export const ExecutionPlanSchema = z.object({
  summary: z.string(),
  assumptions: z.array(z.string()).default([]),
  steps: z.array(ExecutionPlanStepSchema).min(1),
  validation: z
    .array(
      z.object({
        command: z.array(z.string()).min(1),
        purpose: z.string(),
        required: z.boolean().default(true),
      }),
    )
    .default([]),
  requiresApproval: z.boolean().default(false),
})
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>
export type ExecutionPlanStep = z.infer<typeof ExecutionPlanStepSchema>

export const ValidationReportSchema = z.object({
  status: z.enum(["passed", "failed", "partial", "not_run"]),
  checks: z.array(
    z.object({
      id: z.string(),
      command: z.array(z.string()),
      status: z.enum(["passed", "failed", "skipped", "blocked"]),
      exitCode: z.number().int().optional(),
      durationMs: z.number().int().nonnegative().optional(),
      summary: z.string(),
      artifactUri: z.string().optional(),
    }),
  ),
  acceptance: z.array(
    z.object({
      criterionId: z.string(),
      status: z.enum(["verified", "not_verified", "failed"]),
      evidence: z.array(z.string()).optional(),
    }),
  ),
})
export type ValidationReport = z.infer<typeof ValidationReportSchema>

/* ------------------------------------------------------------------ *
 * 预算（agent-loop.md §6）
 * ------------------------------------------------------------------ */

export const BudgetSchema = z.object({
  maxRounds: z.number().int().positive().default(30),
  maxToolCalls: z.number().int().positive().default(200),
  maxCostUsd: z.number().nonnegative().default(2),
  maxWallClockMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60_000),
  maxInputTokens: z.number().int().nonnegative().default(2_000_000),
  maxRepairRounds: z.number().int().nonnegative().default(3),
  /** 连续无进展轮次上限，超过即停。 */
  maxNoProgressRounds: z.number().int().nonnegative().default(3),
})
export type Budget = z.infer<typeof BudgetSchema>

/**
 * 预算默认值：**从 schema 解析空对象得到**，而不是另抄一份常量。
 * 这样"配置层的默认值"和"运行期的默认值"永远是同一份，
 * 不会出现改了 schema 忘了改常量、两边悄悄漂移的情况。
 */
export const DEFAULT_BUDGET: Budget = BudgetSchema.parse({})

export interface BudgetUsage {
  rounds: number
  toolCalls: number
  costUsd: number
  inputTokens: number
  outputTokens: number
  startedAt: number
  repairRounds: number
}

/**
 * 预算用量零值。放在契约层而不是 runtime 层：store（L5）读回一行任务时
 * 也要造这个零值做兜底，若放 runtime（L3）就会形成 store → runtime 的反向依赖。
 */
export function createUsage(now: number = Date.now()): BudgetUsage {
  return {
    rounds: 0,
    toolCalls: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    startedAt: now,
    repairRounds: 0,
  }
}

/* ------------------------------------------------------------------ *
 * 仓库画像（context-engineering.md §2）
 * ------------------------------------------------------------------ */

export const RepoProfileSchema = z.object({
  repoId: z.string(),
  rootPath: z.string(),
  git: z.object({
    branch: z.string(),
    baseCommit: z.string(),
    dirty: z.boolean(),
  }),
  languages: z.array(z.string()).default([]),
  packageManagers: z.array(z.string()).default([]),
  frameworks: z.array(z.string()).default([]),
  monorepo: z.boolean().default(false),
  packages: z
    .array(z.object({ name: z.string(), path: z.string(), scripts: z.record(z.string()) }))
    .default([]),
  checks: z
    .array(z.object({ id: z.string(), command: z.array(z.string()), confidence: z.number() }))
    .default([]),
  ruleFiles: z.array(z.object({ path: z.string(), sha256: z.string() })).default([]),
  indexVersion: z.string(),
})
export type RepoProfile = z.infer<typeof RepoProfileSchema>
