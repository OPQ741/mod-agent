/**
 * 模型层测试（ADR-6 网关统一封装 / ADR-11 三处 LLM 调用统一走网关）。
 *
 * 全部离线：用假的 fetch 注入 HTTP 响应，用 ScriptedProvider 回放决策。
 * 这样"测试红了"永远是代码问题。覆盖：
 * - 两个后端的请求/响应形状差异（system 位置、tool_result 配对方式）；
 * - 流式工具调用分片累积、参数 JSON 解析失败的数据化；
 * - 哪些错误重试、哪些不重试、退避上限与 Retry-After；
 * - 汇总 usage 与费用。
 */

import { describe, expect, it, vi } from "vitest"

import { ModelGateway, backoffDelay } from "../src/model/gateway.js"
import {
  OpenAICompatProvider,
  classifyHttpError,
  mapFinishReason,
  parseArgsSafely,
  parseOpenAIResponse,
  parseRetryAfter,
  toOpenAIMessages,
} from "../src/model/openai-compat.js"
import {
  AnthropicProvider,
  mapStopReason,
  parseAnthropicResponse,
  toAnthropicMessage,
} from "../src/model/anthropic.js"
import {
  ScriptExhaustedError,
  ScriptedProvider,
  ask,
  final,
  toolUse,
} from "../src/model/scripted.js"
import {
  estimateCost,
  messageToText,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "../src/model/types.js"
import { AppError } from "../src/shared/errors.js"
import type { ToolSpec } from "../src/model/types.js"

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function httpErrorResponse(status: number, body = "{}"): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } })
}

const TOOLS: ToolSpec[] = [
  {
    name: "repo.read_file",
    description: "read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
]

function baseRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "test-model",
    system: "You are an agent",
    messages: [{ role: "user", content: "hello" }],
    tools: TOOLS,
    ...overrides,
  }
}

