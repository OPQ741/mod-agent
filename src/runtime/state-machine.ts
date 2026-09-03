/**
 * 任务状态机（agent-loop.md §1）。
 *
 * 14 个顶层状态。状态只能由这里的显式转换函数修改，其他模块不得直接赋值 ——
 * 否则就会出现"界面显示已完成、数据库仍在执行中"那种两处代码各自合法、
 * 事后极难定位的矛盾。
 */

import type { TaskStatus } from "../shared/contracts.js"

/**
 * 合法转换表。
 *
 * 未列出的转换一律拒绝。设计意图：让"任务怎么乱跑都跑不出这张图"成为代码事实，
 * 而不是靠调用方自觉。
 */
const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["initializing", "cancelling", "failed", "expired"],
  initializing: ["exploring", "planning", "failed", "expired", "cancelling", "cancelled"],
  exploring: [
    "planning",
    "executing",
    "awaiting_approval",
    "paused",
    "failed",
    "expired",
    "cancelling",
  ],
  planning: ["awaiting_approval", "executing", "paused", "failed", "expired", "cancelling"],
  awaiting_approval: ["executing", "paused", "cancelled", "failed", "expired", "cancelling"],
  executing: [
    "validating",
    "awaiting_approval",
    "paused",
    "repairing",
    "completed",
    "failed",
    "expired",
    "cancelling",
  ],
  validating: ["repairing", "completed", "failed", "paused", "expired", "cancelling"],
  repairing: ["validating", "executing", "failed", "paused", "expired", "cancelling"],
  paused: ["queued", "cancelling", "cancelled", "expired"],
  cancelling: ["cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
}

export interface TransitionCheck {
  allowed: boolean
  reason?: string
}

export function canTransition(from: TaskStatus, to: TaskStatus): TransitionCheck {
  if (from === to) return { allowed: true }
  const targets = TRANSITIONS[from]
  if (!targets) return { allowed: false, reason: `Unknown source status: ${from}` }
  if (targets.includes(to)) return { allowed: true }
  return {
    allowed: false,
    reason: `Illegal transition ${from} → ${to}. Allowed: ${targets.join(", ") || "(terminal)"}`,
  }
}

export class IllegalTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus, reason: string) {
    super(`Illegal task transition ${from} → ${to}: ${reason}`)
    this.name = "IllegalTransitionError"
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  const check = canTransition(from, to)
  if (!check.allowed) throw new IllegalTransitionError(from, to, check.reason ?? "not allowed")
}

/** 可暂停的状态：暂停的语义是"不再开始新的工具调用"。 */
export function isPausable(status: TaskStatus): boolean {
  return ["exploring", "planning", "executing", "validating", "repairing"].includes(status)
}

/** 可取消的状态。 */
export function isCancellable(status: TaskStatus): boolean {
  return !(["completed", "failed", "cancelled", "expired", "cancelling"] as TaskStatus[]).includes(
    status,
  )
}

/** 可恢复的状态（paused → queued → 继续跑）。 */
export function isResumable(status: TaskStatus): boolean {
  return ["paused", "awaiting_approval", "queued"].includes(status)
}

/** 处于这些状态时不应再发起新的工具调用。 */
export function blocksNewToolCalls(status: TaskStatus): boolean {
  return [
    "paused",
    "awaiting_approval",
    "cancelling",
    "cancelled",
    "completed",
    "failed",
    "expired",
  ].includes(status)
}
