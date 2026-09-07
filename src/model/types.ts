/**
 * 模型层统一契约（model-gateway.md §1）。
 *
 * 业务层只面对 `ModelRequest / ModelResponse`；厂商差异（system 的位置、
 * 工具调用的载体、工具结果怎么回灌、结束原因叫什么）全部关在适配层里，
 * 不渗进业务代码。
 */

import type { JsonSchemaObject } from "../shared/json-schema.js"

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  /** 思考块：只用于维持 API 契约，不渲染、不落长期记忆（model-gateway.md §6.3）。 */
  | { type: "thinking"; thinking: string }

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | ContentBlock[]
  /** role 为 tool 时指向被回灌结果的 tool_use id。 */
  toolCallId?: string
  name?: string
}

export interface ToolSpec {
  name: string
  description: string
  inputSchema: JsonSchemaObject
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  /** 命中前缀缓存的输入 token（仍占窗口，只是计费便宜）。 */
  cacheReadTokens?: number
  cacheCreationTokens?: number
  totalTokens: number
}

export type StopReason =
  "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "error" | "unknown"

export interface ModelToolCall {
  id: string
  name: string
  /** 已解析为对象的入参。解析失败时 args 为空对象、argsParseError 给出原因。 */
  args: Record<string, unknown>
  argsParseError?: string
}

export interface ModelResponse {
  text: string
  toolCalls: ModelToolCall[]
  stopReason: StopReason
  usage: ModelUsage
  model: string
  requestId?: string
  /** 单请求成本（美元，按 list price 客户端估算，不是账单）。 */
  costUsd?: number
  /**
   * "这段纯文本是提问，不是结论"的显式信号。
   *
   * 没有它，主循环只能把"没有工具调用的纯文本"一律当成 final ——
   * 于是契约里的 `ask` 决策永远走不到，任务会在模型其实在等人回答时被判成完成。
   * 只有后端/回放器能给出这个信号；给不出时一律按 final 处理（fail-safe 到"继续"。
   */
  decisionHint?: "ask"
}

export interface ModelRequest {
  model: string
  /** 系统提示词：Anthropic 走独立参数，OpenAI 兼容走 messages 里的 system 角色。 */
  system?: string
  messages: ModelMessage[]
  tools: ToolSpec[]
  maxTokens?: number
  temperature?: number
  stopSequences?: string[]
  /** 思考预算（模型内部推理深度，与"快慢档"是两个正交轴）。 */
  effort?: "low" | "medium" | "high"
}

export interface ModelCapabilities {
  toolCalling: boolean
  streaming: boolean
  structuredOutput: boolean
  vision: boolean
}

/**
 * Provider 接口（model-gateway.md §1）。
 *
 * `capabilities` 让网关知道这个模型能不能干某件事 —— 把不具备工具调用能力的模型
 * 派去跑 Agent 任务，是运行时才炸、排查极贵的一类错误。
 */
export interface ModelProvider {
  readonly id: string
  readonly capabilities: ModelCapabilities
  generate(input: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>
  /**
   * 可选流式方法。只有 `capabilities.streaming === true` 的 provider 才需要实现；
   * 没有它时网关退回 `generate()`，业务层行为不变（只是没有增量输出）。
   *
   * 最后一个 chunk 必须是 `{ type: "end", response }`，且 response 要与同一请求
   * 走 `generate()` 时**逐字段一致** —— 调用方据此决定"要不要把它当真"。
   */
  generateStream?(input: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamChunk>
}

/** 统一后的单个增量。 */
export type ModelDelta =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  /** 一个工具块开始。`index` 是后端给的块序号，用于并行调用时区分。 */
  | { type: "tool_start"; index: number; id: string; name: string }
  /** 工具参数 JSON 的片段：必须按 `index` 累积到完整后再 `JSON.parse`。 */
  | { type: "tool_args"; index: number; partialJson: string }
  | { type: "tool_stop"; index: number }

/**
 * 流上的一个 chunk。
 *
 * `end` 必须**最后**出现且只出现一次。没收到 `end` 的流是残缺的：
 * 网关会把它当错误，而不是把半截文本当成一轮完整响应。
 */
export type ModelStreamChunk = ModelDelta | { type: "end"; response: ModelResponse }

export function isModelStreamEnd(
  chunk: ModelStreamChunk,
): chunk is { type: "end"; response: ModelResponse } {
  return chunk.type === "end"
}

/** 把模型消息压成纯文本（用于 token 估算、压缩与日志摘要）。 */
export function messageToText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content
  return message.content
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text
        case "thinking":
          return ""
        case "tool_use":
          return `[tool_use ${block.name}] ${JSON.stringify(block.input)}`
        case "tool_result":
          return `[tool_result ${block.toolUseId}] ${block.content}`
        default:
          return ""
      }
    })
    .join("\n")
}

export function estimateMessagesTokens(messages: readonly ModelMessage[]): number {
  return messages.reduce((sum, m) => sum + messageToText(m).length, 0)
}

/** 按 list price 估算成本（每百万 token 单价）。 */
export interface ModelPricing {
  inputUsdPerMTok: number
  outputUsdPerMTok: number
  cacheReadUsdPerMTok?: number
  cacheWriteUsdPerMTok?: number
}

export function estimateCost(usage: ModelUsage, pricing: ModelPricing): number {
  const input = (usage.inputTokens / 1_000_000) * pricing.inputUsdPerMTok
  const output = (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMTok
  const cacheRead = usage.cacheReadTokens
    ? (usage.cacheReadTokens / 1_000_000) *
      (pricing.cacheReadUsdPerMTok ?? pricing.inputUsdPerMTok * 0.1)
    : 0
  const cacheWrite = usage.cacheCreationTokens
    ? (usage.cacheCreationTokens / 1_000_000) *
      (pricing.cacheWriteUsdPerMTok ?? pricing.inputUsdPerMTok * 1.25)
    : 0
  return Number((input + output + cacheRead + cacheWrite).toFixed(6))
}

/** 内置价格表：只为估算，不准确时可用设置覆盖。 */
export const DEFAULT_PRICING: ModelPricing = {
  inputUsdPerMTok: 3,
  outputUsdPerMTok: 15,
  cacheReadUsdPerMTok: 0.3,
  cacheWriteUsdPerMTok: 3.75,
}
