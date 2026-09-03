/**
 * 任务驱动器（ADR-10：CLI 与 Agent SDK 共用同一 runtime 内核）。
 *
 * 主循环本身是"跑一轮、遇到审批就交还控制权"的形状（agent-loop.md §2.2），
 * 所以"跑到任务真正结束"这件事需要一个驱动器：**审批后恢复、再跑，直到终态**。
 * CLI 与 SDK 如果只是各写一份这段续跑逻辑，两边的"什么时候算跑完、退出码是几"
 * 迟早会漂移 —— 这正是 ADR-10 要避免的。于是这段逻辑放在内核里共用。
 *
 * 驱动器只做两件事：转发事件，以及在审批点上决定"批 / 拒 / 不再问"。
 * 它不做渲染，也不做输出格式，那些属于前端。
 */

import type { BudgetUsage, TaskEvent } from "../shared/contracts.js"
import type { MetricSnapshot } from "../observability/logger.js"
import type { ValidationCheck } from "../validation/runner.js"
import type { LoopOutcome } from "./loop.js"
import type { AgentRuntime } from "./runtime.js"

/** 退出码（usage.md §4 / agent-loop.md §6.3）：0 成功、1 失败、2 被人打断或挡住。 */
export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_BLOCKED = 2

export interface PendingApproval {
  approvalId: string
  tool: string
  parameterHash: string
  reason: string
}

export interface ApprovalResolution {
  decision: "allowed" | "denied"
  /**
   * true = 本会话内对**相同参数**放行。
   * 只在本进程有效、绝不写回配置（security.md §4.4：会话放行不是永久授权）。
   */
  sessionScope?: boolean
  /** 决策人，进审计事件。 */
  by?: string
}

export type ApprovalResolver = (request: PendingApproval) => Promise<ApprovalResolution>

export interface DriveOptions {
  signal?: AbortSignal
  onEvent?: (event: TaskEvent) => void
  /**
   * 审批求解器。**不传或返回 denied 都会停在审批点**（fail-closed）：
   * 无人值守的场景默认不许做，宁可退出码 2 让人来处理。
   */
  resolveApproval?: ApprovalResolver
  /**
   * 连续审批轮次上限。防止"批一次又问一次"的死循环把人耗死 ——
   * 到顶就停在当前审批点并返回 2，而不是继续问下去。
   */
  maxApprovalRounds?: number
  validationChecks?: readonly ValidationCheck[]
  compactionEnabled?: boolean
  /** `--bare`：不加载仓库规则文件。 */
  skipProjectRules?: boolean
}

export interface DriveResult {
  exitCode: number
  outcome?: LoopOutcome
  /** 仍未决的审批（说明任务是被"卡住"而不是"跑完"）。 */
  pendingApproval?: PendingApproval
  durationMs: number
  usage?: BudgetUsage
  metrics: MetricSnapshot
}

export function exitCodeFor(outcome: LoopOutcome | undefined, unresolved: boolean): number {
  if (!outcome) return EXIT_ERROR
  if (unresolved) return EXIT_BLOCKED
  switch (outcome.subtype) {
    case "success":
      return EXIT_OK
    // 取消与"被审批挡住"都是人主动介入的结果，和真失败要区分开
    case "cancelled":
    case "approval_required":
      return EXIT_BLOCKED
    default:
      return EXIT_ERROR
  }
}

/**
 * 把任务从当前状态一路驱动到终态（或卡在审批点）。
 */
export async function driveTask(
  runtime: AgentRuntime,
  taskId: string,
  options: DriveOptions = {},
): Promise<DriveResult> {
  const startedAt = Date.now()
  const maxApprovalRounds = options.maxApprovalRounds ?? 20
  let approvalRounds = 0
  let outcome: LoopOutcome | undefined
  let pendingApproval: PendingApproval | undefined

  for (;;) {
    const iterator = runtime
      .run(taskId, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.validationChecks ? { validationChecks: options.validationChecks } : {}),
        ...(options.compactionEnabled !== undefined
          ? { compactionEnabled: options.compactionEnabled }
          : {}),
      })
      [Symbol.asyncIterator]()

    pendingApproval = undefined

    // 手动迭代而不是 for await：生成器的返回值（LoopOutcome）必须拿到，
    // for await 会把它丢掉，最后就只能靠事件反推结果。
    let step = await iterator.next()
    while (!step.done) {
      const event = step.value
      options.onEvent?.(event)
      if (event.type === "approval.required") {
        pendingApproval = toPendingApproval(event)
      }
      step = await iterator.next()
    }
    outcome = step.value

    if (!pendingApproval) break

    if (approvalRounds >= maxApprovalRounds) break
    approvalRounds += 1

    const resolver = options.resolveApproval
    if (!resolver) break

    const resolution = await resolver(pendingApproval)
    const by = resolution.by ?? "user"
    if (resolution.decision !== "allowed") {
      await runtime.decideApproval(pendingApproval.approvalId, "denied", by)
      break
    }
    // 批准 → 会话放行表记账（runtime 内部完成）→ 从检查点恢复继续跑
    await runtime.decideApproval(pendingApproval.approvalId, "allowed", by)
    await runtime.resume(taskId)
    void resolution.sessionScope
  }

  const state = await runtime.store.getTask(taskId)
  return {
    exitCode: exitCodeFor(outcome, pendingApproval !== undefined),
    ...(outcome ? { outcome } : {}),
    ...(pendingApproval ? { pendingApproval } : {}),
    durationMs: Date.now() - startedAt,
    ...(state ? { usage: state.usage } : {}),
    metrics: runtime.metrics.snapshot(),
  }
}

function toPendingApproval(event: TaskEvent): PendingApproval {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  return {
    approvalId: String(payload.approvalId ?? ""),
    tool: String(payload.tool ?? ""),
    parameterHash: String(payload.parameterHash ?? ""),
    reason: typeof payload.reason === "string" ? payload.reason : "",
  }
}
