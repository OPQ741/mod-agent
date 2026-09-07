/**
 * 流式测试（AUD-012 / IMPROVEMENT_ROADMAP D1）。
 *
 * 三条验收标准在这里被逐条钉住：
 * 1. **增量的语义与顺序正确**（文本按序到达、工具参数必须拼完整才解析）；
 * 2. **流式与非流式的结果逐字段相等** —— 用同一份语义 fixture 的两条路径对比，
 *    这条断言是防止"两条实现各自漂移"的唯一手段；
 * 3. **重试语义不能污染已吐出的内容**：一个 delta 都没吐时可以重试，
 *    吐过之后断流就只能失败，不能悄悄重放一遍。
 *
 * 全部离线：SSE 用内存 `ReadableStream` 回放，不联网。
 */

import { afterEach, describe, expect, it } from "vitest"

import { AnthropicProvider, parseAnthropicResponse } from "../src/model/anthropic.js"
import { OpenAICompatProvider, parseOpenAIResponse } from "../src/model/openai-compat.js"
import { ModelGateway } from "../src/model/gateway.js"
import { ScriptedProvider, final } from "../src/model/scripted.js"
import { parseSseBlock, readSseEvents } from "../src/model/streaming.js"
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamChunk,
} from "../src/model/types.js"
import { AgentRuntime } from "../src/runtime/runtime.js"
import { CliSession } from "../src/cli/session.js"
import { createMemoryIo } from "../src/cli/io.js"
import {
  MemoryStore,
  Metrics,
  collect,
  createTempWorkspace,
  eventTypes,
  noopLogger,
  settingsWith,
  type TempWorkspace,
} from "./helpers.js"

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

function sseResponse(blocks: readonly string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

/** 把 `[event, dataObject]` 拼成合法的 SSE 文本块（以空行结尾）。 */
function sseBlock(event: string, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data)
  return `event: ${event}\ndata: ${payload}\n\n`
}

function baseRequest(): ModelRequest {
  return {
    model: "test-model",
    system: "You are an agent",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        name: "repo.read_file",
        description: "read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
  }
}

/* ------------------------------------------------------------------ *
 * SSE 行解析
 * ------------------------------------------------------------------ */

describe("model/streaming: SSE 解析", () => {
  it("按空行切块，拼接多行 data，忽略注释与 CRLF", async () => {
    const body = sseResponse([
      ": keep-alive\r\n\r\n",
      // 同一块里混用 CRLF 与 LF：两种行结束符都必须被识别
      'event: message_start\rdata: {"a":\ndata: 1}\r\n\r\n',
      "data: [DONE]\n\n",
    ]).body
    expect(body).not.toBeNull()
    const events: Array<{ event?: string; data: string }> = []
    for await (const event of readSseEvents(body as ReadableStream<Uint8Array>)) events.push(event)

    expect(events).toHaveLength(2)
    expect(events[0]?.event).toBe("message_start")
    // 多行 data 用换行拼接，交给 JSON 解析时是一个完整对象
    expect(JSON.parse(events[0]?.data ?? "{}")).toEqual({ a: 1 })
    expect(events[1]?.data).toBe("[DONE]")
  })

  it("CRLF 被拆成两个 chunk 时不会多切出一个空事件", async () => {
    const body = sseResponse(["data: a\r", "\n\r", "\ndata: b\r\n\r\n"]).body
    expect(body).not.toBeNull()
    const data: string[] = []
    for await (const event of readSseEvents(body as ReadableStream<Uint8Array>))
      data.push(event.data)
    expect(data).toEqual(["a", "b"])
  })

  it("纯注释块不产出事件", () => {
    expect(parseSseBlock(": ping")).toBeUndefined()
    expect(parseSseBlock("")).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 * Anthropic 流式
 * ------------------------------------------------------------------ */

function anthropicSse(): string[] {
  return [
    sseBlock("message_start", {
      type: "message_start",
      message: {
        id: "msg_1",
        model: "claude-test",
        usage: { input_tokens: 11, cache_read_input_tokens: 2, output_tokens: 1 },
      },
    }),
    sseBlock("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseBlock("ping", { type: "ping" }),
    sseBlock("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    }),
    sseBlock("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: ", world" },
    }),
    sseBlock("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseBlock("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "repo.read_file", input: {} },
    }),
    // 参数分两片到达：必须拼完整再解析
    sseBlock("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"pa' },
    }),
    sseBlock("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: 'th":"/a.ts"}' },
    }),
    sseBlock("content_block_stop", { type: "content_block_stop", index: 1 }),
    sseBlock("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 25 },
    }),
    sseBlock("message_stop", { type: "message_stop" }),
  ]
}

