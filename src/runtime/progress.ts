/**
 * 进度守卫（agent-loop.md §6 循环防护）。
 *
 * 出现以下任一情况即停止自动循环并请求人工介入或以部分失败结束：
 * - 同一命令 / 测试连续重复且无状态变化；
 * - 连续多轮文件 / 计划 / 验证都无进展；
 * - 反复重写同一文件；
 * - 同一错误在设定修复次数后不变。
 *
 * 典型场景：模型连着 4 轮跑同一条 `npm test`，退出码都是 1，报错行几乎没变。
 * 系统不该继续让它空试烧 token，而要把这几轮失败压成一段诊断重新规划。
 */

import { AppError } from "../shared/errors.js"
import { sha256 } from "../shared/hash.js"
import type { Budget } from "../shared/contracts.js"

/** 一次观测：工具 + 参数指纹 + 结果指纹。 */
export interface Observation {
  toolName: string
  argsFingerprint: string
  resultFingerprint: string
  ok: boolean
  /** 该次调用是否产生了文件变更。 */
  changedFiles: string[]
  errorCode?: string
}

export interface ProgressVerdict {
  progressing: boolean
  reason: string
  /** 重复次数，供诊断文案使用。 */
  repeats: number
  /** 建议：压成诊断重新规划，或停手等人。 */
  action: "continue" | "compress-and-replan" | "stop-and-escalate"
}

export function fingerprintResult(output: unknown): string {
  if (output === undefined || output === null) return "empty"
  const text = typeof output === "string" ? output : JSON.stringify(output)
  // 只取前 2000 字符做指纹：报错摘要通常在前部，且避免无谓的计算量
  return sha256(text.slice(0, 2_000))
}

export class ProgressGuard {
  private readonly observations: Observation[] = []
  private readonly fileEditCounts = new Map<string, number>()
  private readonly errorCounts = new Map<string, number>()
  private noProgressRounds = 0

  constructor(private readonly budget: Pick<Budget, "maxNoProgressRounds">) {}

  /**
   * 记录一次工具观测并给出判定。
   *
   * 判定顺序：重复且无状态变化 → 反复重写同一文件 → 同一错误反复出现 → 累计无进展。
   */
  record(observation: Observation): ProgressVerdict {
    this.observations.push(observation)

    if (observation.errorCode) {
      const count = (this.errorCounts.get(observation.errorCode) ?? 0) + 1
      this.errorCounts.set(observation.errorCode, count)
    }
    for (const file of observation.changedFiles) {
      this.fileEditCounts.set(file, (this.fileEditCounts.get(file) ?? 0) + 1)
    }

    // ① 同一命令 / 参数 / 结果连续重复
    const repeats = this.countTrailingIdentical(observation)
    if (repeats >= 3) {
      return {
        progressing: false,
        reason:
          `The same call (${observation.toolName}) produced an identical result ${repeats} times in a row. ` +
          "Retrying will not change the outcome — form a new hypothesis.",
        repeats,
        action: "compress-and-replan",
      }
    }

    // ② 反复重写同一文件
    for (const [file, count] of this.fileEditCounts) {
      if (count >= 4) {
        return {
          progressing: false,
          reason: `${file} has been rewritten ${count} times. Stop and re-plan instead of churning the same file.`,
          repeats: count,
          action: "compress-and-replan",
        }
      }
    }

    // ③ 同一错误反复出现
    if (observation.errorCode) {
      const count = this.errorCounts.get(observation.errorCode) ?? 0
      if (count >= 3) {
        return {
          progressing: false,
          reason: `Error ${observation.errorCode} recurred ${count} times without changing. Escalate to the user.`,
          repeats: count,
          action: "stop-and-escalate",
        }
      }
    }

    // ④ 累计无进展轮次
    if (this.isProgress(observation)) {
      this.noProgressRounds = 0
    } else {
      this.noProgressRounds += 1
    }
    if (this.noProgressRounds >= Math.max(1, this.budget.maxNoProgressRounds)) {
      return {
        progressing: false,
        reason: `${this.noProgressRounds} consecutive rounds without progress (no file change, no new evidence, no passing check).`,
        repeats: this.noProgressRounds,
        action: "compress-and-replan",
      }
    }

    return { progressing: true, reason: "progressing", repeats: 0, action: "continue" }
  }

  /** 判定无进展即抛错，让循环进入失败/压缩分支。 */
  assertProgress(observation: Observation): ProgressVerdict {
    const verdict = this.record(observation)
    if (!verdict.progressing) {
      throw new AppError("NO_PROGRESS", verdict.reason, {
        details: {
          repeats: verdict.repeats,
          action: verdict.action,
          toolName: observation.toolName,
        },
      })
    }
    return verdict
  }

  private isProgress(observation: Observation): boolean {
    return observation.ok || observation.changedFiles.length > 0
  }

  private countTrailingIdentical(latest: Observation): number {
    let count = 1
    for (let index = this.observations.length - 2; index >= 0; index -= 1) {
      const previous = this.observations[index]
      if (!previous) break
      if (
        previous.toolName === latest.toolName &&
        previous.argsFingerprint === latest.argsFingerprint &&
        previous.resultFingerprint === latest.resultFingerprint
      ) {
        count += 1
      } else {
        break
      }
    }
    return count
  }

  /** 把最近的失败压成一段诊断（agent-loop.md §6 的例子）。 */
  buildDiagnosis(): string {
    const recent = this.observations.slice(-8)
    if (recent.length === 0) return "No observations recorded."
    const lines = recent.map((observation, index) => {
      const status = observation.ok ? "ok" : `failed(${observation.errorCode ?? "unknown"})`
      return `${index + 1}. ${observation.toolName} → ${status}${observation.changedFiles.length > 0 ? ` [changed ${observation.changedFiles.length} file(s)]` : ""}`
    })
    const errors = [...this.errorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    const errorSummary =
      errors.length > 0
        ? `\nRecurring errors: ${errors.map(([code, n]) => `${code}×${n}`).join(", ")}`
        : ""
    return `Recent steps:\n${lines.join("\n")}${errorSummary}`
  }

  get history(): readonly Observation[] {
    return this.observations
  }

  reset(): void {
    this.observations.length = 0
    this.fileEditCounts.clear()
    this.errorCounts.clear()
    this.noProgressRounds = 0
  }
}