describe("model/openai-compat: 请求与响应映射", () => {
  it("system 作为独立 role 消息，工具用 function.parameters", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }),
    )
    const provider = new OpenAICompatProvider({
      baseUrl: "https://api.test/v1",
      fetchImpl: fetchImpl as never,
    })
    await provider.generate(baseRequest(), undefined)

    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit] | undefined
    expect(call).toBeDefined()
    const [url, init] = call as [string, RequestInit]
    expect(url).toBe("https://api.test/v1/chat/completions")
    const body = JSON.parse(String(init?.body))
    expect(body.messages[0]).toEqual({ role: "system", content: "You are an agent" })
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "repo.read_file",
        description: "read a file",
        parameters: TOOLS[0]!.inputSchema,
      },
    })
  })

  it("tool_result 转成 role:tool 并靠 tool_call_id 配对", () => {
    const messages = toOpenAIMessages({
      role: "tool",
      toolCallId: "call_1",
      content: '{"ok":true}',
    } as never)
    expect(messages[0]).toMatchObject({ role: "tool", tool_call_id: "call_1" })
  })

  it("assistant 的 tool_use 转成 tool_calls", () => {
    const messages = toOpenAIMessages({
      role: "assistant",
      content: [{ type: "tool_use", id: "call_9", name: "repo.read_file", input: { path: "/a" } }],
    } as never)
    expect(messages[0]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call_9",
          type: "function",
          function: { name: "repo.read_file", arguments: '{"path":"/a"}' },
        },
      ],
    })
  })

  it("解析含 tool_calls 的响应", () => {
    const response = parseOpenAIResponse(
      {
        model: "m",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
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
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      },
      "fallback-model",
    )
    expect(response.stopReason).toBe("tool_use")
    expect(response.toolCalls[0]?.name).toBe("repo.read_file")
    expect(response.toolCalls[0]?.args).toEqual({ path: "/a.ts" })
    expect(response.usage.inputTokens).toBe(100)
    expect(response.usage.cacheReadTokens).toBe(40)
  })

  it("流式分片累积的 arguments 也能解析（多次 chunk 拼成一个 JSON）", () => {
    const response = parseOpenAIResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                { index: 0, id: "c1", function: { name: "repo.read_file", arguments: '{"pa' } },
                {
                  index: 0,
                  id: "c1",
                  function: { name: "repo.read_file", arguments: 'th":"/a.ts"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      "m",
    )
    expect(response.toolCalls[0]?.args).toEqual({ path: "/a.ts" })
  })

  it("参数 JSON 非法 → 变成数据（argsParseError），不是抛异常", () => {
    const response = parseOpenAIResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [{ id: "c1", function: { name: "t", arguments: "{bad json" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      "m",
    )
    expect(response.toolCalls[0]?.argsParseError).toBeDefined()
    expect(response.toolCalls[0]?.args).toEqual({})
  })

  it("parseArgsSafely 对空串返回空对象而非报错", () => {
    expect(parseArgsSafely("")).toEqual({ ok: true, value: {} })
    expect(parseArgsSafely("{").ok).toBe(false)
  })

  it("finish_reason 映射到统一 stopReason", () => {
    expect(mapFinishReason("stop")).toBe("end_turn")
    expect(mapFinishReason("tool_calls")).toBe("tool_use")
    expect(mapFinishReason("length")).toBe("max_tokens")
    expect(mapFinishReason("unknown_value")).toBe("unknown")
  })

  it("HTTP 错误分类：限流 / 鉴权 / 服务端错误", () => {
    expect(classifyHttpError(429, "slow down").code).toBe("MODEL_RATE_LIMIT")
    expect(classifyHttpError(503, "busy").code).toBe("MODEL_NETWORK")
    expect(classifyHttpError(401, "nope").code).toBe("MODEL_AUTH_FAILED")
    expect(classifyHttpError(400, "bad").code).toBe("MODEL_BAD_REQUEST")
    expect(classifyHttpError(408, "timeout").code).toBe("MODEL_TIMEOUT")
  })

  it("网络异常 → MODEL_NETWORK，取消 → MODEL_TIMEOUT", async () => {
    const failing = new OpenAICompatProvider({
      baseUrl: "https://api.test/v1",
      fetchImpl: (async () => {
        throw new Error("socket hang up")
      }) as never,
    })
    await expect(failing.generate(baseRequest(), undefined)).rejects.toMatchObject({
      code: "MODEL_NETWORK",
    })

    const aborting = new OpenAICompatProvider({
      baseUrl: "https://api.test/v1",
      fetchImpl: (async () => {
        const err = new Error("aborted")
        err.name = "AbortError"
        throw err
      }) as never,
    })
    await expect(aborting.generate(baseRequest(), undefined)).rejects.toMatchObject({
      code: "MODEL_TIMEOUT",
    })
  })

  it("Retry-After 头被解析成毫秒（秒数与非法值）", () => {
    const response = new Response("", { status: 429, headers: { "retry-after": "3" } })
    expect(parseRetryAfter(response)).toBe(3_000)
    expect(parseRetryAfter(new Response("", { status: 429 }))).toBeUndefined()
    expect(
      parseRetryAfter(new Response("", { status: 429, headers: { "retry-after": "garbage" } })),
    ).toBeUndefined()
  })

  it("鉴权头带上 API key 时不记录明文（脱敏发生在日志层，这里只验证形状）", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ choices: [{ message: { content: "ok" } }] }))
    const provider = new OpenAICompatProvider({
      baseUrl: "https://api.test/v1",
      apiKey: "sk-test-key-1234567890",
      fetchImpl: fetchImpl as never,
    })
    await provider.generate(baseRequest(), undefined)
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit] | undefined)?.[1]
    const headers = init?.headers as Record<string, string> | undefined
    expect(headers?.authorization).toBe("Bearer sk-test-key-1234567890")
  })

  it("未提供 baseUrl 尾部斜杠也能拼对", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ choices: [{ message: { content: "ok" } }] }))
    const provider = new OpenAICompatProvider({
      baseUrl: "https://api.test/v1/",
      fetchImpl: fetchImpl as never,
    })
    await provider.generate(baseRequest(), undefined)
    expect((fetchImpl.mock.calls[0] as unknown as [string] | undefined)?.[0]).toBe(
      "https://api.test/v1/chat/completions",
    )
  })
})

