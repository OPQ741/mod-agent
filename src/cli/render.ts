/**
 * CLI 渲染层：把事件流翻成三种输出格式（usage.md §4 / agent-loop.md §6.3）。
 *
 * - `text`：给人看，一行一事件；
 * - `json`：给脚本看，任务结束时**一个** JSON 对象，带 usage 与 total_cost_usd；
 * - `stream-json`：给流水线看，每个事件一行 JSON，边跑边吐。
 *
 * 关键约束：stdout 上只允许出现这三种输出，**日志与提示一律走 stderr**，
 * 否则 `mod --print ... --output-format json | jq` 会被诊断信息污染到解析失败。
 */

import type { BudgetUsage, TaskEvent } from "../shared/contracts.js"
import type { MetricSnapshot } from "../observability/logger.js"
import type { LoopOutcome } from "../runtime/loop.js"
import type { PendingApproval } from "../runtime/driver.js"

export type OutputFormat = "text" | "json" | "stream-json"

export function parseOutputFormat(value: string | undefined): OutputFormat {
  switch (value) {
    case "json":
    case "stream-json":
      return value
    case "text":
    case undefined:
      return "text"
    default:
      throw new Error(`Unsupported --output-format: ${value}. Expected text | json | stream-json.`)
  }
}

/** 把一条事件渲染成一行人类可读文本；返回 undefined 表示这条不值得占用一行。 */
export function renderEventText(event: TaskEvent): string | undefined {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  switch (event.type) {
    case "task.status_changed": {
      const from = payload.from ? `${String(payload.from)} → ` : ""
      const subtype = payload.subtype ? ` (${String(payload.subtype)})` : ""
      return `[状态] ${from}${String(payload.to ?? "?")}${subtype}`
    }
    case "tool.started":
      return `[工具] ${String(payload.tool ?? "?")} 开始`
    case "tool.completed": {
      const status = String(payload.status ?? "?")
      const ms = payload.durationMs ? ` · ${String(payload.durationMs)}ms` : ""
      const truncated = payload.truncated ? " · 已截断" : ""
      const err = payload.errorCode ? ` · ${String(payload.errorCode)}` : ""
      return `[工具] ${String(payload.tool ?? "?")} ${status}${ms}${truncated}${err}`
    }
    case "approval.required":
      return `[审批] ${String(payload.tool ?? "?")} 需要批准：${String(payload.reason ?? "")}`
    case "approval.decided":
      return `[审批] ${String(payload.decision ?? "?")} · ${String(payload.tool ?? "?")} · by ${String(payload.by ?? "?")}`
    case "file.changed":
      return `[改动] ${String(payload.path ?? "?")}`
    case "validation.started":
      return `[验证] 开始：${Array.isArray(payload.checks) ? payload.checks.join(", ") : ""}`.trimEnd()
    case "validation.completed":
      return `[验证] ${String(payload.status ?? "?")}`
    case "checkpoint.created":
      return `[检查点] v${String(payload.version ?? "?")}`
    case "task.warning":
      return `[警告] ${describeWarning(payload)}`
    /**
     * 字段名必须与 `RetryEvent` 对齐（`retryDelayMs` / `error`）。
     * 之前这里读的是 `delayMs` / `reason` —— 两个都不存在，
     * 而这条分支又因为事件从未 emit 而永远走不到，所以一直没人发现。
     */
    case "retry.api":
      return `[重试] 第 ${String(payload.attempt ?? "?")}/${String(payload.maxRetries ?? "?")} 次 · 等待 ${String(payload.retryDelayMs ?? "?")}ms · ${String(payload.error ?? "")}`
    case "task.plan_ready":
      return `[计划] 已提交 ${String(payload.steps ?? 0)} 个步骤`
    case "task.completed":
      return undefined
    case "task.failed":
      return `[失败] ${String(payload.code ?? "?")}：${String(payload.message ?? "")}`
    case "task.cancelled":
      return `[取消] ${String(payload.reason ?? "已取消")}`
    default:
      return `[${event.type}] ${safeJson(payload)}`
  }
}

