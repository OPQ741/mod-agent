/**
 * CLI 会话：把 runtime 内核接到一个 I/O 上（ADR-7 CLI-first）。
 *
 * 三条输出纪律（usage.md §4 / agent-loop.md §6.3）：
 * 1. `--print` 的 stdout **只**放结果：事件、日志、审批提示一律走 stderr，
 *    否则 `mod --print ... --output-format json | jq` 会被诊断行打断；
 * 2. `stream-json` 每个事件一行，末尾再补一行 `type:"result"`，让消费端有明确的终态；
 * 3. 退出码就是成败：0 成功、1 失败、2 被人打断或挡在审批上。
 */

import { Logger, Metrics, type LogLevel } from "../observability/logger.js"
import { AgentRuntime, type DoctorReport } from "../runtime/runtime.js"
import { driveTask, type DriveResult, type ApprovalResolver } from "../runtime/driver.js"
import type { Budget, TaskMode, TaskEvent } from "../shared/contracts.js"
import type { ModelProvider } from "../model/types.js"
import type { Settings } from "../config/settings.js"
import type { CliIo } from "./io.js"
import { buildJsonResult, renderEventText, renderFinalText, type OutputFormat } from "./render.js"
import { createDenyResolver } from "./approval.js"

export interface SessionOptions {
  workspaceRoot: string
  settings: Settings
  provider: ModelProvider
  io: CliIo
  format: OutputFormat
  /** 存储文件；不给则用内存 store（进程一退就没了）。 */
  sqliteFile?: string
  logLevel?: LogLevel
  hasTty?: boolean
  /** `--no-stream`：本次运行不走流式（回放、排查兼容端点时用）。 */
  streaming?: boolean
  now?: () => Date
}

export interface RunOnceOptions {
  prompt: string
  mode?: TaskMode
  budget?: Partial<Budget>
  signal?: AbortSignal
  resolveApproval?: ApprovalResolver
  /** 关闭交付前的验证（例如 CI 里只想改代码、验证另跑）。 */
  noValidation?: boolean
  /** `--bare`：不加载仓库自带的 AGENTS.md / CLAUDE.md。 */
  skipProjectRules?: boolean
}

export class CliSession {
  readonly runtime: AgentRuntime
  readonly metrics: Metrics
  private readonly io: CliIo
  private readonly format: OutputFormat
  /**
   * 本次任务已经流式打到 stdout 的正文。
   *
   * 收尾时据此决定要不要再打印一遍 summary：流式场景下答案已经在生成过程中
   * 逐段出现，末尾重复整段会让 `--print` 的输出看起来被"复读"了一遍。
   * 中途取消也走这条判断 —— 半句话已经出现在 stdout，不能再补一句完整摘要。
   */
  private streamedText = ""

  private constructor(runtime: AgentRuntime, metrics: Metrics, io: CliIo, format: OutputFormat) {
    this.runtime = runtime
    this.metrics = metrics
    this.io = io
    this.format = format
  }

  static async open(options: SessionOptions): Promise<CliSession> {
    const metrics = new Metrics()
    const logger = new Logger({
      level: options.logLevel ?? "warn",
      sink: (line: string) => options.io.err(line),
    })
    const runtime = await AgentRuntime.create({
      workspaceRoot: options.workspaceRoot,
      settings: options.settings,
      provider: options.provider,
      logger,
      metrics,
      hasTty: options.hasTty ?? options.io.isTty,
      ...(options.streaming === false ? { streaming: false } : {}),
      ...(options.sqliteFile ? { sqliteFile: options.sqliteFile } : {}),
      ...(options.now ? { now: options.now } : {}),
    })
    return new CliSession(runtime, metrics, options.io, options.format)
  }