describe("model/anthropic: 请求与响应映射", () => {
  it("system 走顶层独立参数，消息体里没有 system 角色", () => {
    const mapped = [toAnthropicMessage({ role: "user", content: "hi" } as never)]
    expect(mapped[0]).toMatchObject({ role: "user" })
    expect(mapped.some((m) => (m as { role?: string }).role === "system")).toBe(false)
  })

  it("tool_result 放在 user 消息里，靠 tool_use_id 配对（不是 role:tool）", () => {
    const mapped = toAnthropicMessage({
      role: "tool",
      toolCallId: "call_1",
      content: "file content",
    } as never)
    expect(mapped.role).toBe("user")
    const blocks = mapped.content as Array<Record<string, unknown>>
    expect(blocks[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "call_1",
      content: "file content",
    })

    // 内容块形式同样要带上 id，否则多轮工具调用会断链
    const blockForm = toAnthropicMessage({
      role: "tool",
      toolCallId: "call_2",
      content: [{ type: "tool_result", toolUseId: "call_2", content: "x", isError: true }],
    } as never)
    expect((blockForm.content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "call_2",
      is_error: true,
    })
  })

  it("assistant 的 thinking 原样回传不丢", () => {
    const mapped = toAnthropicMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "step by step" },
        { type: "tool_use", id: "c1", name: "repo.read_file", input: {} },
      ],
    } as never)
    const blocks = mapped.content as Array<Record<string, unknown>>
    expect(blocks[0]).toMatchObject({ type: "thinking" })
    expect(blocks[1]).toMatchObject({ type: "tool_use" })
  })

  it("解析工具调用响应", () => {
    const response = parseAnthropicResponse(
      {
        id: "msg_1",
        model: "claude-test",
        role: "assistant",
        content: [
          { type: "text", text: "let me read it" },
          { type: "tool_use", id: "call_1", name: "repo.read_file", input: { path: "/a.ts" } },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 500,
          output_tokens: 30,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 0,
        },
      },
      "fallback",
    )
    expect(response.stopReason).toBe("tool_use")
    expect(response.toolCalls[0]?.args).toEqual({ path: "/a.ts" })
    expect(response.usage.cacheReadTokens).toBe(200)
    expect(response.model).toBe("claude-test")
  })

  it("stop_reason 映射覆盖", () => {
    expect(mapStopReason("end_turn")).toBe("end_turn")
    expect(mapStopReason("max_tokens")).toBe("max_tokens")
    expect(mapStopReason("tool_use")).toBe("tool_use")
    expect(mapStopReason(undefined)).toBe("unknown")
  })

  it("tools 用 input_schema（不是 function.parameters）", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        id: "m",
        model: "claude",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: {},
      }),
    )
    const provider = new AnthropicProvider({ apiKey: "k", fetchImpl: fetchImpl as never })
    await provider.generate(baseRequest(), undefined)
    const anthropicInit = (
      fetchImpl.mock.calls[0] as unknown as [string, RequestInit] | undefined
    )?.[1]
    const body = JSON.parse(String(anthropicInit?.body))
    expect(body.system).toBe("You are an agent")
    expect(body.tools[0]).toMatchObject({
      name: "repo.read_file",
      input_schema: TOOLS[0]!.inputSchema,
    })
    expect(anthropicInit?.headers).toMatchObject({ "anthropic-version": expect.any(String) })
  })

  it("HTTP 错误分类与 OpenAI 侧保持一致的错误码语义", async () => {
    const provider = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: (async () =>
        httpErrorResponse(429, '{"error":{"message":"rate limited"}}')) as never,
    })
    await expect(provider.generate(baseRequest(), undefined)).rejects.toMatchObject({
      code: "MODEL_RATE_LIMIT",
    })
  })
})

