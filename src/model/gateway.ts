/**
 * Model Gateway：把可靠性与记账关在一处（model-gateway.md §6 / architecture.md ADR-6）。
 *
 * 三件事只有这里做，别处不许各造一套：
 * 1. **超时**：一个 AbortController 贯穿模型请求，取消时连在飞的网络请求一起取消；
 * 2. **重试**：只重试可恢复错误，指数退避**加抖动**，遵守 `Retry-After`；
 * 3. **记账**：用量与成本累计，供预算门禁与 headless 输出使用。
 *
 * 抖动不可省略：限流是所有客户端同时撞上的，固定退避会让大家在同一时刻再次
 * 同时发起请求，形成重试风暴。
 */

import { AppError, isRetryableCode } from "../shared/errors.js"
import {
  isModelStreamEnd,
  type ModelDelta,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
} from "./types.js"

export interface RetryEvent {
  attempt: number
  maxRetries: number
  retryDelayMs: number
  errorStatus?: number
  error: string
}

/**
 * `stream()` 产出的事件。
 *
 * `delta` 是给消费端实时展示的增量；`retry` 是退避记录（必须进事件流，
 * 否则事后无法解释"那 30 秒在等什么"）；`done` 是最终响应，
 * 与 `generate()` 的返回值完全同形状 —— 主循环两条路径可以共用后面的决策代码。
 */
export type ModelStreamEvent =
  | { type: "delta"; delta: ModelDelta }
  | { type: "retry"; event: RetryEvent }
  | { type: "done"; response: ModelResponse }

export interface GatewayOptions {
  provider: ModelProvider
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number
  maxRetries?: number
  /** 退避上限（毫秒）。 */
  maxBackoffMs?: number
  /** 退避基数（毫秒）。 */
  baseBackoffMs?: number
  /** 注入随机源，便于测试确定性退避。默认 Math.random。 */
  random?: () => number
  /** 注入 sleep，便于测试不真的等待。第二个参数用于让等待可被打断。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** 每次退避重试都发一条 retry.api 事件（data-and-events.md §1.3 ②）。 */
  onRetry?: (event: RetryEvent) => void
  /**
   * 是否允许流式（默认 true）。
   *
   * `false` 时 `stream()` 退化成一次 `generate()`，`capabilities.streaming` 也如实报
   * `false` —— 主循环看的是能力声明，不需要在每个调用点重复判断开关。
   * 开关放在网关而不是 provider：provider 声明的是"这个协议能不能流"，
   * 而"这次运行要不要流"是运行时策略（`--no-stream`、回放、排查兼容端点）。
   */
  streaming?: boolean
  now?: () => number
}

export interface UsageTotals {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  retries: number
}

const EMPTY_USAGE: UsageTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  retries: 0,
}

export class ModelGateway {
  private readonly provider: ModelProvider
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly maxBackoffMs: number
  private readonly baseBackoffMs: number
  private readonly random: () => number
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly onRetry?: (event: RetryEvent) => void
  private readonly streamingEnabled: boolean
  private readonly now: () => number
  private totals: UsageTotals = { ...EMPTY_USAGE }

  constructor(options: GatewayOptions) {
    this.provider = options.provider
    this.timeoutMs = options.timeoutMs ?? 600_000
    this.maxRetries = Math.min(options.maxRetries ?? 10, 15)
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000
    this.baseBackoffMs = options.baseBackoffMs ?? 500
    this.random = options.random ?? Math.random
    this.sleepFn = options.sleep ?? defaultSleep
    this.onRetry = options.onRetry
    this.streamingEnabled = options.streaming !== false
    this.now = options.now ?? Date.now
  }

  get providerId(): string {
    return this.provider.id
  }

  /**
   * 能力声明：协议能力与本次运行的开关**取交集**。
   *
   * 主循环只问这一处"能不能流"。若这里原样透传 provider 的 `streaming: true`，
   * `--no-stream` 就只关掉了 `stream()` 的分支，主循环照样走流式路径。
   */
  get capabilities(): ModelProvider["capabilities"] {
    if (this.streamingEnabled) return this.provider.capabilities
    return { ...this.provider.capabilities, streaming: false }
  }

