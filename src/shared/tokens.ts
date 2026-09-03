/**
 * Token 估算与裁剪。
 *
 * 为什么按 token 而不是按字符（development-guide.md §6 第 4 条）：
 * 同一条阈值下，代码大约三个字符一个 token，中文接近一个字符一个 token。
 * 用字符数会同时犯两种错 —— 英文仓库裁得太狠，中文仓库还是爆窗口。
 */

/** CJK / 全角字符大致一字一 token；其余按 ~3.6 字符一 token。 */
const CJK_RANGE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\u3000-\u303F\uAC00-\uD7AF]/

export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) {
    if (CJK_RANGE.test(ch)) cjk += 1
  }
  const rest = text.length - cjk
  return Math.ceil(cjk + rest / 3.6)
}

/** 按字符数硬截（保留行边界友好性，不做单词切分）。 */
export function clipChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars)
}

export interface ClipResult {
  text: string
  truncated: boolean
  /** 被丢弃的字符数，用于给模型一个"丢了多少"的确定信号。 */
  droppedChars: number
}

/**
 * 保留头尾的裁剪（development-guide.md §6 第 5 条）：
 * 文件开头是 import 与类定义，编译错误摘要在末尾，中间最可牺牲。
 *
 * `head` 与 `tail` 是占比，两者之和须 ≤ 1。
 */
export function clipByTokens(
  text: string,
  budgetTokens: number,
  options?: { head?: number; tail?: number; marker?: string },
): ClipResult {
  const head = options?.head ?? 0.6
  const tail = options?.tail ?? 0.4
  const marker = options?.marker ?? "\n…<truncated>…\n"

  const total = estimateTokens(text)
  if (total <= budgetTokens) {
    return { text, truncated: false, droppedChars: 0 }
  }
  if (budgetTokens <= 0) {
    return { text: "", truncated: true, droppedChars: text.length }
  }

  const markerTokens = estimateTokens(marker)
  const usable = Math.max(0, budgetTokens - markerTokens)
  const headTokens = Math.floor(usable * head)
  const tailTokens = Math.max(0, Math.floor(usable * tail))

  // 二分找到"不超过预算的最长前缀/后缀"，比线性扫描更稳。
  const headChars = charsForTokens(text, headTokens, "head")
  const tailChars = charsForTokens(text, tailTokens, "tail")

  const headPart = text.slice(0, headChars)
  const tailPart = tailChars > 0 ? text.slice(text.length - tailChars) : ""
  const out = tailPart ? `${headPart}${marker}${tailPart}` : headPart
  return {
    text: out,
    truncated: true,
    droppedChars: Math.max(0, text.length - headChars - tailChars),
  }
}

/** 估算在给定 token 预算内可以取多少字符。 */
function charsForTokens(text: string, budget: number, side: "head" | "tail"): number {
  if (budget <= 0) return 0
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const sample = side === "head" ? text.slice(0, mid) : text.slice(text.length - mid)
    if (estimateTokens(sample) <= budget) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * 按行裁剪并保留行号信息，用于 read_file 的分页输出。
 * 返回 [起始行号(1-based), 内容]。
 */
export function clipLines(
  lines: readonly string[],
  offset: number,
  limit: number,
): {
  startLine: number
  endLine: number
  lines: string[]
  omittedBefore: number
  omittedAfter: number
} {
  const start = Math.max(0, offset)
  const end = Math.min(lines.length, start + limit)
  return {
    startLine: start + 1,
    endLine: end,
    lines: lines.slice(start, end),
    omittedBefore: start,
    omittedAfter: Math.max(0, lines.length - end),
  }
}
