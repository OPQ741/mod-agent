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
  type ModelUsage,
} from "./types.js"

export type ScriptStep = Decision | ((request: ModelRequest, stepIndex: number) => Decision)

export interface ScriptedProviderOptions {
  /** 每步产生的"输出 token 数"，用于让预算测试可复现。 */
  tokensPerStep?: number
  /** 期望的模型名，仅用于日志与事件。 */
  model?: string
  /** 记录每次收到的请求，供断言（例如"第二条决策能看到 read_file 的正文"）。 */
  onRequest?: (request: ModelRequest, stepIndex: number) => void
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
  readonly capabilities: ModelCapabilities = {
    toolCalling: true,
    streaming: false,
    structuredOutput: true,
    vision: false,
  }

  private index = 0
  private readonly steps: ScriptStep[]
  private readonly tokensPerStep: number
  private readonly modelName: string
  private readonly onRequest?: (request: ModelRequest, stepIndex: number) => void

  constructor(steps: readonly ScriptStep[], options: ScriptedProviderOptions = {}) {
    this.steps = [...steps]
    this.tokensPerStep = options.tokensPerStep ?? 64
    this.modelName = options.model ?? "scripted-model"
    this.onRequest = options.onRequest
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

  private render(decision: Decision, input: ModelRequest): ModelResponse {
    const promptTokens = input.messages.reduce(
      (sum, m) => sum + estimateTokens(messageToText(m)),
      0,
    )
    const usage: ModelUsage = {
      inputTokens: promptTokens,
      outputTokens: this.tokensPerStep,
      totalTokens: promptTokens + this.tokensPerStep,
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
