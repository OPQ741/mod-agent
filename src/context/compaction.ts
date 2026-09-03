/**
 * 分层压缩流水线（context-engineering.md §5.1）。
 *
 * 从最廉价到最重，只有必要时才动用最重的手段：
 *   第 0 层  执行时截断（保头尾）—— 已在工具层做掉
 *   第 0.5 层 大结果落盘 —— 已在执行器做掉
 *   第 1 层  去重
 *   第 2 层  折叠旧 observation（超过最近 5 轮的各折叠成一行）
 *   第 3 层  LLM 摘要（兜底档，可插拔）
 *
 * 两条硬约束：
 * 1. **只在 turn boundary 触发** —— 中途压缩会让工具调用配对断裂；
 * 2. **绝不破坏 tool_use 与 tool_result 的配对**。配对错了，模型会收到它没请求过的结果。
 *
 * 另外，"压缩"与"前缀缓存"互相矛盾：裁剪历史会改变已缓存的前缀。所以触发阈值
 * 做成配置项，让调用方按缓存热度权衡（model-gateway.md §5.2）。
 */

import { estimateTokens } from "../shared/tokens.js"
import type { ContentBlock, ModelMessage } from "../model/types.js"
import { messageToText } from "../model/types.js"
import { buildContinuationPrompt } from "./system-prompt.js"

export interface CompactionOptions {
  contextWindowTokens: number
  /** 占用比例超过这个值即触发（默认 0.8）。 */
  threshold?: number
  /** 保留最近多少轮不折叠。 */
  keepRecentRounds?: number
  /** 兜底摘要器；不提供时只做规则式压缩，不调用模型。 */
  summarizer?: (messages: readonly ModelMessage[]) => Promise<string>
}

export interface CompactionResult {
  messages: ModelMessage[]
  compacted: boolean
  /** 被折叠的 observation 数量。 */
  folded: number
  /** 被整体丢弃的轮次数。 */
  droppedRounds: number
  summary?: string
  /** 压缩前后的 token 估算，用于可观测性。 */
  beforeTokens: number
  afterTokens: number
}

const DEFAULT_KEEP_RECENT = 5

export function estimateMessagesTokens(messages: readonly ModelMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(messageToText(m)), 0)
}

/** 是否应该压缩。 */
export function shouldCompact(
  messages: readonly ModelMessage[],
  options: CompactionOptions,
): boolean {
  const threshold = options.threshold ?? 0.8
  return estimateMessagesTokens(messages) > options.contextWindowTokens * threshold
}

/**
 * 执行规则式压缩。
 *
 * 保序不变量：
 * - 第 0 条（system）永远保留；
 * - 首条 user（用户请求 + 规则）永远保留 —— 这是"目标漂移"的第一道防线；
 * - 末尾若干轮完整保留；
 * - 中间部分按轮折叠，但**成对**处理：一次 tool_use 与它的 tool_result 同进同出。
 */
export async function compact(
  messages: readonly ModelMessage[],
  options: CompactionOptions,
): Promise<CompactionResult> {
  const beforeTokens = estimateMessagesTokens(messages)
  const keepRecent = options.keepRecentRounds ?? DEFAULT_KEEP_RECENT

  if (!shouldCompact(messages, options)) {
    return {
      messages: [...messages],
      compacted: false,
      folded: 0,
      droppedRounds: 0,
      beforeTokens,
      afterTokens: beforeTokens,
    }
  }

  const head = takeHead(messages)
  const tail = takeTail(messages, keepRecent)
  // 尾区起点**不得早于头区**：消息很短时（比如整个会话只有两三轮），
  // 尾区会一路推到开头，与头区重叠 —— 拼回去就会把首条 user 重复一遍，
  // 表现为"压缩后消息反而变多了"。
  const tailStart = Math.max(head.count, messages.length - tail.count)
  const middle = messages.slice(head.count, tailStart)
  const tailMessages = messages.slice(tailStart)

  let folded = 0
  const foldedMiddle: ModelMessage[] = []
  for (const message of middle) {
    if (message.role === "tool" || isToolResultUser(message)) {
      folded += 1
      foldedMiddle.push({
        role: "user",
        content: `[folded observation] ${oneLineDigest(messageToText(message))}`,
      })
      continue
    }
    if (message.role === "assistant" && containsOnlyToolUse(message)) {
      // 与它的结果一起折叠：只留一行轨迹，不留下悬空的 tool_use
      folded += 1
      foldedMiddle.push({
        role: "assistant",
        content: `[folded tool call] ${oneLineDigest(messageToText(message))}`,
      })
      continue
    }
    foldedMiddle.push(message)
  }

  let compactedMessages: ModelMessage[] = [...head.messages, ...foldedMiddle, ...tailMessages]
  let afterTokens = estimateMessagesTokens(compactedMessages)
  let summary: string | undefined
  let droppedRounds = 0

  // 规则式还不够：调用兜底摘要器把中段压成一段，仍然保持配对完整
  if (afterTokens > options.contextWindowTokens * 0.6 && options.summarizer) {
    summary = await options.summarizer(middle)
    compactedMessages = [
      ...head.messages,
      { role: "user", content: buildContinuationPrompt(summary) },
      ...tailMessages,
    ]
    droppedRounds = middle.length
    afterTokens = estimateMessagesTokens(compactedMessages)
  }

  return {
    messages: compactedMessages,
    compacted: true,
    folded,
    droppedRounds,
    ...(summary ? { summary } : {}),
    beforeTokens,
    afterTokens,
  }
}