const ANTHROPIC_NON_STREAM = {
  id: "msg_1",
  model: "claude-test",
  content: [
    { type: "text", text: "Hello, world" },
    { type: "tool_use", id: "toolu_1", name: "repo.read_file", input: { path: "/a.ts" } },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 11, cache_read_input_tokens: 2, output_tokens: 25 },
}

describe("model/anthropic: 流式与非流式结果一致", () => {
  it("增量顺序正确，最终 ModelResponse 与非流式逐字段相等", async () => {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      fetchImpl: (async () => sseResponse(anthropicSse())) as unknown as typeof fetch,
    })

    const chunks: ModelStreamChunk[] = []
    for await (const chunk of provider.generateStream(baseRequest())) chunks.push(chunk)

    // 文本增量按序到达
    expect(
      chunks.filter((c) => c.type === "text").map((c) => (c as { text: string }).text),
    ).toEqual(["Hello", ", world"])

    // 工具块的三段都存在，且参数分片是原样转发的
    expect(chunks.filter((c) => c.type === "tool_start")).toHaveLength(1)
    expect(chunks.filter((c) => c.type === "tool_args")).toHaveLength(2)

    const end = chunks.at(-1)
    expect(end?.type).toBe("end")
    if (end?.type !== "end") throw new Error("stream did not end")

    // 关键断言：与非流式解析同一份语义等价数据的结果一致
    const nonStream = parseAnthropicResponse(ANTHROPIC_NON_STREAM, "test-model")
    expect(end.response).toEqual(nonStream)
    expect(end.response.toolCalls[0]?.args).toEqual({ path: "/a.ts" })
  })

  it("流内 error 事件会抛出，不会被当成正常结束", async () => {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      fetchImpl: (async () =>
        sseResponse([
          sseBlock("message_start", { type: "message_start", message: { usage: {} } }),
          sseBlock("error", {
            type: "error",
            error: { type: "overloaded_error", message: "busy" },
          }),
        ])) as unknown as typeof fetch,
    })

    await expect(async () => {
      for await (const _chunk of provider.generateStream(baseRequest())) {
        // 只消费，不关心内容
      }
    }).rejects.toMatchObject({ code: "MODEL_NETWORK" })
  })
})

/* ------------------------------------------------------------------ *
 * OpenAI 兼容流式
 * ------------------------------------------------------------------ */

