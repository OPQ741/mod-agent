/**
 * 任务状态写入的唯一入口：乐观锁 + 重试 + 状态机守卫。
 *
 * 为什么需要它：
 * `store.updateTask(id, patch, expectedVersion)` 是一次 CAS（compare-and-swap）：
 * 版本号对不上就抛 `VersionConflictError`。单次 CAS 本身没错，错的是**调用方只写一次**。
 * 一个任务上至少有两个并发写入者 ——「取消/暂停」（外部意图）与「主循环收尾」（执行方），
 * 窗口只有几次指令宽，但一旦重叠，`VersionConflictError` 会直接冒到 CLI 或掀翻生成器，
 * 表现为任务其实已经结束、库里却停在 `executing`。
 *
 * 所以正确的用法是**重读-重试**，而不是让调用方各自处理冲突：
 * 冲突只说明"我读到的版本旧了"，不代表这次写入应当失败。
 *
 * 但重试必须配**守卫**，否则会把"用户已经取消"覆盖成"成功交付"：
 * `stopIf` 在每次重读后判定，命中就放弃写入并如实返回现状。
 * 状态机的合法性判断本身就是最好的守卫 —— 已经转到终态的任务，
 * `completed → completed` 之外的任何目标都会被 `canTransition` 拒绝。
 */

import { AppError } from "../shared/errors.js"
import { VersionConflictError, type Store, type TaskState } from "../store/types.js"

/** 冲突重试的默认退避（毫秒）。第三次之后不再等待，避免把一次取消拖成秒级。 */
const DEFAULT_BACKOFF: readonly number[] = [0, 5, 20]

/** 默认放弃重试的次数上限。并发写入者只有两个，3 次足够；再多说明不是竞态而是逻辑错误。 */
const DEFAULT_RETRIES = 3

export interface TaskWriteOptions {
  /**
   * 每次重读后判定：为真则**不写**，直接返回现状。
   * 典型用法：`(state) => isTerminalStatus(state.status)` 或状态机不允许转换。
   */
  stopIf?: (state: TaskState) => boolean
  /** 冲突重试次数，默认 3。 */
  retries?: number
  /** 重试退避，按尝试序号取；不足时沿用最后一个。 */
  backoffMs?: readonly number[]
  /** 注入 sleep（测试里用零等待，不必真的等）。 */
  sleep?: (ms: number) => Promise<void>
}

export interface TaskWriteResult {
  /** 是否真的写进去了。false 时 `state` 是**现状**，调用方据此决定怎么收场。 */
  applied: boolean
  state: TaskState
  /** 写入前的状态（`applied` 为真时才有），用于发 `from → to` 事件。 */
  previous?: TaskState
  /** 期间观察到的版本冲突次数（可观测性用，不是错误）。 */
  conflicts: number
  /** 放弃写入的原因：状态守卫命中，或冲突重试耗尽。 */
  reason?: "state_guard" | "version_conflict"
}

export async function updateTaskWithRetry(
  store: Store,
  taskId: string,
  patch: Partial<TaskState>,
  options: TaskWriteOptions = {},
): Promise<TaskWriteResult> {
  const retries = options.retries ?? DEFAULT_RETRIES
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF
  const sleep = options.sleep ?? delay
  let conflicts = 0

  for (let attempt = 0; ; attempt += 1) {
    const state = await store.getTask(taskId)
    if (!state) {
      throw new AppError("INVALID_INPUT", `Task not found: ${taskId}`, { details: { taskId } })
    }
    if (options.stopIf?.(state)) {
      return { applied: false, state, conflicts, reason: "state_guard" }
    }

    try {
      const next = await store.updateTask(taskId, patch, state.stateVersion)
      return { applied: true, state: next, previous: state, conflicts }
    } catch (err) {
      if (!(err instanceof VersionConflictError)) throw err
      conflicts += 1
      if (attempt >= retries) {
        // 重试用尽：把现状带回去，让调用方记一条可诊断的告警，而不是抛给用户
        const latest = await store.getTask(taskId)
        return {
          applied: false,
          state: latest ?? state,
          conflicts,
          reason: "version_conflict",
        }
      }
      const wait = backoff[Math.min(attempt, backoff.length - 1)] ?? 0
      if (wait > 0) await sleep(wait)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