/* ------------------------------------------------------------------ *
 * 分段
 * ------------------------------------------------------------------ */

/** 头部：system + 首条 user（用户请求与项目规则所在）。 */
function takeHead(messages: readonly ModelMessage[]): { messages: ModelMessage[]; count: number } {
  const out: ModelMessage[] = []
  let count = 0
  for (const message of messages) {
    if (message.role === "system") {
      out.push(message)
      count += 1
      continue
    }
    if (message.role === "user" && out.every((m) => m.role === "system")) {
      out.push(message)
      count += 1
    }
    break
  }
  return { messages: out, count }
}

/**
 * 尾部：完整保留最近 N 个"轮次"。
 *
 * 一个轮次 = 一条 assistant（可能带 tool_use）+ 紧随其后的结果消息。
 * 从后往前扫，遇到 tool 结果就把对应的 assistant 一起纳入，保证配对完整。
 */
function takeTail(
  messages: readonly ModelMessage[],
  rounds: number,
): { messages: ModelMessage[]; count: number } {
  let index = messages.length - 1
  let countedRounds = 0

  while (index >= 0) {
    const message = messages[index]
    if (!message) break
    if (message.role === "assistant") {
      countedRounds += 1
      if (countedRounds >= rounds) break
    }
    index -= 1
  }
  // 回退到该 assistant 之前，确保不切断它的 tool_result
  let start = Math.max(0, index)
  for (let i = messages.length - 1; i > start; i -= 1) {
    const message = messages[i]
    if (message && (message.role === "tool" || isToolResultUser(message))) {
      // 结果消息必须留在尾部，往前推 start 直到它的发起 assistant 也在
      start = Math.min(start, findOwningAssistant(messages, i))
    }
  }
  return { messages: messages.slice(start), count: messages.length - start }
}

function findOwningAssistant(messages: readonly ModelMessage[], resultIndex: number): number {
  for (let i = resultIndex - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === "assistant") return i
  }
  return 0
}

function isToolResultUser(message: ModelMessage): boolean {
  if (message.role !== "user") return false
  return (
    Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result")
  )
}

function containsOnlyToolUse(message: ModelMessage): boolean {
  if (!Array.isArray(message.content)) return false
  return message.content.every((block) => block.type === "tool_use" || block.type === "thinking")
}

const MAX_DIGEST = 120

/** 把一段 observation 压成一行摘要。 */
export function oneLineDigest(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= MAX_DIGEST) return flat
  return `${flat.slice(0, MAX_DIGEST)}…`
}

/**
 * 去重：连续完全相同的 user / tool 消息只留一条。
 * （模型偶尔会重复回灌同一段内容，去重是零成本的纯收益。）
 */
export function dedupeMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = []
  let previousKey: string | undefined
  for (const message of messages) {
    const key = `${message.role}:${messageTextKey(message)}`
    if (key === previousKey && (message.role === "tool" || message.role === "user")) continue
    previousKey = key
    out.push(message)
  }
  return out
}

function messageTextKey(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content
  return message.content
    .map((block: ContentBlock) =>
      block.type === "text" ? block.text : block.type === "tool_result" ? block.content : "",
    )
    .join("")
}
