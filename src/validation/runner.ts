/**
 * 验证流水线（verification-and-multiagent.md §1）。
 *
 * 按**成本从低到高**运行，不要每一轮都盲跑全仓库的耗时任务：
 *   diff 可应用 → 格式 → 受影响包的类型检查 → lint → 相关测试 → 构建 → 全量
 *
 * 一旦某一步失败就进入 Repair Loop，不必等到最后一步才发现问题。
 *
 * 错误码不同，恢复策略完全不同：`TEST_FAILED` 让模型进 Repair Loop 去修；
 * `NETWORK_BLOCKED` 不该让模型反复重写代码；`TOOL_PERMISSION_DENIED` 更不能
 * 让模型换一条命令绕过策略。
 */

import type { CommandRequestInput, CommandResult, ValidationReport } from "../shared/contracts.js"
import { AppError } from "../shared/errors.js"
import { extractFailureSummary } from "../tools/builtin/command.js"

export type CheckKind = "format" | "typecheck" | "lint" | "test" | "build"

/**
 * 单条验证命令的超时。
 *
 * 一处定义：判定（策略需要知道超时值）与执行（真正 kill 的时间）必须一致，
 * 否则"批准 300s、执行 120s"这类偏差会在事后完全看不出来。
 */
export const VALIDATION_TIMEOUT_MS = 300_000

export interface ValidationCheck {
  id: string
  kind: CheckKind
  command: string[]
  /** 该检查是否必须通过（false 时失败只记 partial，不判 failed）。 */
  required: boolean
  /** 工作目录。 */
  cwd: string
  /**
   * 命令的来源，决定它能不能自我授权。
   *
   * - `user`（默认）：调用方显式给出（CLI `--check`、SDK），视为已授权；
   * - `discovered`：从仓库内容（`package.json` scripts）里发现的，
   *   **不能自我授权** —— 仓库内容不该有能力让 agent 执行它自己写的命令。
   */
  source?: "user" | "discovered"
}

export interface RunCheckContext {
  runCommand: (req: CommandRequestInput) => Promise<CommandResult>
  /**
   * 执行前的授权检查（策略判定）。抛错即视为**没能验证**，记为 `blocked`，
   * 不记为 `failed` —— 后者会推着模型去改代码、甚至换一条命令绕过策略。
   */
  authorize?: (check: ValidationCheck) => Promise<void>
  /** 大结果落盘，返回可引用的 URI。 */
  persistArtifact: (content: string, kind: string) => Promise<{ uri: string; sha256: string }>
}

/** 成本递增顺序 —— 流水线严格按这个顺序跑。 */
const COST_ORDER: Readonly<Record<CheckKind, number>> = {
  format: 0,
  typecheck: 1,
  lint: 2,
  test: 3,
  build: 4,
}

/**
 * 运行检查列表，产出归一化的 ValidationReport。
 *
 * 关键纪律：**不根据模型口头声明伪造通过结果**。每一条 check 的状态都来自
 * 真实执行出来的退出码。
 */
