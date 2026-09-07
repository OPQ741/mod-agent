/**
 * 脚本化 Provider（development-guide.md §4 / §8）。
 *
 * 它是整套自测的地基：让主循环**离线**跑完，不联网、不烧钱、可复现。
 * 每一个 runtime 分支新增时，都应该同时加一条脚本用例。
 *
 * 关键设计：脚本耗尽时**抛异常**，而不是返回 final。
 * 因为"脚本用完了"意味着循环没在该停的地方停下 —— 如果这里兜底返回 final，
 * 测试会假绿，真正的问题（循环空转）被掩盖。
 */

import { AppError } from "../shared/errors.js"
import type { Decision } from "../shared/contracts.js"
import { newCallId } from "../shared/ids.js"
import { estimateTokens } from "../shared/tokens.js"
import {
  DEFAULT_PRICING,
  estimateCost,
  messageToText,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamChunk,
  type ModelUsage,
  type StopReason,
} from "./types.js"

/**
 * 一次响应里带多个 `tool_use`（并行工具调用）。
 *
 * 真实的模型会这么干（一次读三个文件），而 `Decision` 只能表达单个调用，
 * 所以单独开一个脚本步类型 —— 否则"并行调用"这条路径在离线测试里根本走不到。
 */
export interface ParallelToolUseStep {
  type: "parallel_tool_use"
  calls: ReadonlyArray<{
    toolName: string
    args: Record<string, unknown>
    callId?: string
  }>
}

/**
 * 直接给定停止原因的响应步。
 *
 * `Decision` 只能表达"tool_use / final / ask"三种**语义**结果，而
 * `max_tokens` / `error` / `unknown` 是**传输层**的结束原因 —— 用脚本重放
 * 才能让主循环里"截断不许当交付"这类分支在离线测试里真的走到。
 */
export interface RawResponseStep {
  type: "raw"
  text?: string
  toolCalls?: ReadonlyArray<{
    toolName: string
    args: Record<string, unknown>
    callId?: string
  }>
  stopReason: StopReason
  decisionHint?: "ask"
}

export type ScriptStep =
  | Decision
  | ParallelToolUseStep
  | RawResponseStep
  | ((request: ModelRequest, stepIndex: number) => Decision | ParallelToolUseStep | RawResponseStep)

export interface ScriptedProviderOptions {
  /** 每步产生的"输出 token 数"，用于让预算测试可复现。 */
  tokensPerStep?: number
  /** 期望的模型名，仅用于日志与事件。 */
  model?: string
  /** 记录每次收到的请求，供断言（例如"第二条决策能看到 read_file 的正文"）。 */
  onRequest?: (request: ModelRequest, stepIndex: number) => void
  /**
   * 打开流式回放：`generateStream()` 会把同一份响应切成增量吐出。
   * 默认 `false` —— 既有用例都走非流式路径，行为不受影响；
   * 要测"增量事件进入事件流"时显式打开。
   */
  streaming?: boolean
  /** 流式回放时每个文本增量的字符数。 */
  streamChunkChars?: number
}

export class ScriptExhaustedError extends AppError {
  constructor(steps: number) {
    super(
      "MODEL_EXHAUSTED",
      `ScriptedProvider exhausted after ${steps} step(s). The loop did not stop where it should have.`,
    )
    this.name = "ScriptExhaustedError"
  }
}

export class ScriptedProvider implements ModelProvider {
  readonly id = "scripted"
  private readonly caps: ModelCapabilities

  private index = 0
  private readonly steps: ScriptStep[]
  private readonly tokensPerStep: number
  private readonly modelName: string
  private readonly onRequest?: (request: ModelRequest, stepIndex: number) => void
  private readonly streamChunkChars: number

  constructor(steps: readonly ScriptStep[], options: ScriptedProviderOptions = {}) {
    this.steps = [...steps]
    this.tokensPerStep = options.tokensPerStep ?? 64
    this.modelName = options.model ?? "scripted-model"
    this.onRequest = options.onRequest
    this.streamChunkChars = Math.max(1, options.streamChunkChars ?? 40)
    this.caps = {
      toolCalling: true,
      streaming: options.streaming === true,
      structuredOutput: true,
      vision: false,
    }
  }

  get capabilities(): ModelCapabilities {
    return this.caps
  }

  /** 已消费的步数，测试用来断言"循环走了几步"。 */
  get consumed(): number {
    return this.index
  }

  get remaining(): number {
    return this.steps.length - this.index
  }

  /** 追加脚本（用于"审批后再跑一段"这类分段断言）。 */
  append(...steps: ScriptStep[]): void {
    this.steps.push(...steps)
  }

