/**
 * 结构化日志与指标（observability-evaluation.md §1）。
 *
 * 三条纪律：
 * 1. **日志脱敏**：任何写出去的内容都先过 redactSecrets，密钥不落日志；
 * 2. **正文默认不落盘**：流式文本增量只进 TUI，不写日志；落盘的是生命周期事件；
 * 3. **按决策与阻塞时长建模**：三态决策计数与"等审批的墙钟时间"是能拿去改产品的数，
 *    只记 token 看不出该优化什么。
 */

import { redactSecrets } from "../shared/sanitize.js"
import type { ToolLogger } from "../shared/contracts.js"

export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LogRecord {
  ts: string
  level: LogLevel
  event: string
  taskId?: string
  traceId?: string
  data?: Record<string, unknown>
}

export interface LoggerOptions {
  level?: LogLevel
  /** 结构化输出流；默认 stderr（stdout 留给 headless 的机器可读输出）。 */
  sink?: (line: string) => void
  taskId?: string
  traceId?: string
  /** 是否输出人类可读格式（默认 JSONL）。 */
  pretty?: boolean
}

export class Logger implements ToolLogger {
  private readonly level: LogLevel
  private readonly sink: (line: string) => void
  private readonly base: { taskId?: string; traceId?: string }
  private readonly pretty: boolean

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info"
    this.sink =
      options.sink ??
      ((line: string) => {
        process.stderr.write(`${line}\n`)
      })
    this.base = {
      ...(options.taskId ? { taskId: options.taskId } : {}),
      ...(options.traceId ? { traceId: options.traceId } : {}),
    }
    this.pretty = options.pretty ?? false
  }

  /** 派生一个绑定了 taskId 的子 logger。 */
  child(bindings: { taskId?: string; traceId?: string }): Logger {
    return new Logger({
      level: this.level,
      sink: this.sink,
      pretty: this.pretty,
      ...((bindings.taskId ?? this.base.taskId)
        ? { taskId: bindings.taskId ?? this.base.taskId }
        : {}),
      ...((bindings.traceId ?? this.base.traceId)
        ? { traceId: bindings.traceId ?? this.base.traceId }
        : {}),
    })
  }

  debug(event: string, data?: Record<string, unknown>): void {
    this.emit("debug", event, data)
  }
  info(event: string, data?: Record<string, unknown>): void {
    this.emit("info", event, data)
  }
  warn(event: string, data?: Record<string, unknown>): void {
    this.emit("warn", event, data)
  }
  error(event: string, data?: Record<string, unknown>): void {
    this.emit("error", event, data)
  }

  private emit(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      event,
      ...(this.base.taskId ? { taskId: this.base.taskId } : {}),
      ...(this.base.traceId ? { traceId: this.base.traceId } : {}),
      ...(data ? { data: redact(data) } : {}),
    }
    this.sink(
      this.pretty
        ? `[${record.level}] ${record.event} ${JSON.stringify(record.data ?? {})}`
        : JSON.stringify(record),
    )
  }
}

/** 对结构化 data 里的字符串值脱敏。 */
function redact(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    out[key] = redactValue(value)
  }
  return out
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]"
  if (typeof value === "string") return redactSecrets(value).text
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1))
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, depth + 1)
    }
    return out
  }
  return value
}

/* ------------------------------------------------------------------ *
 * 指标
 * ------------------------------------------------------------------ */

export interface MetricSnapshot {
  counters: Record<string, number>
  timings: Record<string, { count: number; totalMs: number; maxMs: number }>
}

/**
 * 进程内指标。
 *
 * 除 token / 成本外，必须有：`policy.decision.{allow,ask,deny}` 计数与
 * `approval.blocked_ms`（等审批的墙钟时间）—— 后者是"用户在等 agent"的真实成本。
 */
export class Metrics {
  private readonly counters = new Map<string, number>()
  private readonly timings = new Map<string, { count: number; totalMs: number; maxMs: number }>()

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by)
  }

  recordTiming(name: string, ms: number): void {
    const current = this.timings.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 }
    this.timings.set(name, {
      count: current.count + 1,
      totalMs: current.totalMs + ms,
      maxMs: Math.max(current.maxMs, ms),
    })
  }

  /** 计时器：包住一段需要测量墙钟时间的操作。 */
  startTimer(name: string): () => void {
    const started = Date.now()
    return () => this.recordTiming(name, Date.now() - started)
  }

  snapshot(): MetricSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      timings: Object.fromEntries(this.timings),
    }
  }

  reset(): void {
    this.counters.clear()
    this.timings.clear()
  }
}

/** 静默 logger：测试默认使用，避免噪声。 */
export function noopLogger(): Logger {
  return new Logger({ level: "error", sink: () => {} })
}