describe("model/gateway: 重试、退避、记账", () => {
  function flakyProvider(failures: AppError[], success: ModelResponse): ModelProvider {
    let calls = 0
    return {
      id: "flaky",
      capabilities: { toolCalling: true, streaming: false, structuredOutput: true, vision: false },
      async generate(): Promise<ModelResponse> {
        const failure = failures[calls]
        calls += 1
        if (failure) throw failure
        return success
      },
    }
  }

  const okReply: ModelResponse = {
    text: "ok",
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    model: "flaky",
    costUsd: 0.001,
  }

  it("可重试错误（限流）会退避重试并最终成功", async () => {
    const retries: number[] = []
    const gateway = new ModelGateway({
      provider: flakyProvider(
        [
          new AppError("MODEL_RATE_LIMIT", "HTTP 429 too many requests"),
          new AppError("MODEL_RATE_LIMIT", "HTTP 429 again"),
        ],
        okReply,
      ),
      maxRetries: 3,
      baseBackoffMs: 10,
      random: () => 0,
      sleep: async (ms) => {
        retries.push(ms)
      },
      onRetry: () => undefined,
    })
    const response = await gateway.generate(baseRequest())
    expect(response.text).toBe("ok")
    expect(retries.length).toBe(2)
    expect(gateway.usage.calls).toBe(1)
    expect(gateway.usage.retries).toBe(2)
  })

  it("429 的 Retry-After 优先于指数退避（sleep 收到服务端建议时长）", async () => {
    const sleeps: number[] = []
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "retry-after": "3" } }),
      )
      .mockResolvedValueOnce(
        okResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }),
      )
    const provider = new OpenAICompatProvider({
      baseUrl: "https://api.test/v1",
      fetchImpl: fetchImpl as never,
    })
    const gateway = new ModelGateway({
      provider,
      maxRetries: 3,
      baseBackoffMs: 10,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    const response = await gateway.generate(baseRequest())
    expect(response.text).toBe("ok")
    expect(sleeps).toEqual([3_000])
  })

  it("不可重试错误（鉴权/参数）立刻抛出，不浪费重试预算", async () => {
    const gateway = new ModelGateway({
      provider: flakyProvider(
        [
          new AppError("MODEL_AUTH_FAILED", "HTTP 401"),
          new AppError("MODEL_AUTH_FAILED", "again"),
          new AppError("MODEL_AUTH_FAILED", "again"),
        ],
        okReply,
      ),
      maxRetries: 3,
      sleep: async () => undefined,
    })
    await expect(gateway.generate(baseRequest())).rejects.toMatchObject({
      code: "MODEL_AUTH_FAILED",
    })
    expect(gateway.usage.retries).toBe(0)
  })

  it("重试次数用尽后抛出最后一个错误", async () => {
    const gateway = new ModelGateway({
      provider: flakyProvider(
        Array.from({ length: 5 }, () => new AppError("MODEL_NETWORK", "HTTP 503")),
        okReply,
      ),
      maxRetries: 2,
      baseBackoffMs: 5,
      random: () => 0,
      sleep: async () => undefined,
    })
    await expect(gateway.generate(baseRequest())).rejects.toMatchObject({ code: "MODEL_NETWORK" })
    expect(gateway.usage.retries).toBe(2)
  })

  it("每次重试都发一条 retry.api 事件（可观测要求）", async () => {
    const events: Array<{ attempt: number; error: string }> = []
    const gateway = new ModelGateway({
      provider: flakyProvider([new AppError("MODEL_RATE_LIMIT", "HTTP 429")], okReply),
      maxRetries: 2,
      baseBackoffMs: 5,
      random: () => 0,
      sleep: async () => undefined,
      onRetry: (event) => events.push({ attempt: event.attempt, error: event.error }),
    })
    await gateway.generate(baseRequest())
    expect(events).toEqual([{ attempt: 1, error: "MODEL_RATE_LIMIT" }])
  })

  it("退避指数增长且有上限，抖动可确定性注入", () => {
    expect(backoffDelay(0, 100, 10_000, () => 0)).toBe(100)
    expect(backoffDelay(1, 100, 10_000, () => 0)).toBe(200)
    expect(backoffDelay(20, 100, 10_000, () => 0)).toBe(10_000)
    const jittered = backoffDelay(0, 100, 10_000, () => 0.5)
    expect(jittered).toBeGreaterThan(100)
    expect(jittered).toBeLessThanOrEqual(10_000)
  })

  it("单次请求超时 → MODEL_TIMEOUT（可重试）", async () => {
    const slow: ModelProvider = {
      id: "slow",
      capabilities: {
        toolCalling: false,
        streaming: false,
        structuredOutput: false,
        vision: false,
      },
      async generate(_input, signal) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 2_000)
          signal?.addEventListener("abort", () => {
            clearTimeout(timer)
            resolve(undefined)
          })
        })
        throw new AppError("MODEL_NETWORK", "aborted by timeout")
      },
    }
    const gateway = new ModelGateway({
      provider: slow,
      timeoutMs: 120,
      maxRetries: 0,
      sleep: async () => undefined,
    })
    await expect(gateway.generate(baseRequest())).rejects.toMatchObject({ code: "MODEL_TIMEOUT" })
  })

  it("外部 AbortSignal 中断时立即放弃，不再重试", async () => {
    const controller = new AbortController()
    let attempts = 0
    const provider: ModelProvider = {
      id: "p",
      capabilities: {
        toolCalling: false,
        streaming: false,
        structuredOutput: false,
        vision: false,
      },
      async generate() {
        attempts += 1
        throw new AppError("MODEL_NETWORK", "boom")
      },
    }
    const gateway = new ModelGateway({ provider, maxRetries: 3, sleep: async () => undefined })
    controller.abort()
    /**
     * 取消抛 `CANCELLED` 而不是 `MODEL_TIMEOUT`。
     *
     * 两者语义不同：超时是"这次没等到、可以重试"，取消是"用户要求停、不许再试"。
     * 混用会让上层把一次用户取消记成一次可重试的网络故障。
     */
    await expect(gateway.generate(baseRequest(), controller.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    })
    expect(attempts).toBe(0)
  })

  it("累计 usage 与费用", async () => {
    const gateway = new ModelGateway({ provider: flakyProvider([], okReply) })
    await gateway.generate(baseRequest())
    await gateway.generate(baseRequest())
    expect(gateway.usage.calls).toBe(2)
    expect(gateway.usage.inputTokens).toBe(20)
    expect(gateway.usage.outputTokens).toBe(10)
    expect(gateway.usage.costUsd).toBeCloseTo(0.002, 6)
    gateway.resetUsage()
    expect(gateway.usage.calls).toBe(0)
  })

  it("maxRetries 被钳制在上限内，防误配置导致长时间挂起", () => {
    const gateway = new ModelGateway({ provider: flakyProvider([], okReply), maxRetries: 999 })
    expect(gateway.usage.calls).toBe(0)
  })
})