  async generate(input: ModelRequest, _signal?: AbortSignal): Promise<ModelResponse> {
    this.onRequest?.(input, this.index)
    const step = this.steps[this.index]
    if (step === undefined) {
      throw new ScriptExhaustedError(this.index)
    }
    this.index += 1

    const decision = typeof step === "function" ? step(input, this.index - 1) : step
    return this.render(decision, input)
  }

  /**
   * 流式回放：同一份 `ModelResponse` 切成增量吐出。
   *
   * 它不模拟真实网络的分段节奏（那会让测试变慢且不稳定），只保证
   * "增量事件能进入事件流、最终结果与非流式路径完全一致"这两件事。
   */
  async *generateStream(
    input: ModelRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ModelStreamChunk, void, void> {
    const response = await this.generate(input, signal)
    if (signal?.aborted) throw new AppError("CANCELLED", "Model stream aborted before emitting")

    for (let offset = 0; offset < response.text.length; offset += this.streamChunkChars) {
      const text = response.text.slice(offset, offset + this.streamChunkChars)
      if (text.length > 0) yield { type: "text", text }
    }

    for (let index = 0; index < response.toolCalls.length; index += 1) {
      const call = response.toolCalls[index]
      if (!call) continue
      yield { type: "tool_start", index, id: call.id, name: call.name }
      yield { type: "tool_args", index, partialJson: JSON.stringify(call.args) }
      yield { type: "tool_stop", index }
    }

    yield { type: "end", response }
  }

  private render(
    decision: Decision | ParallelToolUseStep | RawResponseStep,
    input: ModelRequest,
  ): ModelResponse {
    const promptTokens = input.messages.reduce(
      (sum, m) => sum + estimateTokens(messageToText(m)),
      0,
    )
    const usage: ModelUsage = {
      inputTokens: promptTokens,
      outputTokens: this.tokensPerStep,
      totalTokens: promptTokens + this.tokensPerStep,
    }

    if (decision.type === "raw") {
      return {
        text: decision.text ?? "",
        toolCalls: (decision.toolCalls ?? []).map((call) => ({
          id: call.callId || newCallId(),
          name: call.toolName,
          args: call.args,
        })),
        stopReason: decision.stopReason,
        usage,
        model: this.modelName,
        costUsd: estimateCost(usage, DEFAULT_PRICING),
        ...(decision.decisionHint ? { decisionHint: decision.decisionHint } : {}),
      }
    }

    if (decision.type === "parallel_tool_use") {
      return {
        text: "",
        toolCalls: decision.calls.map((call) => ({
          id: call.callId || newCallId(),
          name: call.toolName,
          args: call.args,
        })),
        stopReason: "tool_use",
        usage,
        model: this.modelName,
        costUsd: estimateCost(usage, DEFAULT_PRICING),
      }
    }

    switch (decision.type) {
      case "final":
        return {
          text: decision.summary,
          toolCalls: [],
          stopReason: "end_turn",
          usage,
          model: this.modelName,
          costUsd: estimateCost(usage, DEFAULT_PRICING),
        }
      case "tool_use":
        return {
          text: "",
          toolCalls: [
            {
              id: decision.callId || newCallId(),
              name: decision.toolName,
              args: decision.args,
            },
          ],
          stopReason: "tool_use",
          usage,
          model: this.modelName,
          costUsd: estimateCost(usage, DEFAULT_PRICING),
        }
      case "ask":
        return {
          text: decision.question,
          toolCalls: [],
          stopReason: "end_turn",
          usage,
          model: this.modelName,
          costUsd: estimateCost(usage, DEFAULT_PRICING),
          // 显式告诉主循环：这是提问，别当成交付结论
          decisionHint: "ask",
        }
      default: {
        const exhaustive: never = decision
        throw new AppError(
          "MODEL_INVALID_OUTPUT",
          `Unknown decision: ${JSON.stringify(exhaustive)}`,
        )
      }
    }
  }
}

/** 便捷构造器：`toolUse("repo.read_file", { path: "/x" })`。 */
export function toolUse(
  toolName: string,
  args: Record<string, unknown>,
  callId: string = newCallId(),
): Decision {
  return { type: "tool_use", callId, toolName, args }
}

export function final(summary: string): Decision {
  return { type: "final", summary }
}

export function ask(question: string): Decision {
  return { type: "ask", question }
}

/** 便捷构造器：一次响应里请求多个工具（验证并行调用链路）。 */
export function parallelToolUse(
  ...calls: ReadonlyArray<{ toolName: string; args: Record<string, unknown>; callId?: string }>
): ParallelToolUseStep {
  return { type: "parallel_tool_use", calls }
}
