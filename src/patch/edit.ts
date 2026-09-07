/**
 * 编辑引擎（code-editing.md §2.1）。
 *
 * 五条必须由**代码层强制执行**的护栏，一条都不能只写进系统提示词：
 *
 * 1. **read-before-edit**：对已存在的文件执行 edit / write 前，若它不在已读表里直接拒绝。
 *    这保证模型基于文件当前内容、而非想象中的内容来改；
 * 2. **mtime 外部修改检测**：读时记 mtime，写前再取一次。不一致说明用户或别的进程改过，
 *    返回警告要求重读，**绝不静默覆盖**；
 * 3. **唯一匹配是底线**：0 次 = 模型记忆有误（幻觉检测），>1 次 = 上下文不足。
 *    两种情况都宁可失败也不猜测；
 * 4. **替换用 split/join，不用 String.replace**：后者对 `$&`、`$1` 有特殊替换语义，
 *    会让 `new_string` 里的 `$` 被吃掉；
 * 5. **引号容错**：LLM 的 token 化会把直引号映射成弯引号，匹配前先规范化再比对，
 *    但命中后要写回文件里的**原始**字符串，保留文件原有字符风格。
 *
 * 校验顺序按 I/O 成本从低到高：内存状态 → 读盘匹配 → 写盘。尽量早失败、少做无用 I/O。
 */

import { promises as fs } from "node:fs"
import path from "node:path"
import { AppError } from "../shared/errors.js"
import { contentHash } from "../shared/hash.js"
import type { EditSession } from "../shared/contracts.js"

export interface ReadRecord {
  mtimeMs: number
  /** 读取时的内容 hash，用于 patch 的基准校验。 */
  hash: string
  readAt: number
}

export interface ReplaceEditInput {
  path: string
  oldString: string
  newString: string
  /** 默认 false：匹配多于一次直接失败，不静默批量替换。 */
  allowMultiple?: boolean
  /** 期望匹配次数，默认 1。 */
  expectedMatches?: number
}

export interface EditOutcome {
  path: string
  /** 应用后的完整内容。 */
  content: string
  /** 编辑前的 hash（基准）。 */
  baseHash: string
  /** 编辑后的 hash。 */
  newHash: string
  matches: number
  additions: number
  deletions: number
}

/**
 * 排版字符 → ASCII。
 *
 * **每一条替换都必须保持长度不变（1 字符 → 1 字符）**。
 * `findOccurrences` 用规范化后的下标去切**原始**字符串，一旦某个替换把 1 个字符
 * 变成 2 个（例如把 `—` 映射成 `--`），它之后的所有下标都会整体偏移，
 * 替换就会落在错误的位置上 —— 表现为文件被静默改坏、工具却返回成功。
 * 中文文档里 `——` 极常见，这条曾经把 `TODO: fix me` 改成 `TODO: fifixed`。
 *
 * 因此破折号统一映射成单个 `-`：`——` ↔ `--` 的互认仍然成立（两侧各映射一次）。
 */
const CURLY_TO_STRAIGHT: ReadonlyArray<[RegExp, string]> = [
  [/[‘’‛]/gu, "'"],
  [/[“”‟]/gu, '"'],
  [/[–—]/gu, "-"],
  [/\u00a0/gu, " "],
]

/** 把弯引号等排版字符规范化为 ASCII，仅用于**匹配**，不用于写入。 */
export function normalizeForMatch(text: string): string {
  let out = text
  for (const [pattern, replacement] of CURLY_TO_STRAIGHT) {
    out = out.replace(pattern, replacement)
  }
  if (out.length !== text.length) {
    // 长度变了就说明有替换破坏了下标对齐；宁可直接失败，也不要在错的位置写文件。
    throw new AppError(
      "EDIT_NOT_UNIQUE",
      "Internal invariant broken: text normalization changed the string length, " +
        "so match offsets can no longer be mapped back to the original file. Refusing to edit.",
    )
  }
  return out
}

/** 在规范化后的文本里统计 `needle` 出现次数。 */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let index = 0
  for (;;) {
    const found = haystack.indexOf(needle, index)
    if (found === -1) break
    count += 1
    index = found + needle.length
  }
  return count
}

/**
 * 返回 `needle` 在 `haystack` 中的出现位置（规范化比对），
 * 返回的下标可用于**原始** haystack 的切片。
 */