function describeWarning(payload: Record<string, unknown>): string {
  const reason = String(payload.reason ?? "")
  switch (reason) {
    case "context_compacted":
      return `上下文已压缩：${String(payload.beforeTokens)} → ${String(payload.afterTokens)} tokens（折叠 ${String(payload.folded)} 条）`
    case "no_progress":
    case "no_progress_compressed":
      return "进度守卫触发：连续动作没有产生新进展"
    case "clarification_required":
      return `模型提问：${String(payload.question ?? "")}`
    case "cancelled":
      return String(payload.message ?? "收到中断信号")
    default:
      return safeJson(payload)
  }
}

/** headless `--output-format json` 的返回体。 */
export interface JsonResult {
  type: "result"
  subtype: string
  is_error: boolean
  task_id: string
  duration_ms: number
  num_turns: number
  result: string
  total_cost_usd: number
  usage: BudgetUsage
  changed_files: string[]
  permission_denials: Array<{ toolName: string; reason: string }>
  validation?: unknown
  /** 被审批挡住时的现场，供调用方决定要不要人工介入。 */
  pending_approval?: PendingApproval
  metrics: MetricSnapshot
}

export function buildJsonResult(input: {
  taskId: string
  outcome?: LoopOutcome
  durationMs: number
  usage?: BudgetUsage
  metrics: MetricSnapshot
  pendingApproval?: PendingApproval
}): JsonResult {
  const { outcome } = input
  const usage: BudgetUsage = input.usage ?? {
    rounds: 0,
    toolCalls: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    startedAt: 0,
    repairRounds: 0,
  }
  return {
    type: "result",
    subtype: outcome?.subtype ?? "error_during_execution",
    is_error: outcome?.subtype !== "success",
    task_id: input.taskId,
    duration_ms: input.durationMs,
    num_turns: outcome?.turns ?? usage.rounds,
    result: outcome?.summary ?? "",
    total_cost_usd: Number(usage.costUsd.toFixed(6)),
    usage,
    changed_files: outcome?.changedFiles ?? [],
    permission_denials: outcome?.permissionDenials ?? [],
    ...(outcome?.validation ? { validation: outcome.validation } : {}),
    ...(input.pendingApproval ? { pending_approval: input.pendingApproval } : {}),
    metrics: input.metrics,
  }
}

/** 给人看的收尾摘要：改了什么、验证过没、花了多少。 */
export function renderFinalText(input: {
  outcome?: LoopOutcome
  durationMs: number
  usage?: BudgetUsage
  pendingApproval?: PendingApproval
}): string {
  const lines: string[] = []
  const { outcome } = input
  if (outcome?.summary) lines.push(outcome.summary)
  if (outcome?.changedFiles.length) {
    lines.push(`改动 ${outcome.changedFiles.length} 个文件：`)
    for (const file of outcome.changedFiles) lines.push(`  - ${file}`)
  }
  if (outcome?.validation) {
    lines.push(`验证：${outcome.validation.status}`)
    for (const check of outcome.validation.checks) {
      lines.push(
        `  - ${check.id}: ${check.status}${check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ""}`,
      )
    }
  }
  if (outcome?.permissionDenials.length) {
    lines.push("被拒绝的动作：")
    for (const denial of outcome.permissionDenials)
      lines.push(`  - ${denial.toolName}: ${denial.reason}`)
  }
  if (input.pendingApproval) {
    lines.push(`停在审批：${input.pendingApproval.tool}（${input.pendingApproval.approvalId}）`)
    lines.push("用 --resume <task-id> 在交互环境下批准后继续。")
  }
  const usage = input.usage
  if (usage) {
    lines.push(
      `轮次 ${usage.rounds} · 工具调用 ${usage.toolCalls} · tokens ${usage.inputTokens}/${usage.outputTokens} · $${usage.costUsd.toFixed(4)} · ${input.durationMs}ms`,
    )
  }
  return lines.join("\n")
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
