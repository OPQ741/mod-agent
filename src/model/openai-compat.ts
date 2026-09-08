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
import { estimateTokens } from "../shared/tokens.js"
import {
  DEFAULT_PRICING,
  estimateCost,
  estimateMessagesTokens,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamChunk,
  type ModelToolCall,
  type ModelUsage,
  type StopReason,
} from "./types.js"
import { parseSseJson, readSseEvents } from "./streaming.js"

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
    /**
     * SSE 流式已实现（`generateStream`），与非流式共用同一段响应解析，
     * 这条声明有实现支撑。
     */
    streaming: true,
    structuredOutput: true,
    vision: false,
  }

  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly doFetch: typeof fetch
  private readonly organization: string | undefined

  /**
   * 流式请求是否带 `stream_options.include_usage`。
   *
   * OpenAI 官方认这个字段（不带它，流里就没有 usage 块）；但"兼容"端点对未知
   * 请求参数的容忍度各不相同，少数实现会直接 400。所以策略是：默认带上，
   * 一旦被 400 拒绝就降级一次并记住，后续请求不再重复这半个往返。
   */
  private includeUsage = true

  constructor(options: OpenAICompatOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "")
    this.apiKey = options.apiKey
    this.doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.organization = options.organization
  }

  async generate(input: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const response = await this.post(buildOpenAIBody(input, false), signal)
    const json: unknown = await response.json()
    return parseOpenAIResponse(json, input.model)
  }

  /**
   * 真流式（SSE）。
   *
   * 与非流式共用 `parseOpenAIResponse`：增量在这里被拼回 chat-completions 的
   * 原始响应形状（`choices[0].message.tool_calls` 仍是**完整** arguments 字符串），
   * 所以两条路径的结果逐字段一致。工具参数分片按 `index` 累积 ——
   * 逐片解析只会得到空参数（见文件顶部那条注释）。
   */
  async *generateStream(
    input: ModelRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ModelStreamChunk, void, void> {
    let response: Response
    try {
      response = await this.post(buildOpenAIBody(input, true, this.includeUsage), signal)
    } catch (err) {
      /**
       * 端点不认 `stream_options` 时的降级。
       *
       * 只在"确实是这个字段被拒"时降级：HTTP 400 且错误体里出现了字段名。
       * 其它 400（模型名写错、max_tokens 超限）照样抛 —— 把它们也当兼容问题
       * 重发一次，只会让真正的配置错误多绕一个来回，还把原因藏起来。
       */
      if (!this.includeUsage || !isUnsupportedStreamOption(err)) throw err
      this.includeUsage = false
      response = await this.post(buildOpenAIBody(input, true, false), signal)
    }
    if (!response.body) {
      throw new AppError(
        "MODEL_INVALID_OUTPUT",
        "OpenAI-compatible endpoint returned a streaming response without a body",
      )
    }
    yield* parseOpenAIStream(response.body, input)
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
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
      throw classifyHttpError(response.status, detail, parseRetryAfter(response))
    }
    return response
  }
}

/** 请求体：非流式与流式只差 `stream` 开关（以及流式时是否要 usage 块），其余字段完全一致。 */
function buildOpenAIBody(
  input: ModelRequest,
  stream: boolean,
  includeUsage = true,
): Record<string, unknown> {
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
    ...(stream ? { stream: true } : {}),
    /**
     * `stream_options.include_usage`：不加这一条，OpenAI 的流里**不会**出现 usage 块，
     * 流式一次调用的计价就只能靠本地估算（AUD-013）。带上它，官方端点会额外吐一个
     * `choices: []` 的尾块，里面只有 usage —— 解析侧已经把这个尾块当成普通 chunk
     * 处理（没有 delta 就只更新 usage），不需要特判。
     */
    ...(stream && includeUsage ? { stream_options: { include_usage: true } } : {}),
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
  return body
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

/* ------------------------------------------------------------------ *
 * 流式解析（SSE）→ 与非流式同形状的原始响应
 * ------------------------------------------------------------------ */

interface StreamToolCall {
  id: string
  name: string
  arguments: string
}

/**
 * 把 OpenAI 兼容后端的 SSE 拼回 chat-completions 响应。
 *
 * 每个 chunk 的 `choices[0].delta` 只带"这一片"：`content` 是文本增量，
 * `tool_calls` 是**分片**（同一个 `index` 的 `function.arguments` 要逐片拼接）。
 * 拼完之后交给 `parseOpenAIResponse`，与非流式走完全相同的映射与校验。
 */
async function* parseOpenAIStream(
  body: ReadableStream<Uint8Array>,
  input: ModelRequest,
): AsyncGenerator<ModelStreamChunk, void, void> {
  let model = input.model
  let requestId: string | undefined
  let content = ""
  let finishReason: string | undefined
  let usageRaw: Record<string, unknown> | undefined
  const toolCalls = new Map<number, StreamToolCall>()

  try {
    for await (const event of readSseEvents(body)) {
      const data = event.data.trim()
      if (data === "[DONE]") break
      const json = parseSseJson(data)
      if (!json) continue

      if (typeof json.model === "string") model = json.model
      if (typeof json.id === "string") requestId = json.id
      const usage = asRecord(json.usage)
      if (Object.keys(usage).length > 0) usageRaw = usage

      const choices = Array.isArray(json.choices) ? json.choices : []
      const choice = asRecord(choices[0])
      const delta = asRecord(choice.delta)
      if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason

      if (typeof delta.content === "string" && delta.content.length > 0) {
        content += delta.content
        yield { type: "text", text: delta.content }
      }

      const rawCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
      for (const raw of rawCalls) {
        const call = asRecord(raw)
        const fn = asRecord(call.function)
        const index = typeof call.index === "number" ? call.index : toolCalls.size
        const id =
          typeof call.id === "string" && call.id.length > 0
            ? call.id
            : (toolCalls.get(index)?.id ?? `call_${index}`)
        const name = typeof fn.name === "string" ? fn.name : ""
        const partialJson = typeof fn.arguments === "string" ? fn.arguments : ""

        const existing = toolCalls.get(index)
        if (!existing) {
          toolCalls.set(index, { id, name, arguments: partialJson })
          yield { type: "tool_start", index, id, name }
        } else {
          if (existing.name.length === 0 && name.length > 0) existing.name = name
          existing.arguments += partialJson
        }
        if (partialJson.length > 0) yield { type: "tool_args", index, partialJson }
      }
    }
  } catch (err) {
    throw interruptedOpenAIStream(err, { content, toolCalls, finishReason })
  }

  const message: Record<string, unknown> = { content }
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({
        index,
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }))
  }

  yield {
    type: "end",
    response: parseOpenAIResponse(
      {
        id: requestId,
        model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        /**
         * 有些兼容端点流式不返回 usage（`stream_options.include_usage` 不被支持）。
         * 这时用本地估算兜底，并把口径写在注释里：预算门禁本来就是估算，
         * 宁可有量不等于账单，也不要记 0 让成本门禁形同虚设。
         */
        usage: usageRaw ?? estimateStreamUsage(input, content, toolCalls),
      },
      input.model,
    ),
  }
}

