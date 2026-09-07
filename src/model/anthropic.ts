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
  type ModelStreamChunk,
  type ModelToolCall,
  type ModelUsage,
  type StopReason,
} from "./types.js"
import { asRecord, classifyHttpError, numberOr, parseArgsSafely } from "./openai-compat.js"
import { parseSseJson, readSseEvents } from "./streaming.js"

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
    /**
     * SSE 流式已实现（`generateStream`），两条路径共用同一段响应解析，
     * 所以这里的 `true` 有实现支撑，不是"计划中"的声明。
     */
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
    const response = await this.post(buildAnthropicBody(input, false), signal)
    const json: unknown = await response.json()
    return parseAnthropicResponse(json, input.model)
  }

  /**
   * 真流式（SSE）。
   *
   * 关键点：这里**不重写**响应映射。增量被拼成与非流式完全同形状的原始响应，
   * 最后交给同一个 `parseAnthropicResponse` —— 两条路径的字段永远对得上，
   * 不会出现"流式少了 requestId / usage 口径不同"这类漂移。
   */
  async *generateStream(
    input: ModelRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ModelStreamChunk, void, void> {
    const response = await this.post(buildAnthropicBody(input, true), signal)
    if (!response.body) {
      throw new AppError(
        "MODEL_INVALID_OUTPUT",
        "Anthropic returned a streaming response without a body",
      )
    }
    yield* parseAnthropicStream(response.body, input.model)
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    if (!this.apiKey) {
      throw new AppError("MODEL_AUTH_FAILED", "Anthropic provider requires an apiKey")
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
    return response
  }
}

/** 请求体：非流式与流式只差一个 `stream` 开关，其余字段必须完全一致。 */
function buildAnthropicBody(input: ModelRequest, stream: boolean): Record<string, unknown> {
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
    ...(stream ? { stream: true } : {}),
  }
  if (input.tools.length > 0) {
    body.tools = input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }))
  }
  return body
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

/* ------------------------------------------------------------------ *
 * 流式解析（SSE）→ 与非流式同形状的原始响应
 * ------------------------------------------------------------------ */

type StreamBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string }
  | { kind: "tool_use"; id: string; name: string; json: string; input: Record<string, unknown> }

/**
 * 把 Anthropic 的 SSE 事件流拼成消息，最后复用 `parseAnthropicResponse`。
 *
 * 事件形状（官方文档）：
 * - `message_start`：id / model / usage（输入侧 token）
 * - `content_block_start`：每个内容块的开头（text / tool_use / thinking）
 * - `content_block_delta`：`text_delta` / `input_json_delta` / `thinking_delta` / `signature_delta`
 * - `content_block_stop`
 * - `message_delta`：`stop_reason` 与输出 token
 * - `message_stop`
 *
 * `input_json_delta` 必须**按块累积成完整字符串再解析**：逐片 `JSON.parse`
 * 只会得到"模型调了工具但参数永远是空对象"。
 */
async function* parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
): AsyncGenerator<ModelStreamChunk, void, void> {
  let model = fallbackModel
  let requestId: string | undefined
  let stopReason: string | undefined
  const usage: Record<string, unknown> = {}
  const blocks: Array<StreamBlock | undefined> = []

  for await (const event of readSseEvents(body)) {
    if (event.event === "error") {
      throw new AppError(
        "MODEL_NETWORK",
        `Anthropic stream reported an error: ${event.data.slice(0, 200)}`,
      )
    }

    const json = parseSseJson(event.data)
    if (!json) continue
    const type = typeof json.type === "string" ? json.type : event.event

    switch (type) {
      case "message_start": {
        const message = asRecord(json.message)
        if (typeof message.model === "string") model = message.model
        if (typeof message.id === "string") requestId = message.id
        mergeUsage(usage, asRecord(message.usage))
        break
      }
      case "content_block_start": {
        const index = blockIndex(json, blocks.length)
        const block = asRecord(json.content_block)
        if (block.type === "text") {
          const text = typeof block.text === "string" ? block.text : ""
          blocks[index] = { kind: "text", text }
          if (text.length > 0) yield { type: "text", text }
        } else if (block.type === "tool_use") {
          const id = typeof block.id === "string" ? block.id : `tool_${index}`
          const name = typeof block.name === "string" ? block.name : ""
          blocks[index] = { kind: "tool_use", id, name, json: "", input: {} }
          yield { type: "tool_start", index, id, name }
        } else if (block.type === "thinking") {
          const thinking = typeof block.thinking === "string" ? block.thinking : ""
          blocks[index] = { kind: "thinking", thinking }
          if (thinking.length > 0) yield { type: "thinking", thinking }
        }
        break
      }
      case "content_block_delta": {
        const index = blockIndex(json, 0)
        const delta = asRecord(json.delta)
        if (delta.type === "text_delta") {
          const text = typeof delta.text === "string" ? delta.text : ""
          const block = ensureTextBlock(blocks, index)
          block.text += text
          if (text.length > 0) yield { type: "text", text }
        } else if (delta.type === "input_json_delta") {
          const partialJson = typeof delta.partial_json === "string" ? delta.partial_json : ""
          const block = blocks[index]
          if (block?.kind === "tool_use") block.json += partialJson
          if (partialJson.length > 0) yield { type: "tool_args", index, partialJson }
        } else if (delta.type === "thinking_delta") {
          const thinking = typeof delta.thinking === "string" ? delta.thinking : ""
          const block = blocks[index]
          if (block?.kind === "thinking") block.thinking += thinking
          if (thinking.length > 0) yield { type: "thinking", thinking }
        }
        // signature_delta 一类的块对业务无意义，直接忽略
        break
      }
      case "content_block_stop": {
        const index = blockIndex(json, 0)
        finalizeToolBlock(blocks[index])
        if (blocks[index]?.kind === "tool_use") yield { type: "tool_stop", index }
        break
      }
      case "message_delta": {
        const delta = asRecord(json.delta)
        if (typeof delta.stop_reason === "string") stopReason = delta.stop_reason
        mergeUsage(usage, asRecord(json.usage))
        break
      }
      default:
        // message_stop / ping 没有业务信息
        break
    }
  }

  // 少数服务端不发 content_block_stop：结尾统一兜底解析，避免参数停在半截
  for (const block of blocks) finalizeToolBlock(block)

  const content = blocks
    .filter((block): block is StreamBlock => block !== undefined)
    .map((block) => {
      switch (block.kind) {
        case "text":
          return { type: "text", text: block.text }
        case "thinking":
          return { type: "thinking", thinking: block.thinking }
        case "tool_use":
          return { type: "tool_use", id: block.id, name: block.name, input: block.input }
      }
    })

  yield {
    type: "end",
    response: parseAnthropicResponse(
      { id: requestId, model, content, stop_reason: stopReason, usage },
      fallbackModel,
    ),
  }
}

function blockIndex(json: Record<string, unknown>, fallback: number): number {
  const value = json.index
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback
}

function ensureTextBlock(
  blocks: Array<StreamBlock | undefined>,
  index: number,
): Extract<StreamBlock, { kind: "text" }> {
  const existing = blocks[index]
  if (existing?.kind === "text") return existing
  const created: StreamBlock = { kind: "text", text: "" }
  blocks[index] = created
  return created
}

function finalizeToolBlock(block: StreamBlock | undefined): void {
  if (block?.kind !== "tool_use" || block.json.length === 0) return
  const parsed = parseArgsSafely(block.json)
  block.input = parsed.ok ? parsed.value : {}
  block.json = ""
}

function mergeUsage(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "number" && Number.isFinite(value)) target[key] = value
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
