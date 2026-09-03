/**
 * Agent SDK（ADR-10：CLI 与 SDK 共用同一 runtime 内核）。
 *
 * `query()` 与 `mod --print` 走的是同一个 `AgentRuntime` 与同一个 `driveTask`：
 * 只是把"输出渲染"换成"回调 + 返回值"。这样不会出现"SDK 里能跑，
 * CLI 里行为不一样"这种最难查的漂移 —— 差异只允许存在于入参与出参的形状上。
 */

import { Logger, Metrics, noopLogger, type LogLevel } from "../observability/logger.js"
import { AgentRuntime } from "../runtime/runtime.js"
import { driveTask, type ApprovalResolver, type PendingApproval } from "../runtime/driver.js"
import type { LoopOutcome } from "../runtime/loop.js"
import type { MetricSnapshot } from "../observability/logger.js"
import type { ModelProvider } from "../model/types.js"
import type { Settings } from "../config/settings.js"
import type { ValidationCheck } from "../validation/runner.js"
import type { Budget, BudgetUsage, TaskEvent, TaskMode } from "../shared/contracts.js"

export interface QueryOptions {
  /** 用户需求。 */
  prompt: string
  /** 模型后端。凭证由调用方负责，SDK 不读环境变量。 */
  provider: ModelProvider
  /** 工作区根目录，默认 process.cwd()。 */
  workspaceRoot?: string
  settings?: Settings
  mode?: TaskMode
  budget?: Partial<Budget>
  /** 中断信号；取消后任务停在 paused/cancelled，退出码 2。 */
  signal?: AbortSignal
  /**
   * 审批回调。**不传则一律拒绝**（fail-closed）：SDK 常用于无人值守场景，
   * 默认放行等于把权限判断悄悄交给模型，这是最危险的一种默认。
   */
  onApproval?: ApprovalResolver
  /** 逐事件回调，等价于 CLI 的 `--output-format stream-json`。 */
  onEvent?: (event: TaskEvent) => void
  /** 持久化文件；不传则用内存 store。 */
  sqliteFile?: string
  /**
   * 是否有可交互的终端。
   *
   * 决定"需要确认的动作"是**问人**还是**直接拒绝**：无 TTY 一律拒绝（fail-closed），
   * 有 TTY 才走审批回调。嵌入方如果自己有 UI，应当把这个位置为 true 并配 `onApproval`，
   * 否则 SDK 会静默地把该问的动作全部挡掉，而调用方还以为模型自己绕过去了。
   */
  hasTty?: boolean
  validationChecks?: readonly ValidationCheck[]
  /** 不加载仓库 AGENTS.md / CLAUDE.md。 */
  skipProjectRules?: boolean
  logLevel?: LogLevel
  now?: () => Date
}

export interface QueryResult {
  taskId: string
  exitCode: number
  outcome?: LoopOutcome
  /** 本次调用产生的全部事件（顺序与发生顺序一致）。 */
  events: TaskEvent[]
  usage?: BudgetUsage
  metrics: MetricSnapshot
  /** 卡在审批上时为那个未决的审批；否则不存在。 */
  pendingApproval?: PendingApproval
}

export async function query(options: QueryOptions): Promise<QueryResult> {
  const metrics = new Metrics()
  const logger = options.logLevel ? new Logger({ level: options.logLevel }) : noopLogger()
  const runtime = await AgentRuntime.create({
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    provider: options.provider,
    metrics,
    logger,
    ...(options.hasTty !== undefined ? { hasTty: options.hasTty } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.sqliteFile ? { sqliteFile: options.sqliteFile } : {}),
    ...(options.now ? { now: options.now } : {}),
  })

  try {
    const taskId = await runtime.createTask({
      title: titleFromPrompt(options.prompt),
      userRequest: options.prompt,
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.budget ? { budget: options.budget } : {}),
    })

    const events: TaskEvent[] = []
    const result = await driveTask(runtime, taskId, {
      onEvent: (event) => {
        events.push(event)
        options.onEvent?.(event)
      },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onApproval ? { resolveApproval: options.onApproval } : {}),
      ...(options.validationChecks ? { validationChecks: options.validationChecks } : {}),
      ...(options.skipProjectRules ? { skipProjectRules: true } : {}),
    })

    return {
      taskId,
      exitCode: result.exitCode,
      ...(result.outcome ? { outcome: result.outcome } : {}),
      events,
      ...(result.usage ? { usage: result.usage } : {}),
      metrics: result.metrics,
      ...(result.pendingApproval ? { pendingApproval: result.pendingApproval } : {}),
    }
  } finally {
    await runtime.close()
  }
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/)[0] ?? prompt
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine
}

export { EXIT_OK, EXIT_ERROR, EXIT_BLOCKED } from "../runtime/driver.js"
export type { ApprovalResolver, ApprovalResolution, PendingApproval } from "../runtime/driver.js"