function estimateStreamUsage(
  input: ModelRequest,
  content: string,
  toolCalls: ReadonlyMap<number, StreamToolCall>,
): Record<string, number> {
  const prompt = estimateTokens(input.system ?? "") + estimateMessagesTokens(input.messages)
  let completion = estimateTokens(content)
  for (const call of toolCalls.values()) completion += estimateTokens(call.arguments)
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

/**
 * 流中断时抛出什么（与 Anthropic 侧同语义，判据不同）。
 *
 * chat-completions 的分片协议**没有**"某个 tool_call 结束"信号：
 * 参数分片只有靠 `finish_reason` 出现才算收齐。所以只有已经看到
 * `finish_reason` 时，才敢把累积出的调用当成"完整"交出去；
 * 更早的断流一律没有可恢复的工具块 —— 这时宁可整轮失败，
 * 也不能把半截参数当成调用补进历史（模型会以为它执行过）。
 */
function interruptedOpenAIStream(
  err: unknown,
  state: {
    content: string
    toolCalls: ReadonlyMap<number, StreamToolCall>
    finishReason: string | undefined
  },
): AppError {
  const original: AppError =
    err instanceof AppError
      ? err
      : new AppError("MODEL_NETWORK", `Model stream failed: ${String(err)}`, { cause: err })

  const progressed = state.content.length > 0 || state.toolCalls.size > 0 || state.finishReason
  if (!progressed) return original

  const toolCalls =
    state.finishReason === undefined
      ? []
      : [...state.toolCalls.values()].map((call) => {
          const parsed = parseArgsSafely(call.arguments)
          return { id: call.id, name: call.name, input: parsed.ok ? parsed.value : {} }
        })

  return new AppError(
    "MODEL_STREAM_INTERRUPTED",
    `Model stream interrupted mid-response: ${original.message}`,
    {
      cause: err,
      details: {
        toolCalls,
        // 参数分片没收齐的调用数量：只用于诊断，不拿去执行
        incompleteToolCalls: state.finishReason === undefined ? state.toolCalls.size : 0,
        upstreamCode: original.code,
      },
    },
  )
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

export function classifyHttpError(status: number, detail: string, retryAfterMs?: number): AppError {
  const brief = detail.slice(0, 200)
  const retryDetails = retryAfterMs !== undefined ? { details: { retryAfterMs } } : undefined
  switch (status) {
    case 401:
    case 403:
      return new AppError("MODEL_AUTH_FAILED", `Authentication failed (HTTP ${status}): ${brief}`)
    case 429:
      return new AppError("MODEL_RATE_LIMIT", `Rate limited (HTTP 429): ${brief}`, retryDetails)
    case 400:
    case 404:
    case 422:
      return new AppError("MODEL_BAD_REQUEST", `Request rejected (HTTP ${status}): ${brief}`)
    case 408:
    case 409:
      return new AppError("MODEL_TIMEOUT", `Request timed out upstream (HTTP ${status}): ${brief}`)
    default:
      if (status >= 500) {
        return new AppError(
          "MODEL_NETWORK",
          `Upstream error (HTTP ${status}): ${brief}`,
          retryDetails,
        )
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

/**
 * 400 是不是"不认 stream_options"造成的。
 *
 * 判据只有一条：错误体里出现了这个字段名。分类时正文被截到 200 字符，
 * 但字段名通常就在错误段落里；截断后看不到字段名的情况，宁可让错误抛出去，
 * 也不猜 —— 猜错的代价是把真正的配置错误重发一遍。
 */
function isUnsupportedStreamOption(err: unknown): boolean {
  if (!(err instanceof AppError) || err.code !== "MODEL_BAD_REQUEST") return false
  return /stream_options|include_usage/i.test(err.message)
}
