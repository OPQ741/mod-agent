/**
 * 流式契约与 SSE 解析（model-gateway.md §6.1）。
 *
 * 设计上的三个决定，都为了让"流式"与"非流式"不变成两套会各自漂移的实现：
 *
 * 1. **增量只是传输细节，最终仍是一个 `ModelResponse`。** 流的最后一个 chunk 是
 *    `{ type: "end", response }`，provider 在内部把增量拼成与非流式**同形状**的
 *    原始响应，再交给同一个 `parseXxxResponse`。于是"两条路径逐字段相等"不是靠
 *    测试盯着，而是靠构造保证 —— 流式解析代码只需要正确拼装，不需要重复一遍映射规则。
 * 2. **delta 不携带 stopReason / usage**，它们只属于 end。中途任何一条 delta 都不可
 *    被当成"这轮结束了"，否则主循环会在半句话上做决策。
 * 3. **SSE 只做行解析，不做协议判断。** 各后端的 `event:` 名与字段形状差异留在各自
 *    provider 里，这一层只负责把字节流切成 `{ event, data }`。
 */

export type { ModelDelta, ModelStreamChunk } from "./types.js"
export { isModelStreamEnd } from "./types.js"

/** 一条 SSE 事件：`event:` 名（可选）与拼接后的 `data:` 正文。 */
export interface SseEvent {
  event?: string
  data: string
}

/**
 * 把 `text/event-stream` 的字节流切成事件。
 *
 * 只做最小正确的解析：按空行分块、`data:` 多行用换行拼接、忽略 `:` 注释行。
 * 不处理 `id:` / `retry:` —— 这两类字段在模型接口上无人使用，处理它们只会增加
 * 出错面（例如把 `retry:` 误当重试指令）。
 */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      /**
       * 行结束符规范允许 CRLF / LF / **单独 CR** 三种。统一成 `\n` 再切块，
       * 但末尾孤立的 CR 要先留着：它可能是"CRLF 被切成两个 chunk"的前半，
       * 直接转成换行会在下一块开头多切出一个空事件。
       */
      buffer = normalizeNewlines(buffer)

      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const parsed = parseSseBlock(block)
        if (parsed) yield parsed
        boundary = buffer.indexOf("\n\n")
      }
    }

    // 有些服务端在最后一条事件后不补空行，残余缓冲仍要尝试解析一次
    buffer += decoder.decode()
    const tail = parseSseBlock(normalizeNewlines(buffer))
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}

/**
 * SSE 的行结束符允许 CRLF、LF、单独 CR 三种，统一成 `\n`。
 *
 * 末尾孤立的 CR 先留在缓冲里：它可能是"CRLF 被切成两个 chunk"的前半，
 * 若此时就转成换行，下一块开头的 `\n` 会多切出一个空事件。
 */
function normalizeNewlines(input: string): string {
  const endsWithCr = input.endsWith("\r")
  const body = endsWithCr ? input.slice(0, -1) : input
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  return endsWithCr ? `${normalized}\r` : normalized
}

/** 解析一个事件块；没有 `data` 也没有 `event` 时返回 undefined（例如纯注释块）。 */
export function parseSseBlock(block: string): SseEvent | undefined {
  const dataLines: string[] = []
  let event: string | undefined

  for (const line of block.split("\n")) {
    if (line.length === 0) continue
    if (line.startsWith(":")) continue
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim()
      continue
    }
    if (line.startsWith("data:")) {
      // 规范允许 `data:value` 与 `data: value` 两种写法，去掉一个前导空格
      dataLines.push(line.slice("data:".length).replace(/^ /, ""))
    }
  }

  if (dataLines.length === 0 && event === undefined) return undefined
  return { ...(event !== undefined ? { event } : {}), data: dataLines.join("\n") }
}

/** `data` 是 JSON 时解析，不是 JSON 时返回 undefined（`[DONE]` 一类哨兵就走这条）。 */
export function parseSseJson(data: string): Record<string, unknown> | undefined {
  const trimmed = data.trim()
  if (trimmed.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return undefined
  } catch {
    return undefined
  }
}