export function findOccurrences(haystack: string, needle: string): number[] {
  if (needle.length === 0) return []
  const normalizedHay = normalizeForMatch(haystack)
  const normalizedNeedle = normalizeForMatch(needle)
  const positions: number[] = []
  let index = 0
  for (;;) {
    const found = normalizedHay.indexOf(normalizedNeedle, index)
    if (found === -1) break
    positions.push(found)
    index = found + normalizedNeedle.length
  }
  return positions
}

/**
 * 用 split/join 做替换（不用 String.replace，避免 `$&` / `$1` 陷阱）。
 * 传入的是**原始**文本与出现位置，因此写回的内容保留文件原有字符风格。
 */
export function replaceAtPositions(
  original: string,
  positions: readonly number[],
  oldLength: number,
  newString: string,
): string {
  if (positions.length === 0) return original
  let out = ""
  let cursor = 0
  for (const position of positions) {
    out += original.slice(cursor, position)
    out += newString
    cursor = position + oldLength
  }
  out += original.slice(cursor)
  return out
}

/**
 * 编辑引擎：**一个任务一套**。
 *
 * 已读表（`readTable`）是 read-before-edit 的唯一依据。它必须是任务级状态：
 * runtime 级共享一份时，任务 A 读过的文件会让任务 B 的"未读即改"通过校验，
 * 护栏在第二个任务上静默失效。装配处见 `AgentRuntime.run()`。
 */
export class EditEngine implements EditSession {
  /** key 为 realpath 后的绝对路径。 */
  private readonly readTable = new Map<string, ReadRecord>()

  /** 记录一次读取（read_file 成功后调用）。 */
  recordRead(absolutePath: string, mtimeMs: number, content: string): void {
    this.readTable.set(path.resolve(absolutePath), {
      mtimeMs,
      hash: contentHash(content),
      readAt: Date.now(),
    })
  }

  /** 写成功后刷新该文件的 mtime 记录（code-editing.md §2.1）。 */
  async recordWrite(absolutePath: string, content: string): Promise<void> {
    const resolved = path.resolve(absolutePath)
    const stat = await fs.stat(resolved)
    this.readTable.set(resolved, {
      mtimeMs: stat.mtimeMs,
      hash: contentHash(content),
      readAt: Date.now(),
    })
  }

  hasRead(absolutePath: string): boolean {
    return this.readTable.has(path.resolve(absolutePath))
  }

  readRecord(absolutePath: string): ReadRecord | undefined {
    return this.readTable.get(path.resolve(absolutePath))
  }

  /** 清空已读表（压缩或会话重置时用）。 */
  reset(): void {
    this.readTable.clear()
  }

  get trackedFiles(): string[] {
    return [...this.readTable.keys()]
  }

  /* ---------------- 编辑 ---------------- */

  /**
   * 精确文本替换（默认档）。
   *
   * 失败路径全部回喂模型的三条确定信息：匹配几次、为什么、下一步该干什么。
   */
  async replace(input: ReplaceEditInput): Promise<EditOutcome> {
    const resolved = path.resolve(input.path)
    const exists = await fileExists(resolved)

    if (!exists) {
      throw new AppError(
        "READ_BEFORE_EDIT",
        `File not found: ${resolved}. Create it with write_file instead of edit_file.`,
      )
    }
    await this.assertReadAndFresh(resolved)

    const before = await fs.readFile(resolved, "utf8")
    const positions = findOccurrences(before, input.oldString)
    const expected = input.expectedMatches ?? 1

    if (positions.length === 0) {
      // 幻觉检测：模型给了一个文件里不存在的字符串
      throw new AppError(
        "EDIT_NOT_FOUND",
        `old_string not found in ${resolved}. Re-read the file — your memory of its content may be stale.`,
        { details: { path: resolved, oldStringPreview: input.oldString.slice(0, 120) } },
      )
    }
    if (positions.length > 1 && !input.allowMultiple && expected === 1) {
      throw new AppError(
        "EDIT_NOT_UNIQUE",
        `old_string matched ${positions.length} times in ${resolved}. ` +
          "Narrow the context (add surrounding lines) or pass allowMultiple:true explicitly.",
        { details: { path: resolved, matches: positions.length } },
      )
    }

    // 规范化保证等长（见 CURLY_TO_STRAIGHT 的注释），所以规范化下标可直接用于原始文本，
    // oldString 的字符数也就是要替换掉的原始字符数。
    const oldLength = input.oldString.length
    const content = replaceAtPositions(before, positions, oldLength, input.newString)

    const { additions, deletions } = countLineDelta(
      input.oldString,
      input.newString,
      positions.length,
    )
    return {
      path: resolved,
      content,
      baseHash: contentHash(before),
      newHash: contentHash(content),
      matches: positions.length,
      additions,
      deletions,
    }
  }