  get usage(): UsageTotals {
    return { ...this.totals }
  }

  resetUsage(): void {
    this.totals = { ...EMPTY_USAGE }
  }

  /**
   * 发一次请求，必要时退避重试。
   *
   * 只有 `isRetryableCode` 为 true 的错误会重试（限流 / 过载 / 网络 / 超时）。
   * 参数错误与鉴权失败重试只会重复报错，直接抛。
   *
   * `options.onRetry` 是**按次**的退避回调：构造期的 `onRetry` 只够写日志，
   * 而主循环要把每次退避变成一条 `retry.api` 事件（事件流属于某一次任务，
   * 网关是跨任务的单例，所以不能只在构造期绑）。
   */
  async generate(
    input: ModelRequest,
    signal?: AbortSignal,
    options?: { onRetry?: (event: RetryEvent) => void },
  ): Promise<ModelResponse> {
    let lastError: AppError | undefined
    let delayMs = this.baseBackoffMs

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (signal?.aborted) {
        throw abortError("Model request aborted before sending")
      }

      try {
        const response = await this.withTimeout(input, signal)
        this.accumulate(response.usage, response.costUsd)
        return response
      } catch (err) {
        const appError =
          err instanceof AppError ? err : new AppError("MODEL_NETWORK", String(err), { cause: err })
        lastError = appError

        if (!isRetryableCode(appError.code) || attempt >= this.maxRetries) {
          throw appError
        }

        // 退避 + 抖动：把重试散开，避免重试风暴。
        // 服务端给了 Retry-After 就优先遵守（不加抖动），否则走指数退避。
        const backoff = this.backoff(appError, attempt, delayMs)
        delayMs = backoff.delayMs
        this.onRetry?.(backoff.event)
        options?.onRetry?.(backoff.event)
        /**
         * 退避等待必须**可被打断**。
         *
         * 之前这里是 `await this.sleepFn(wait)`：用户按下停止后，循环要等满
         * 整个退避（上限 30s）才轮到下一次检查取消信号 —— 实测 abort 在 150ms
         * 触发，`generate()` 依然在 20s 后才返回。取消是用户能感知的操作，
         * 不能让它排队等一个纯粹为了省流量的定时器。
         */
        await this.sleepFn(backoff.event.retryDelayMs, signal)
      }
    }