export async function runChecks(
  checks: readonly ValidationCheck[],
  ctx: RunCheckContext,
): Promise<ValidationReport> {
  const ordered = [...checks].sort((a, b) => COST_ORDER[a.kind] - COST_ORDER[b.kind])
  const report: ValidationReport = { status: "not_run", checks: [], acceptance: [] }

  if (ordered.length === 0) {
    report.status = "not_run"
    return report
  }

  let requiredFailed = false
  let anyRan = false
  /**
   * 有检查**没跑成**（非必过检查失败，或必过检查被策略挡住）。
   *
   * 这两种都对应契约里的 `partial`：验证过一部分，但没验证全。
   * 之前只产出 passed / failed / not_run，`partial` 这个状态是死枚举 ——
   * 于是"lint 挂了但测试过了"会被报成 passed，等于把一次不完整验证说成全绿。
   */
  let anyFailed = false
  /** 必过检查被策略挡住：不许判成代码有问题，但也不许算验证通过。 */
  let requiredBlocked = false

  for (const check of ordered) {
    const executable = check.command[0]
    if (!executable) {
      report.checks.push({
        id: check.id,
        command: check.command,
        status: "skipped",
        summary: "Empty command",
      })
      continue
    }

    const startedAt = Date.now()
    try {
      // 授权先于执行：被策略挡住的命令连沙箱都不该进
      if (ctx.authorize) await ctx.authorize(check)
      const result = await ctx.runCommand({
        executable,
        args: check.command.slice(1),
        cwd: check.cwd,
        timeoutMs: VALIDATION_TIMEOUT_MS,
        networkProfile: "none",
        reason: `Validation check: ${check.kind}`,
        onTimeout: "move-to-background",
      })
      anyRan = true
      const passed = result.exitCode === 0

      let artifactUri: string | undefined
      if (!passed) {
        const summary = extractFailureSummary(result.stdout, result.stderr)
        const stored = await ctx.persistArtifact(
          `exit=${result.exitCode}\n\n${result.stdout}\n\n${result.stderr}`,
          `validation-${check.kind}`,
        )
        artifactUri = stored.uri
        report.checks.push({
          id: check.id,
          command: check.command,
          status: "failed",
          exitCode: result.exitCode,
          durationMs: Date.now() - startedAt,
          summary: summary.slice(0, 4_000),
          ...(artifactUri ? { artifactUri } : {}),
        })
        if (check.required) {
          requiredFailed = true
          // 便宜的检查先失败就不必再烧贵的：直接停止流水线
          break
        }
        anyFailed = true
        continue
      }

      report.checks.push({
        id: check.id,
        command: check.command,
        status: "passed",
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        summary: `exit 0 in ${Date.now() - startedAt}ms`,
      })
    } catch (err) {
      /**
       * 抛异常 = **没拿到退出码**，因此不计入 `anyRan`。
       *
       * 之前这里无条件 `anyRan = true`，于是"所有检查都被策略挡住"会被判成
       * `failed`。但策略挡住的意思是"这次没能验证"，不是"代码有问题" ——
       * 报成 failed 会推着模型去改代码、甚至换一条命令绕过策略，
       * 这正是文档反复禁止的那件事。
       */
      const appError =
        err instanceof AppError ? err : new AppError("COMMAND_EXIT_NONZERO", String(err))
      report.checks.push({
        id: check.id,
        command: check.command,
        status: "blocked",
        durationMs: Date.now() - startedAt,
        summary: `${appError.code}: ${appError.message}`,
      })
      if (check.required) {
        if (appError.code === "TOOL_PERMISSION_DENIED") {
          // 被挡住就继续跑后面的检查，但不许算通过（见 requiredBlocked）
          requiredBlocked = true
          continue
        }
        requiredFailed = true
        break
      }
      anyFailed = true
    }
  }

  /**
   * `requiredBlocked` 单独判 `partial`，不再等到"至少跑过一条"才生效。
   *
   * 全部检查都被策略挡住时 `anyRan` 为 false，旧逻辑会落到 `not_run` ——
   * 交付报告里那行就变成"没有跑验证命令"，而真相是"跑了，但没被授权"。
   * 这两种情况的补救动作完全不同（一个是"没配验证"，一个是"去加 allow 规则"）。
   */
  report.status = requiredFailed
    ? "failed"
    : requiredBlocked
      ? "partial"
      : !anyRan
        ? "not_run"
        : anyFailed
          ? "partial"
          : "passed"
  return report
}

/** 把验收条件映射到报告（默认按检查结果推断，不做模型自评）。 */
export function mapAcceptance(
  acceptanceCriteria: ReadonlyArray<{ id: string; description: string }>,
  report: ValidationReport,
): ValidationReport {
  const evidence = report.checks
    .filter((c) => c.status === "passed")
    .map((c) => `${c.id}: ${c.command.join(" ")} (exit 0)`)
  report.acceptance =
    report.status === "passed"
      ? acceptanceCriteria.map((criterion) => ({
          criterionId: criterion.id,
          status: "verified" as const,
          evidence,
        }))
      : acceptanceCriteria.map((criterion) => ({
          criterionId: criterion.id,
          status: "not_verified" as const,
        }))
  return report
}

/** 报告的人读摘要（用于 TUI 与 headless text 输出）。 */
export function summarizeReport(report: ValidationReport): string {
  const lines = [`Validation: ${report.status}`]
  for (const check of report.checks) {
    lines.push(
      `  [${check.status}] ${check.id} (${check.command.join(" ")})${check.exitCode !== undefined ? ` exit=${check.exitCode}` : ""}`,
    )
  }
  return lines.join("\n")
}