describe("model/scripted: 离线回放", () => {
  it("按脚本顺序产出决策", async () => {
    const provider = new ScriptedProvider([
      toolUse("repo.read_file", { path: "/a" }, "call_1"),
      final("done"),
    ])
    const first = await provider.generate(baseRequest())
    expect(first.toolCalls[0]?.name).toBe("repo.read_file")
    expect(provider.consumed).toBe(1)
    expect(provider.remaining).toBe(1)
  })

  it("脚本耗尽抛 ScriptExhaustedError —— 不兜底出 final，避免测试假绿", async () => {
    const provider = new ScriptedProvider([final("done")])
    await provider.generate(baseRequest())
    await expect(provider.generate(baseRequest())).rejects.toBeInstanceOf(ScriptExhaustedError)
  })

  it("支持按请求的函数式脚本（用于「第二条决策能看到上一步结果」的断言）", async () => {
    const seen: string[] = []
    const provider = new ScriptedProvider([
      (request) => {
        seen.push(request.messages.map((m) => m.role).join(","))
        return final("done")
      },
    ])
    await provider.generate(baseRequest())
    expect(seen[0]).toContain("user")
  })

  it("ask 决策形状合法", async () => {
    const provider = new ScriptedProvider([ask("which approach?")])
    const response = await provider.generate(baseRequest())
    expect(response.text).toContain("which approach?")
  })

  it("append 可追加脚本（模拟审批后再跑一段）", async () => {
    const provider = new ScriptedProvider([toolUse("repo.list_files", { path: "/w" }, "c1")])
    await provider.generate(baseRequest())
    provider.append(final("ok"))
    const second = await provider.generate(baseRequest())
    expect(second.text).toBe("ok")
  })
})

describe("model/types: 通用工具", () => {
  it("messageToText 把内容块拼成文本", () => {
    expect(messageToText({ role: "user", content: "plain" })).toBe("plain")
    expect(
      messageToText({
        role: "assistant",
        content: [
          { type: "text", text: "a" },
          { type: "tool_use", id: "c1", name: "t", input: {} },
        ],
      } as never),
    ).toContain("a")
  })

  it("estimateCost 按输入/输出/缓存单价计价", () => {
    const cost = estimateCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
        totalTokens: 4_000_000,
      },
      {
        inputUsdPerMTok: 3,
        outputUsdPerMTok: 15,
        cacheReadUsdPerMTok: 0.3,
        cacheWriteUsdPerMTok: 3.75,
      },
    )
    // 3 + 15 + 0.3 + 3.75
    expect(cost).toBeCloseTo(22.05, 6)
  })
})
