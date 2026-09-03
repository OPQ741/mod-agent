/**
 * OpenAI 兼容后端适配（model-gateway.md §1.2）。
 *
 * 覆盖 OpenAI / DeepSeek / 通义 / Moonshot / 本地 vLLM / Ollama 等一切
 * chat-completions 形状的接口。适配层只做协议映射，不做业务判断。
 *
 * 最容易踩的坑是流式工具调用的分片累积：本实现走非流式，规避了那一类 bug；
 * 真要上流式时，`function.arguments` 是按 chunk 增量到达的，必须按 `index` 分别累积、
 * 拼完整后才能 `JSON.parse`（详见 model-gateway.md §1.2）。
 */

import { AppError } from "../shared/errors.js"
import {
  DEFAULT_PRICING,
  estimateCost,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
  type ModelUsage,
  type StopReason,
} from "./types.js"

export interface OpenAICompatOptions {
  baseUrl: string
  apiKey?: string
  /** 注入 fetch，便于测试用录制的 fixture 断言拼装结果。 */
  fetchImpl?: typeof fetch
  /** 组织头，可选。 */
  organization?: string
}

export class OpenAICompatProvider implements ModelProvider {
  readonly id = "openai-compat"
  readonly capabilities: ModelCapabilities = {
    toolCalling: true,
    streaming: true,
    structuredOutput: true,
    vision: false,
  }

  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly doFetch: typeof fetch
  private readonly organization: string | undefined

  constructor(options: OpenAICompatOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "")
    this.apiKey = options.apiKey
    this.doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.organization = options.organization
  }

  async generate(input: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const messages: unknown[] = []
    if (input.system) messages.push({ role: "system", content: input.system })
    for (const message of input.messages) {
      messages.push(...toOpenAIMessages(message))
    }

    const body: Record<string, unknown> = {
      model: input.model,
      messages,
      ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.stopSequences ? { stop: input.stopSequences } : {}),
    }
    if (input.tools.length > 0) {
      body.tools = input.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }))
    }

    const headers: Record<string, string> = { "content-type": "application/json" }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    if (this.organization) headers["openai-organization"] = this.organization

    let response: Response
    try {
      response = await this.doFetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      })
    } catch (err) {
      if (isAbortError(err))
        throw new AppError("MODEL_TIMEOUT", "Model request aborted", { cause: err })
      throw new AppError("MODEL_NETWORK", `Model request failed: ${String(err)}`, { cause: err })
    }

    if (!response.ok) {
      const detail = await safeReadBody(response)
      throw classifyHttpError(response.status, detail)
    }

    const json: unknown = await response.json()
    return parseOpenAIResponse(json, input.model)
  }
}

/* ------------------------------------------------------------------ *
 * 消息映射
 * ------------------------------------------------------------------ */

/** 导出以便单测：消息形状差异是这一层最容易出错的地方。 */
export function toOpenAIMessages(message: ModelMessageLike): unknown[] {
  if (message.role === "tool") {
    // OpenAI 侧工具结果是独立的 role:"tool" 消息，靠 tool_call_id 配对
    return [
      {
        role: "tool",
        tool_call_id: message.toolCallId ?? "",
        content:
          typeof message.content === "string" ? message.content : stringifyBlocks(message.content),
      },
    ]
  }
  if (message.role === "assistant" && Array.isArray(message.content)) {
    const toolCalls = message.content
      .filter((b): b is Extract<ContentBlockLike, { type: "tool_use" }> => b.type === "tool_use")
      .map((b) => ({
        id: b.id,
        type: "function" as const,
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      }))
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("")
    return [
      {
        role: "assistant",
        ...(text.length > 0 ? { content: text } : { content: "" }),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    ]
  }
  if (message.role === "user" && Array.isArray(message.content)) {
    // Anthropic 形状的 tool_result 被放在 user 消息里；OpenAI 必须拆成 role:"tool"
    const results = message.content.filter(
      (b): b is Extract<ContentBlockLike, { type: "tool_result" }> => b.type === "tool_result",
    )
    const others = message.content.filter((b) => b.type !== "tool_result")
    const out: unknown[] = []
    for (const result of results) {
      out.push({ role: "tool", tool_call_id: result.toolUseId, content: result.content })
    }
    if (others.length > 0) {
      out.push({
        role: "user",
        content: others
          .map((b) => (b.type === "text" ? b.text : b.type === "tool_use" ? "" : ""))
          .filter((s) => s.length > 0)
          .join("\n"),
      })
    }
    return out
  }
  return [
    { role: message.role, content: typeof message.content === "string" ? message.content : "" },
  ]
}

type ContentBlockLike =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | { type: "thinking"; thinking: string }

type ModelMessageLike = {
  role: "system" | "user" | "assistant" | "tool"
  content: string | ContentBlockLike[]
  toolCallId?: string
}

function stringifyBlocks(blocks: readonly ContentBlockLike[]): string {
  return blocks
    .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : ""))
    .join("\n")
}