  /**
   * 整文件写入。仅用于新建文件或短小文件；改现有大文件优先补丁化（code-editing.md §2）。
   */
  async writeWhole(
    absolutePath: string,
    content: string,
    options?: { maxBytes?: number },
  ): Promise<EditOutcome> {
    const resolved = path.resolve(absolutePath)
    const exists = await fileExists(resolved)

    if (exists) {
      await this.assertReadAndFresh(resolved)
      const before = await fs.readFile(resolved, "utf8")
      if ((options?.maxBytes ?? 64 * 1024) < before.length) {
        throw new AppError(
          "PATCH_CONFLICT",
          `Refusing to rewrite ${resolved} wholesale (${before.length} bytes). Use edit_file with search/replace instead.`,
        )
      }
      const { additions, deletions } = countLineDelta(before, content, 1)
      return {
        path: resolved,
        content,
        baseHash: contentHash(before),
        newHash: contentHash(content),
        matches: 1,
        additions,
        deletions,
      }
    }

    // 新建文件无需先读
    return {
      path: resolved,
      content,
      baseHash: "",
      newHash: contentHash(content),
      matches: 0,
      additions: countLines(content),
      deletions: 0,
    }
  }

  /** 写盘前的最后一道：read-before-edit + mtime 一致性。 */
  private async assertReadAndFresh(resolved: string): Promise<void> {
    const record = this.readTable.get(resolved)
    if (!record) {
      throw new AppError(
        "READ_BEFORE_EDIT",
        `Please read ${resolved} before editing it. This guarantees the edit is based on current content, not stale memory.`,
      )
    }
    const stat = await fs.stat(resolved)
    if (Math.floor(stat.mtimeMs) !== Math.floor(record.mtimeMs)) {
      throw new AppError(
        "MTIME_CHANGED",
        `${resolved} changed on disk after you read it (mtime ${record.mtimeMs} → ${stat.mtimeMs}). ` +
          "Re-read the file and redo the edit; refusing to overwrite external changes.",
        { details: { path: resolved, expectedMtime: record.mtimeMs, actualMtime: stat.mtimeMs } },
      )
    }
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

export function countLines(text: string): number {
  if (text.length === 0) return 0
  // 末尾换行不计作一行：`"a\n"` 是 1 行而不是 2 行。
  // 不修这个 off-by-one，diff 统计里每次改动都会凭空多出一行增删。
  const withoutTrailingNewline = text.endsWith("\n") ? text.slice(0, -1) : text
  if (withoutTrailingNewline.length === 0) return 1
  return withoutTrailingNewline.split("\n").length
}

function countLineDelta(
  oldString: string,
  newString: string,
  occurrences: number,
): { additions: number; deletions: number } {
  const deletions = countLines(oldString) * occurrences
  const additions = countLines(newString) * occurrences
  return { additions, deletions }
}

/* ------------------------------------------------------------------ *
 * 结构化配置保护（code-editing.md §2.1）
 * ------------------------------------------------------------------ */

/**
 * 对 JSON 类配置文件，编辑后做一次格式校验。
 * 防止一个看起来合理的改动把配置写坏 —— 一个坏配置后面每一步都基于坏现场。
 */
export function validateStructuredFile(
  filePath: string,
  content: string,
): { ok: true } | { ok: false; error: string } {
  const lower = filePath.toLowerCase()
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) {
    // jsonc 允许注释与尾逗号，这里用宽松策略：先剥注释再 JSON.parse
    const stripped = stripJsonComments(content)
    try {
      JSON.parse(stripped)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: `Edited file is not valid JSON: ${String(err)}` }
    }
  }
  return { ok: true }
}

export function stripJsonComments(text: string): string {
  let out = ""
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === undefined) break
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1
      i -= 1
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1
      i += 1
      continue
    }
    out += ch
  }
  return out
}