const OPENAI_NON_STREAM = {
  id: "chatcmpl-1",
  model: "gpt-test",
  choices: [
    {
      index: 0,
      message: {
        content: "Hello",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "repo.read_file", arguments: '{"path":"/a.ts"}' },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 20, total_tokens: 31 },
}

function openAISse(withUsage: boolean): string[] {
  const chunks: string[] = [
    `data: ${JSON.stringify({ id: "chatcmpl-1", model: "gpt-test", choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] })}\n\n`,
    `data: ${JSON.stringify({ id: "chatcmpl-1", model: "gpt-test", choices: [{ index: 0, delta: { content: "lo" } }] })}\n\n`,
    `data: ${JSON.stringify({ id: "chatcmpl-1", model: "gpt-test", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "repo.read_file", arguments: '{"pa' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ id: "chatcmpl-1", model: "gpt-test", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/a.ts"}' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ id: "chatcmpl-1", model: "gpt-test", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
  ]
  if (withUsage) {
    chunks.push(
      `data: ${JSON.stringify({ id: "chatcmpl-1", model: "gpt-test", choices: [], usage: { prompt_tokens: 11, completion_tokens: 20, total_tokens: 31 } })}\n\n`,
    )
  }
  chunks.push("data: [DONE]\n\n")
  return chunks
}

describe("model/openai-compat: 流式与非流式结果一致", () => {
  it("文本与工具参数分片按 index 累积，最终结果与非流式相等", async () => {
    const provider = new OpenAICompatProvider({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      fetchImpl: (async () => sseResponse(openAISse(true))) as unknown as typeof fetch,
    })

    const chunks: ModelStreamChunk[] = []
    for await (const chunk of provider.generateStream(baseRequest())) chunks.push(chunk)

    const end = chunks.at(-1)
    if (end?.type !== "end") throw new Error("stream did not end")
    expect(end.response).toEqual(parseOpenAIResponse(OPENAI_NON_STREAM, "test-model"))
    expect(end.response.toolCalls[0]?.args).toEqual({ path: "/a.ts" })
  })

  it("流里没有 usage 时估算兜底，不会把成本记账记成 0", async () => {
    const provider = new OpenAICompatProvider({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      fetchImpl: (async () => sseResponse(openAISse(false))) as unknown as typeof fetch,
    })

    let response: ModelResponse | undefined
    for await (const chunk of provider.generateStream(baseRequest())) {
      if (chunk.type === "end") response = chunk.response
    }
    if (!response) throw new Error("stream did not end")
    expect(response.usage.inputTokens).toBeGreaterThan(0)
    expect(response.usage.outputTokens).toBeGreaterThan(0)
    expect(response.costUsd).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------ *
 * 网关的重试语义
 * ------------------------------------------------------------------ */

function emptyResponse(overrides: Partial<ModelResponse> = {}): ModelResponse {
  const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
  return { text: "", toolCalls: [], stopReason: "end_turn", usage, model: "m", ...overrides }
}

class FakeStreamProvider implements ModelProvider {
  readonly id = "fake-stream"
  readonly capabilities = {
    toolCalling: true,
    streaming: true,
    structuredOutput: false,
    vision: false,
  }
  calls = 0

  constructor(
    private readonly behavior: (
      call: number,
      signal?: AbortSignal,
    ) => AsyncGenerator<ModelStreamChunk, void, void>,
  ) {}

  async generate(): Promise<ModelResponse> {
    throw new Error("generate() should not be used in streaming mode")
  }

  generateStream(
    _input: ModelRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ModelStreamChunk, void, void> {
    this.calls += 1
    return this.behavior(this.calls, signal)
  }
}

function instantGateway(provider: ModelProvider): ModelGateway {
  return new ModelGateway({
    provider,
    maxRetries: 3,
    baseBackoffMs: 1,
    maxBackoffMs: 4,
    random: () => 0.5,
    sleep: async () => {},
  })
}

describe("model/gateway: 流式重试语义", () => {
  it("一个增量都没吐出时，限流错误可以退避重试并最终成功", async () => {
    const provider = new FakeStreamProvider(async function* (call) {
      if (call === 1) {
        // 这里抛的是"连接阶段"的错误：还没有任何 delta 交给消费者
        throw new Error("429")
      }
      yield { type: "text", text: "ok" }
      yield { type: "end", response: emptyResponse({ text: "ok" }) }
    })
    const gateway = instantGateway(provider)

    const events = []
    for await (const event of gateway.stream(baseRequest())) events.push(event)

    expect(provider.calls).toBe(2)
    expect(events.map((e) => e.type)).toEqual(["retry", "delta", "done"])
    expect(gateway.usage.calls).toBe(1)
  })

  it("已经吐出增量后断流：不重试，直接失败（否则会看到重复文本）", async () => {
    const provider = new FakeStreamProvider(async function* () {
      yield { type: "text", text: "half" }
      throw new Error("connection reset")
    })
    const gateway = instantGateway(provider)

    const received: string[] = []
    await expect(async () => {
      for await (const event of gateway.stream(baseRequest())) {
        received.push(event.type)
      }
    }).rejects.toMatchObject({ code: "MODEL_NETWORK" })
    expect(provider.calls).toBe(1)
    expect(received).toEqual(["delta"])
  })

  it("没有流式能力的 provider 退回 generate()，产出一条 done", async () => {
    const provider: ModelProvider = {
      id: "non-stream",
      capabilities: { toolCalling: true, streaming: false, structuredOutput: false, vision: false },
      async generate() {
        return emptyResponse({ text: "plain" })
      },
    }
    const events = []
    for await (const event of instantGateway(provider).stream(baseRequest())) events.push(event)
    expect(events).toEqual([{ type: "done", response: emptyResponse({ text: "plain" }) }])
  })

  it("流式中途取消抛 CANCELLED，而不是超时或网络错误", async () => {
    const controller = new AbortController()
    const provider = new FakeStreamProvider(async function* (_call, signal) {
      yield { type: "text", text: "a" }
      if (signal?.aborted) throw new Error("aborted")
      yield { type: "text", text: "b" }
    })
    const iterator = instantGateway(provider).stream(baseRequest(), controller.signal)

    const first = await iterator.next()
    expect(first.value?.type).toBe("delta")
    controller.abort()
    await expect(iterator.next()).rejects.toMatchObject({ code: "CANCELLED" })
  })
})

/* ------------------------------------------------------------------ *
 * 主循环端到端
 * ------------------------------------------------------------------ */

const workspaces: TempWorkspace[] = []

afterEach(async () => {
  while (workspaces.length > 0) {
    const ws = workspaces.pop()
    if (ws) await ws.cleanup()
  }
})

async function workspace(): Promise<TempWorkspace> {
  const ws = await createTempWorkspace()
  workspaces.push(ws)
  return ws
}

describe("runtime/loop: 流式增量进入事件流", () => {
  it("增量被合并成 agent.message_delta，最终交付与非流式一致", async () => {
    const ws = await workspace()
    const longText = "x".repeat(500)
    const provider = new ScriptedProvider([final(longText)], {
      streaming: true,
      streamChunkChars: 20,
    })

    const runtime = await AgentRuntime.create({
      workspaceRoot: ws.root,
      settings: settingsWith({}),
      provider,
      store: new MemoryStore(),
      logger: noopLogger(),
      metrics: new Metrics(),
    })

    const taskId = await runtime.createTask({ title: "t", userRequest: "go", mode: "edit" })
    const { events, outcome } = await collect(runtime.run(taskId, { validationChecks: [] }))

    expect(outcome.status).toBe("completed")
    expect(outcome.summary).toBe(longText)

    const deltas = events.filter((event) => event.type === "agent.message_delta")
    // 500 字符 / 每次最多 160 字符或 8 个 chunk → 必须是合并后的少量事件
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.length).toBeLessThanOrEqual(10)
    const joined = deltas
      .map((event) => String((event.payload as { text?: unknown }).text ?? ""))
      .join("")
    expect(joined).toBe(longText)

    await runtime.close()
  })

  it("非流式 provider 不产生增量事件（既有路径行为不变）", async () => {
    const ws = await workspace()
    const provider = new ScriptedProvider([final("done")])

    const runtime = await AgentRuntime.create({
      workspaceRoot: ws.root,
      settings: settingsWith({}),
      provider,
      store: new MemoryStore(),
      logger: noopLogger(),
      metrics: new Metrics(),
    })

    const taskId = await runtime.createTask({ title: "t", userRequest: "go", mode: "edit" })
    const { events } = await collect(runtime.run(taskId, { validationChecks: [] }))
    expect(eventTypes(events)).not.toContain("agent.message_delta")

    await runtime.close()
  })
})

/* ------------------------------------------------------------------ *
 * CLI：正文写 stdout，且不复读
 * ------------------------------------------------------------------ */

describe("cli/session: 流式正文输出", () => {
  it("text 格式下正文进 stdout，收尾不重复整段 summary", async () => {
    const ws = await workspace()
    const io = createMemoryIo()
    const provider = new ScriptedProvider([final("streamed answer")], {
      streaming: true,
      streamChunkChars: 5,
    })

    const session = await CliSession.open({
      workspaceRoot: ws.root,
      settings: settingsWith({}),
      provider,
      io,
      format: "text",
    })
    await session.runOnce({ prompt: "hi", noValidation: true })

    // 正文出现在 stdout（属于结果），且只出现一次
    expect(io.stdoutText()).toContain("streamed answer")
    expect(io.stdoutText().split("streamed answer")).toHaveLength(2)
    await session.close()
  })
})