/* ------------------------------------------------------------------ *
 * 响应解析
 * ------------------------------------------------------------------ */

export function parseOpenAIResponse(json: unknown, fallbackModel: string): ModelResponse {
  const root = asRecord(json)
  const choices = Array.isArray(root.choices) ? root.choices : []
  const choice = asRecord(choices[0])
  const message = asRecord(choice.message)

  const toolCalls: ModelToolCall[] = []
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  for (const fragment of accumulateCallFragments(rawCalls)) {
    const parsed = parseArgsSafely(fragment.arguments)
    toolCalls.push({
      id: fragment.id,
      name: fragment.name,
      ...(parsed.ok ? { args: parsed.value } : { args: {}, argsParseError: parsed.error }),
    })
  }

  const usageRaw = asRecord(root.usage)
  const promptTokens = numberOr(usageRaw.prompt_tokens, 0)
  const completionTokens = numberOr(usageRaw.completion_tokens, 0)
  const cached = numberOr(asRecord(usageRaw.prompt_tokens_details).cached_tokens, 0)
  const usage: ModelUsage = {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens: numberOr(usageRaw.total_tokens, promptTokens + completionTokens),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
  }

  return {
    text: typeof message.content === "string" ? message.content : "",
    toolCalls,
    stopReason: mapFinishReason(
      typeof choice.finish_reason === "string" ? choice.finish_reason : undefined,
    ),
    usage,
    model: typeof root.model === "string" ? root.model : fallbackModel,
    ...(typeof root.id === "string" ? { requestId: root.id } : {}),
    costUsd: estimateCost(usage, DEFAULT_PRICING),
  }
}

/**
 * 合并 tool_call 分片。
 *
 * 流式响应里 `arguments` 是被切成若干片下发的（`{"pa` + `th":"/a"}`），
 * 同一个 `id` 的分片必须**先拼完整串再解析**；逐片解析只会得到一堆残缺 JSON，
 * 表现为"模型明明调用了工具，参数却总是空的"。
 */
function accumulateCallFragments(rawCalls: readonly unknown[]): Array<{
  id: string
  name: string
  arguments: string
}> {
  const byKey = new Map<string, { id: string; name: string; arguments: string }>()
  let index = 0

  for (const raw of rawCalls) {
    const call = asRecord(raw)
    const fn = asRecord(call.function)
    const id = typeof call.id === "string" && call.id.length > 0 ? call.id : `call_${index}`
    const key =
      typeof call.index === "number" || typeof call.index === "string" ? String(call.index) : id
    const existing = byKey.get(key)
    const chunk = typeof fn.arguments === "string" ? fn.arguments : ""
    const name = typeof fn.name === "string" ? fn.name : ""

    if (existing) {
      existing.arguments += chunk
      if (existing.name.length === 0 && name.length > 0) existing.name = name
    } else {
      byKey.set(key, { id, name, arguments: chunk })
    }
    index += 1
  }

  return [...byKey.values()]
}

export function mapFinishReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn"
    case "tool_calls":
      return "tool_use"
    case "length":
      return "max_tokens"
    default:
      return reason ? "unknown" : "unknown"
  }
}

export function parseArgsSafely(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (raw.trim().length === 0) return { ok: true, value: {} }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> }
    }
    return { ok: false, error: `Tool arguments must be a JSON object, received ${typeof parsed}` }
  } catch (err) {
    return { ok: false, error: `Invalid JSON in tool arguments: ${String(err)}` }
  }
}

/* ------------------------------------------------------------------ *
 * 错误分类（model-gateway.md §6.2）
 * ------------------------------------------------------------------ */

export function classifyHttpError(status: number, detail: string): AppError {
  const brief = detail.slice(0, 200)
  switch (status) {
    case 401:
    case 403:
      return new AppError("MODEL_AUTH_FAILED", `Authentication failed (HTTP ${status}): ${brief}`)
    case 429:
      return new AppError("MODEL_RATE_LIMIT", `Rate limited (HTTP 429): ${brief}`)
    case 400:
    case 404:
    case 422:
      return new AppError("MODEL_BAD_REQUEST", `Request rejected (HTTP ${status}): ${brief}`)
    case 408:
    case 409:
      return new AppError("MODEL_TIMEOUT", `Request timed out upstream (HTTP ${status}): ${brief}`)
    default:
      if (status >= 500) {
        return new AppError("MODEL_NETWORK", `Upstream error (HTTP ${status}): ${brief}`)
      }
      return new AppError("MODEL_INVALID_OUTPUT", `Unexpected HTTP status ${status}: ${brief}`)
  }
}

/** 从响应体里抽取 `Retry-After` 可解析的秒数。 */
export function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after")
  if (!header) return undefined
  const seconds = Number(header.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ""
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")
}
