/**
 * Anthropic Messages API 适配（model-gateway.md §1.2）。
 *
 * 与 OpenAI 兼容侧的四个关键差异：
 * - 系统提示词是独立的 `system` 参数，不是 messages 里的一条 system 角色；
 * - 工具 schema 字段叫 `input_schema`，不包 `type:"function"` 外壳；
 * - 工具结果是 `role:"user"` 消息里的 `tool_result` block，靠 `tool_use_id` 配对；
 * - 结束原因叫 `stop_reason`，缓存命中在 `usage.cache_read_input_tokens`。
 */

import { AppError } from "../shared/errors.js"
import {
  DEFAULT_PRICING,
  estimateCost,
  type ContentBlock,
  type ModelCapabilities,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
  type ModelUsage,
  type StopReason,
} from "./types.js"
import { asRecord, classifyHttpError, numberOr } from "./openai-compat.js"

export interface AnthropicOptions {
  baseUrl?: string
  apiKey?: string
  anthropicVersion?: string
  fetchImpl?: typeof fetch
}

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic"
  readonly capabilities: ModelCapabilities = {
    toolCalling: true,
    streaming: true,
    structuredOutput: true,
    vision: true,
  }

  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly version: string
  private readonly doFetch: typeof fetch

  constructor(options: AnthropicOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")
    this.apiKey = options.apiKey
    this.version = options.anthropicVersion ?? "2023-06-01"
    this.doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  async generate(input: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    if (!this.apiKey) {
      throw new AppError("MODEL_AUTH_FAILED", "Anthropic provider requires an apiKey")
    }

    const messages = input.messages
      .filter((m) => m.role !== "system")
      .map((m) => toAnthropicMessage(m))

    const body: Record<string, unknown> = {
      model: input.model,
      messages,
      max_tokens: input.maxTokens ?? 8192,
      ...(input.system ? { system: input.system } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.stopSequences ? { stop_sequences: input.stopSequences } : {}),
    }
    if (input.tools.length > 0) {
      body.tools = input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }))
    }

    let response: Response
    try {
      response = await this.doFetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": this.version,
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      })
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        throw new AppError("MODEL_TIMEOUT", "Model request aborted", { cause: err })
      }
      throw new AppError("MODEL_NETWORK", `Model request failed: ${String(err)}`, { cause: err })
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw classifyHttpError(response.status, detail)
    }

    const json: unknown = await response.json()
    return parseAnthropicResponse(json, input.model)
  }
}

/**
 * 消息映射：把统一形状翻成 Anthropic 形状。
 *
 * 配对纪律（development-guide.md §4 "最容易写错三件事" 第 1 条）：
 * tool_result 必须放进 `role:"user"` 消息，且 `tool_use_id` 要能对上前一轮
 * assistant 消息里那个 tool_use block 的 id。
 */
export function toAnthropicMessage(message: ModelMessage): Record<string, unknown> {
  // 工具结果：即使 content 是纯字符串，也必须包成 tool_result block 并带上
  // `tool_use_id`。直接塞成一条 user 文本会丢掉配对关系 ——
  // 上一轮 assistant 的 tool_use 没有对应结果，API 侧要么报错、
  // 要么模型把结果误当成"用户又说了句话"，多轮工具调用从此断链。
  if (message.role === "tool") {
    // 错误结果必须标 `is_error`，否则模型会把"工具报错"当成"工具给了个奇怪的返回值"
    const isError =
      message.name === "error" ||
      (Array.isArray(message.content) &&
        message.content.some((block) => block.type === "tool_result" && block.isError))
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId ?? "",
          content:
            typeof message.content === "string"
              ? message.content
              : stringifyBlocks(message.content),
          ...(isError ? { is_error: true } : {}),
        },
      ],
    }
  }

  if (typeof message.content === "string") {
    return { role: message.role, content: message.content }
  }

  const blocks: Array<Record<string, unknown>> = []
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        blocks.push({ type: "text", text: block.text })
        break
      case "thinking":
        // 思考块原样回传以维持 API 契约，但不渲染、不落上下文分析
        blocks.push({ type: "thinking", thinking: block.thinking })
        break
      case "tool_use":
        blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input })
        break
      case "tool_result":
        blocks.push({
          type: "tool_result",
          tool_use_id: block.toolUseId,
          content: block.content,
          ...(block.isError ? { is_error: true } : {}),
        })
        break
      default:
        break
    }
  }
  return { role: message.role, content: blocks }
}

function stringifyBlocks(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text
        case "tool_result":
          return block.content
        case "thinking":
          return ""
        default:
          return ""
      }
    })
    .join("\n")
}

export function parseAnthropicResponse(json: unknown, fallbackModel: string): ModelResponse {
  const root = asRecord(json)
  const content = Array.isArray(root.content) ? root.content : []

  let text = ""
  const toolCalls: ModelToolCall[] = []
  const thinking: ContentBlock[] = []

  for (const raw of content) {
    const block = asRecord(raw)
    switch (block.type) {
      case "text":
        text += typeof block.text === "string" ? block.text : ""
        break
      case "thinking":
        thinking.push({ type: "thinking", thinking: String(block.thinking ?? "") })
        break
      case "tool_use": {
        const input = block.input
        toolCalls.push({
          id: typeof block.id === "string" ? block.id : `call_${toolCalls.length}`,
          name: typeof block.name === "string" ? block.name : "",
          args:
            typeof input === "object" && input !== null && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : {},
        })
        break
      }
      default:
        break
    }
  }

  const usageRaw = asRecord(root.usage)
  const inputTokens = numberOr(usageRaw.input_tokens, 0)
  const outputTokens = numberOr(usageRaw.output_tokens, 0)
  const cacheRead = numberOr(usageRaw.cache_read_input_tokens, 0)
  const cacheCreation = numberOr(usageRaw.cache_creation_input_tokens, 0)
  const usage: ModelUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens + cacheRead + cacheCreation,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheCreation > 0 ? { cacheCreationTokens: cacheCreation } : {}),
  }

  return {
    text,
    toolCalls,
    stopReason: mapStopReason(typeof root.stop_reason === "string" ? root.stop_reason : undefined),
    usage,
    model: typeof root.model === "string" ? root.model : fallbackModel,
    ...(typeof root.id === "string" ? { requestId: root.id } : {}),
    costUsd: estimateCost(usage, DEFAULT_PRICING),
  }
}

export function mapStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn"
    case "tool_use":
      return "tool_use"
    case "max_tokens":
      return "max_tokens"
    case "stop_sequence":
      return "stop_sequence"
    default:
      return "unknown"
  }
}
