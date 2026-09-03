/**
 * Unified diff 生成（code-editing.md §5）。
 *
 * 交付物必须包含：文件列表、逐文件 diff、增删行统计。这里产出可人读的
 * unified diff 与机器可用的 hunk 结构。
 */

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: Array<{ type: "context" | "add" | "remove"; text: string }>
}

export interface FileDiff {
  path: string
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

export interface DiffSummary {
  files: FileDiff[]
  totalAdditions: number
  totalDeletions: number
  /** 变更文件数，供"计划改一个组件却动了几十个文件"的范围保护判断。 */
  fileCount: number
}

/** 生成两个文本内容之间的 unified diff。 */
export function diffText(
  beforeText: string,
  afterText: string,
  filePath: string,
  context = 3,
): FileDiff {
  const before = beforeText.split("\n")
  const after = afterText.split("\n")
  const ops = lcsDiff(before, after)
  const hunks = buildHunks(before, after, ops, context)
  let additions = 0
  let deletions = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") additions += 1
      else if (line.type === "remove") deletions += 1
    }
  }
  return { path: filePath, hunks, additions, deletions }
}

export function summarize(diffs: readonly FileDiff[]): DiffSummary {
  return {
    files: [...diffs],
    totalAdditions: diffs.reduce((sum, d) => sum + d.additions, 0),
    totalDeletions: diffs.reduce((sum, d) => sum + d.deletions, 0),
    fileCount: diffs.length,
  }
}

/** 渲染成标准 unified diff 文本。 */
export function formatUnifiedDiff(
  diff: FileDiff,
  options?: { beforeLabel?: string; afterLabel?: string },
): string {
  if (diff.hunks.length === 0) return ""
  const beforeLabel = options?.beforeLabel ?? `a/${diff.path}`
  const afterLabel = options?.afterLabel ?? `b/${diff.path}`
  const lines: string[] = [`--- ${beforeLabel}`, `+++ ${afterLabel}`]
  for (const hunk of diff.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) {
      const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " "
      lines.push(`${prefix}${line.text}`)
    }
  }
  return `${lines.join("\n")}\n`
}

export function formatAll(diffs: readonly FileDiff[]): string {
  return diffs.map((d) => formatUnifiedDiff(d)).join("")
}

/* ------------------------------------------------------------------ *
 * LCS diff
 * ------------------------------------------------------------------ */

type Op =
  | { type: "equal"; a: number; b: number }
  | { type: "remove"; a: number }
  | { type: "add"; b: number }

/**
 * 经典 LCS 动态规划。对超大文件（>4000 行）退化为"整段替换"，
 * 避免 O(n²) 内存把进程打爆 —— diff 的正确性由 hunk 表达，不靠逐行最优。
 */
export function lcsDiff(before: readonly string[], after: readonly string[]): Op[] {
  const n = before.length
  const m = after.length
  if (n * m > 16_000_000) {
    return [
      ...before.map((_, index): Op => ({ type: "remove", a: index })),
      ...after.map((_, index): Op => ({ type: "add", b: index })),
    ]
  }

  // dp 用 Uint32Array 压内存
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        before[i] === after[j]
          ? (dp[(i + 1) * width + (j + 1)] ?? 0) + 1
          : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + (j + 1)] ?? 0)
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ type: "equal", a: i, b: j })
      i += 1
      j += 1
    } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + (j + 1)] ?? 0)) {
      ops.push({ type: "remove", a: i })
      i += 1
    } else {
      ops.push({ type: "add", b: j })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ type: "remove", a: i })
    i += 1
  }
  while (j < m) {
    ops.push({ type: "add", b: j })
    j += 1
  }
  return ops
}

function buildHunks(
  before: readonly string[],
  after: readonly string[],
  ops: readonly Op[],
  context: number,
): DiffHunk[] {
  const changed: boolean[] = new Array(ops.length).fill(false)
  ops.forEach((op, index) => {
    if (op.type !== "equal") changed[index] = true
  })

  const hunks: DiffHunk[] = []
  let index = 0
  while (index < ops.length) {
    if (!changed[index]) {
      index += 1
      continue
    }
    const start = Math.max(0, index - context)
    let end = index
    while (end < ops.length && (changed[end] || end - index < context)) {
      end += 1
      if (end < ops.length && changed[end]) index = end
    }
    // 向后补齐 context
    let extended = end
    let trailing = 0
    while (extended < ops.length && trailing < context) {
      extended += 1
      trailing += 1
    }
    const slice = ops.slice(start, Math.min(ops.length, extended))

    const lines: DiffHunk["lines"] = []
    let oldStart = 0
    let newStart = 0
    let oldCount = 0
    let newCount = 0
    let first = true

    for (const op of slice) {
      if (op.type === "equal") {
        if (first) {
          oldStart = op.a + 1
          newStart = op.b + 1
          first = false
        }
        lines.push({ type: "context", text: before[op.a] ?? "" })
        oldCount += 1
        newCount += 1
      } else if (op.type === "remove") {
        if (first) {
          oldStart = op.a + 1
          newStart = op.a + 1
          first = false
        }
        lines.push({ type: "remove", text: before[op.a] ?? "" })
        oldCount += 1
      } else {
        if (first) {
          oldStart = op.b + 1
          newStart = op.b + 1
          first = false
        }
        lines.push({ type: "add", text: after[op.b] ?? "" })
        newCount += 1
      }
    }

    hunks.push({
      oldStart: oldStart || 1,
      oldLines: oldCount,
      newStart: newStart || 1,
      newLines: newCount,
      lines,
    })
    index = Math.max(index + 1, Math.min(ops.length, extended))
  }
  return hunks
}
