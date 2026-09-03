/**
 * 预算门禁（agent-loop.md §6 / mini-swe-agent 实证）。
 *
 * 终止条件本质上就三类：**步数、成本、墙钟时间**。缺一个就留一个跑飞的口子。
 * 阈值全部由配置给出，不写死示例值（agent-loop.md §6 明确要求）。
 */

import type { Budget, BudgetUsage } from "../shared/contracts.js"
import { AppError } from "../shared/errors.js"

export type BudgetDimension =
  "rounds" | "toolCalls" | "costUsd" | "wallClockMs" | "inputTokens" | "repairRounds"

export interface BudgetViolation {
  dimension: BudgetDimension
  limit: number
  actual: number
  message: string
}

/**
 * 检查是否撞线。返回第一个命中的维度（诊断时通常只需要知道最先撞的是哪个）。
 */
export function checkBudget(
  budget: Budget,
  usage: BudgetUsage,
  now: number = Date.now(),
): BudgetViolation | undefined {
  const checks: Array<{
    dimension: BudgetDimension
    limit: number
    actual: number
    format: (n: number) => string
  }> = [
    {
      dimension: "rounds",
      limit: budget.maxRounds,
      actual: usage.rounds,
      format: (n) => `${n} rounds`,
    },
    {
      dimension: "toolCalls",
      limit: budget.maxToolCalls,
      actual: usage.toolCalls,
      format: (n) => `${n} tool calls`,
    },
    {
      dimension: "costUsd",
      limit: budget.maxCostUsd,
      actual: usage.costUsd,
      format: (n) => `$${n.toFixed(4)}`,
    },
    {
      dimension: "wallClockMs",
      limit: budget.maxWallClockMs,
      actual: now - usage.startedAt,
      format: (n) => `${Math.round(n / 1000)}s`,
    },
    {
      dimension: "inputTokens",
      limit: budget.maxInputTokens,
      actual: usage.inputTokens,
      format: (n) => `${n} input tokens`,
    },
    /**
     * `repairRounds` **故意不在这里做硬刹车**。
     *
     * 它是 Repair Loop 自己的预算：循环在"验证失败 → 修复 → 再验证"这条链上
     * 已经按 `maxRepairRounds` 判定是否停手，并能给出"哪条检查没过"的准确诊断。
     * 若这里再用 `>=` 提前掐断，任务会以 `expired / error_max_turns` 收场 ——
     * 诊断信息全丢，看上去像超时，实际是验证没过，是最难查的一类误报。
     */
  ]

  for (const check of checks) {
    if (check.actual >= check.limit) {
      return {
        dimension: check.dimension,
        limit: check.limit,
        actual: check.actual,
        message: `Budget exceeded on ${check.dimension}: used ${check.format(check.actual)}, limit ${check.format(check.limit)}`,
      }
    }
  }
  return undefined
}

/** 撞线即抛；dontAsk 式的"宁可漏做"在调用方，不在预算层。 */
export function assertWithinBudget(
  budget: Budget,
  usage: BudgetUsage,
  now: number = Date.now(),
): void {
  const violation = checkBudget(budget, usage, now)
  if (violation) {
    throw new AppError("BUDGET_EXCEEDED", violation.message, {
      details: { dimension: violation.dimension, limit: violation.limit, actual: violation.actual },
    })
  }
}

/** 剩余预算占比（0–1），供进度守卫与 UI 展示。 */
export function budgetPressure(
  budget: Budget,
  usage: BudgetUsage,
  now: number = Date.now(),
): number {
  const ratios = [
    usage.rounds / budget.maxRounds,
    usage.toolCalls / budget.maxToolCalls,
    budget.maxCostUsd > 0 ? usage.costUsd / budget.maxCostUsd : 0,
    (now - usage.startedAt) / budget.maxWallClockMs,
    budget.maxInputTokens > 0 ? usage.inputTokens / budget.maxInputTokens : 0,
  ]
  return Math.min(1, Math.max(...ratios))
}