    throw (
      lastError ??
      new AppError("MODEL_EXHAUSTED", "Model gateway exhausted retries without a result")
    )
  }

  /**
   * 流式请求。没有流式实现的 provider 会退回一次非流式 `generate()`，
   * 产出单个 `done` —— 调用方不需要为"这个后端支不支持流式"写两套逻辑。
   *
   * **重试语义与 `generate()` 不同，这是有意的**：一旦已经有增量吐给消费者，
   * 就不能再重试 —— 重放会让用户看到重复的半段文本，且模型已经"说出口"的
   * 内容会被第二次生成覆盖。所以只有"一个 delta 都还没吐出"时（连接失败、
   * HTTP 错误、首个事件前断开）才允许退避重试。
   */
  async *stream(
    input: ModelRequest,
    signal?: AbortSignal,
    options?: { onRetry?: (event: RetryEvent) => void },
  ): AsyncGenerator<ModelStreamEvent, void, void> {
    const generateStream = this.streamingEnabled
      ? this.provider.generateStream?.bind(this.provider)
      : undefined
    if (!generateStream || this.provider.capabilities.streaming !== true) {
      const response = await this.generate(input, signal, options)
      yield { type: "done", response }
      return
    }

    let lastError: AppError | undefined
    let delayMs = this.baseBackoffMs

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (signal?.aborted) throw abortError("Model request aborted before streaming")

      let sawDelta = false
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error("model timeout")), this.timeoutMs)
      const onOuterAbort = (): void => controller.abort(signal?.reason)
      signal?.addEventListener("abort", onOuterAbort, { once: true })

      try {
        for await (const chunk of generateStream(input, controller.signal)) {
          if (isModelStreamEnd(chunk)) {
            this.accumulate(chunk.response.usage, chunk.response.costUsd)
            yield { type: "done", response: chunk.response }
            return
          }
          sawDelta = true
          yield { type: "delta", delta: chunk }
        }
        throw new AppError(
          "MODEL_INVALID_OUTPUT",
          "Model stream ended without a final response chunk",
        )
      } catch (err) {
        if (signal?.aborted) throw abortError("Model request aborted while streaming")
        if (controller.signal.aborted && !signal?.aborted) {
          lastError = new AppError(
            "MODEL_TIMEOUT",
            `Model request timed out after ${this.timeoutMs}ms (streaming)`,
            { cause: err },
          )
        } else {
          lastError =
            err instanceof AppError
              ? err
              : new AppError("MODEL_NETWORK", String(err), { cause: err })
        }

        // 已经吐出增量就不能重试（见上面的方法注释）
        if (sawDelta || !isRetryableCode(lastError.code) || attempt >= this.maxRetries) {
          throw lastError
        }

        const backoff = this.backoff(lastError, attempt, delayMs)
        delayMs = backoff.delayMs
        this.onRetry?.(backoff.event)
        options?.onRetry?.(backoff.event)
        yield { type: "retry", event: backoff.event }
        await this.sleepFn(backoff.event.retryDelayMs, signal)
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onOuterAbort)
      }
    }

    throw (
      lastError ??
      new AppError("MODEL_EXHAUSTED", "Model gateway exhausted retries without a result")
    )
  }

  /** 退避计算：Retry-After 优先，否则指数 + 抖动；顺带产出可观测事件。 */
  private backoff(
    err: AppError,
    attempt: number,
    delayMs: number,
  ): { delayMs: number; event: RetryEvent } {
    const retryAfter = readRetryAfterMs(err)
    const jitter = Math.floor(this.random() * delayMs * 0.5)
    const exponentialWait = Math.min(delayMs + jitter, this.maxBackoffMs)
    const wait =
      retryAfter !== undefined ? Math.min(retryAfter, this.maxBackoffMs) : exponentialWait
    this.totals.retries += 1
    const event: RetryEvent = {
      attempt: attempt + 1,
      maxRetries: this.maxRetries,
      retryDelayMs: wait,
      error: err.code,
      ...(extractStatus(err) !== undefined ? { errorStatus: extractStatus(err) } : {}),
    }
    return { delayMs: Math.min(delayMs * 2, this.maxBackoffMs), event }
  }

  private async withTimeout(input: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("model timeout")), this.timeoutMs)
    const onOuterAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", onOuterAbort, { once: true })

    try {
      return await this.provider.generate(input, controller.signal)
    } catch (err) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new AppError("MODEL_TIMEOUT", `Model request timed out after ${this.timeoutMs}ms`, {
          cause: err,
        })
      }
      throw err
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onOuterAbort)
    }
  }

  private accumulate(usage: ModelUsage, costUsd?: number): void {
    this.totals.calls += 1
    this.totals.inputTokens += usage.inputTokens
    this.totals.outputTokens += usage.outputTokens
    this.totals.cacheReadTokens += usage.cacheReadTokens ?? 0
    this.totals.cacheCreationTokens += usage.cacheCreationTokens ?? 0
    this.totals.costUsd = Number((this.totals.costUsd + (costUsd ?? 0)).toFixed(6))
  }
}

function extractStatus(err: AppError): number | undefined {
  const match = /HTTP (\d{3})/.exec(err.message)
  return match?.[1] ? Number(match[1]) : undefined
}

function readRetryAfterMs(err: AppError): number | undefined {
  const value = err.details?.retryAfterMs
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError("Retry backoff aborted"))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError("Retry backoff aborted"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** 取消是**用户意图**，不与其他可重试错误混用一个码。`CANCELLED` 不在 RETRYABLE 里。 */
function abortError(message: string): AppError {
  return new AppError("CANCELLED", message)
}

/** 指数退避计算（导出以便单测，不依赖 sleep）。 */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(baseMs * 2 ** attempt, maxMs)
  const jitter = Math.floor(random() * exponential * 0.5)
  return Math.min(exponential + jitter, maxMs)
}