  /** 跑一个新任务（headless 与交互共用这一条路径）。 */
  async runOnce(options: RunOnceOptions): Promise<DriveResult & { taskId: string }> {
    const taskId = await this.runtime.createTask({
      title: titleFromPrompt(options.prompt),
      userRequest: options.prompt,
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.budget ? { budget: options.budget } : {}),
    })
    const result = await this.drive(taskId, options)
    return { ...result, taskId }
  }

  /** 从检查点继续跑一个既有任务。 */
  async resumeTask(
    taskId: string,
    options: Omit<RunOnceOptions, "prompt"> = {},
  ): Promise<DriveResult> {
    const state = await this.runtime.store.getTask(taskId)
    if (!state) throw new Error(`找不到任务 ${taskId}（用 --resume 需要同一个存储文件）`)
    await this.runtime.resume(taskId)
    return this.drive(taskId, options)
  }

  private async drive(
    taskId: string,
    options: Omit<RunOnceOptions, "prompt">,
  ): Promise<DriveResult> {
    this.streamedText = ""
    const result = await driveTask(this.runtime, taskId, {
      ...(options.signal ? { signal: options.signal } : {}),
      onEvent: (event) => this.emitEvent(event),
      // 不传求解器 = 停在审批点（fail-closed）；交互场景由调用方注入
      resolveApproval: options.resolveApproval ?? createDenyResolver(this.io),
      ...(options.noValidation ? { validationChecks: [] } : {}),
      ...(options.skipProjectRules ? { skipProjectRules: true } : {}),
    })
    this.emitFinal(taskId, result)
    return result
  }

  private emitEvent(event: TaskEvent): void {
    if (this.format === "stream-json") {
      this.io.out(`${JSON.stringify(event)}\n`)
      return
    }
    if (this.format === "text") {
      /**
       * 流式正文写 stdout（它就是结果本身），其余事件写 stderr。
       * 这样 `mod --print "..." > answer.txt` 拿到的是干净的答案，
       * 而不是"答案 + 状态行"混在一起。
       */
      if (event.type === "agent.message_delta") {
        const text = deltaText(event)
        if (text.length > 0) {
          this.streamedText += text
          this.io.out(text)
        }
        return
      }
      const line = renderEventText(event)
      if (line !== undefined) this.io.err(`${line}\n`)
    }
  }

  private emitFinal(taskId: string, result: DriveResult): void {
    if (this.format === "json") {
      const payload = buildJsonResult({
        taskId,
        ...(result.outcome ? { outcome: result.outcome } : {}),
        durationMs: result.durationMs,
        ...(result.usage ? { usage: result.usage } : {}),
        metrics: result.metrics,
        ...(result.pendingApproval ? { pendingApproval: result.pendingApproval } : {}),
      })
      this.io.out(`${JSON.stringify(payload, null, 2)}\n`)
      return
    }
    if (this.format === "stream-json") {
      const payload = buildJsonResult({
        taskId,
        ...(result.outcome ? { outcome: result.outcome } : {}),
        durationMs: result.durationMs,
        ...(result.usage ? { usage: result.usage } : {}),
        metrics: result.metrics,
        ...(result.pendingApproval ? { pendingApproval: result.pendingApproval } : {}),
      })
      this.io.out(`${JSON.stringify(payload)}\n`)
      return
    }
    // 流式正文没以换行结尾时先补一个，避免摘要与正文粘成一行
    if (this.streamedText.length > 0) this.io.out("\n")
    const text = renderFinalText({
      ...(result.outcome ? { outcome: result.outcome } : {}),
      durationMs: result.durationMs,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.pendingApproval ? { pendingApproval: result.pendingApproval } : {}),
      // 正文已经流式打过了，末尾不再复读 summary
      omitSummary: this.streamedText.length > 0,
    })
    if (text.length > 0) this.io.out(`${text}\n`)
  }

  async doctor(): Promise<DoctorReport> {
    return this.runtime.doctor()
  }

  async diff(statOnly = true): Promise<string> {
    const result = await this.runtime.diff({ statOnly })
    return result.stdout || result.stderr
  }

  async close(): Promise<void> {
    await this.runtime.close()
    this.io.close()
  }
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/)[0] ?? prompt
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine
}

/** `agent.message_delta` 的 payload 只有 `{ turn, text }`，缺字段时按空串处理。 */
function deltaText(event: TaskEvent): string {
  const payload = event.payload
  if (typeof payload !== "object" || payload === null) return ""
  const text = (payload as { text?: unknown }).text
  return typeof text === "string" ? text : ""
}
