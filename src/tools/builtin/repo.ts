/**
 * 仓库类内置工具（tools-and-extensions.md §1 / context-engineering.md §1.1）。
 *
 * ACI 纪律（SWE-agent 实证，直接决定模型表现）：
 * - **强制绝对路径**：Anthropic 实测改成强制绝对路径后，模型再没犯过相对路径错误；
 * - **文件查看器每轮只显示有限行**，带行号与省略标记，告知上下各省略了多少行；
 * - **全目录搜索只列文件名与命中计数**，给更多上下文反而让模型困惑；结果超阈值
 *   就要求收窄查询，而不是硬塞；
 * - **空输出也要有固定说法**，沉默是歧义的。
 */

import { promises as fs } from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { AgentTool, ToolExecutionContext } from "../../shared/contracts.js"
import { AppError } from "../../shared/errors.js"
import { contentHash } from "../../shared/hash.js"
import { clipLines, estimateTokens } from "../../shared/tokens.js"
import { EMPTY_OUTPUT_NOTICE, withEmptyNotice } from "../executor.js"
import type { PathGuard } from "../../policy/pathguard.js"

/** 跨平台绝对路径校验（Windows 是 `C:\...`，POSIX 是 `/...`）。 */
const AbsolutePath = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), {
    message: "path must be an absolute path (relative paths are never accepted)",
  })

export interface RepoToolContext {
  pathGuard: PathGuard
  /** 排除目录。 */
  excludeDirs: readonly string[]
}

/* ------------------------------------------------------------------ *
 * repo.list_files
 * ------------------------------------------------------------------ */

const ListFilesInput = z.object({
  path: AbsolutePath,
  /** 递归深度上限，防止大仓库把上下文撑爆。 */
  maxDepth: z.number().int().min(1).max(10).default(3),
  /** glob 后缀过滤，如 ".ts"。 */
  extension: z.string().optional(),
  limit: z.number().int().positive().max(500).default(200),
})
export type ListFilesInput = z.infer<typeof ListFilesInput>

export function createListFilesTool(deps: RepoToolContext): AgentTool<ListFilesInput> {
  return {
    name: "repo.list_files",
    description:
      "List files under an absolute directory inside the authorized workspace. Returns relative paths and sizes only — no file contents. Use repo.read_file to read a specific file.",
    inputSchema: ListFilesInput,
    risk: "read",
    idempotency: "safe",
    timeoutMs: 10_000,
    isReadOnly: true,
    isConcurrencySafe: () => true,
    policyPaths: (input) => [input.path],
    async execute(input, _ctx: ToolExecutionContext) {
      const root = await deps.pathGuard.assertReadable(input.path)
      const entries = await walk(root, input.maxDepth, deps.excludeDirs)
      const filtered = entries
        .filter((entry) =>
          input.extension ? entry.rel.toLowerCase().endsWith(input.extension.toLowerCase()) : true,
        )
        .slice(0, input.limit)

      if (filtered.length === 0) return { root, files: [], note: EMPTY_OUTPUT_NOTICE }
      return {
        root,
        returned: filtered.length,
        truncated: entries.length > filtered.length,
        totalFound: entries.length,
        files: filtered.map((entry) => ({ path: entry.rel, bytes: entry.bytes })),
        ...(entries.length > filtered.length
          ? {
              hint: `Showing ${filtered.length} of ${entries.length}. Narrow the directory or add an extension filter.`,
            }
          : {}),
      }
    },
  }
}

interface WalkEntry {
  rel: string
  bytes: number
}

async function walk(
  root: string,
  maxDepth: number,
  excludeDirs: readonly string[],
): Promise<WalkEntry[]> {
  const out: WalkEntry[] = []
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    if (current.depth > maxDepth) continue
    let dirents
    try {
      dirents = await fs.readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      const full = path.join(current.dir, dirent.name)
      const rel = path.relative(root, full).split(path.sep).join("/")
      if (dirent.isDirectory()) {
        if (excludeDirs.includes(dirent.name)) continue
        stack.push({ dir: full, depth: current.depth + 1 })
        continue
      }
      if (!dirent.isFile()) continue
      try {
        const stat = await fs.stat(full)
        out.push({ rel, bytes: stat.size })
      } catch {
        out.push({ rel, bytes: 0 })
      }
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/* ------------------------------------------------------------------ *
 * repo.read_file
 * ------------------------------------------------------------------ */

const ReadFileInput = z.object({
  path: AbsolutePath,
  /** 起始行（1-based）。 */
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(2_000).default(200),
  /** 显式覆盖 256KB 硬顶（Claude Code 的 allow_large 语义）。 */
  allowLarge: z.boolean().default(false),
})
export type ReadFileInput = z.infer<typeof ReadFileInput>

export function createReadFileTool(
  deps: RepoToolContext,
  limits: { maxBytes: number; maxOutputTokens: number },
): AgentTool<ReadFileInput> {
  return {
    name: "repo.read_file",
    description:
      "Read a text file inside the authorized workspace. Requires an absolute path. Returns numbered lines with a pagination window; use offset/limit to page through large files.",
    inputSchema: ReadFileInput,
    risk: "read",
    idempotency: "safe",
    timeoutMs: 10_000,
    isReadOnly: true,
    isConcurrencySafe: () => true,
    policyPaths: (input) => [input.path],
    async execute(input, ctx: ToolExecutionContext) {
      const resolved = await deps.pathGuard.assertReadable(input.path)

      let stat
      try {
        stat = await fs.stat(resolved)
      } catch {
        throw new AppError("TOOL_FAILED", `File not found or not readable: ${resolved}`)
      }
      if (stat.isDirectory()) {
        throw new AppError(
          "TOOL_FAILED",
          `${resolved} is a directory. Use repo.list_files instead.`,
        )
      }

      const maxBytes = limits.maxBytes
      if (stat.size > maxBytes && !input.allowLarge) {
        throw new AppError(
          "FILE_TOO_LARGE",
          `File is ${stat.size} bytes, over the ${maxBytes} byte limit. ` +
            "Pass allowLarge:true to read it anyway, or use offset+limit to read a slice.",
        )
      }

      const raw = await fs.readFile(resolved)
      if (looksBinaryBuffer(raw)) {
        throw new AppError(
          "TOOL_FAILED",
          `${resolved} looks like a binary file (${stat.size} bytes). Binary files are never sent to the model.`,
        )
      }

      const content = raw.toString("utf8")
      /**
       * 只记到 `ctx`：它是**当前任务**的编辑会话。
       *
       * 这里曾经还写一份 runtime 级的已读表，于是已读记录跨任务共享 ——
       * 任务 B 没读过的文件，只要任务 A 读过就能直接改。
       */
      ctx.trackRead(resolved, stat.mtimeMs, content)

      const lines = content.split("\n")
      const window = clipLines(lines, input.offset, input.limit)
      const rendered = window.lines
        .map((line, index) => `${String(window.startLine + index).padStart(6)} | ${line}`)
        .join("\n")

      let text = rendered
      let truncated = window.omittedAfter > 0 || window.omittedBefore > 0
      if (estimateTokens(text) > limits.maxOutputTokens) {
        // 窗口本身也超预算：按 token 再裁一次
        const keep = Math.max(10, Math.floor(input.limit / 2))
        const smaller = clipLines(lines, input.offset, keep)
        text = smaller.lines
          .map((line, index) => `${String(smaller.startLine + index).padStart(6)} | ${line}`)
          .join("\n")
        truncated = true
      }

      return {
        path: resolved,
        bytes: stat.size,
        sha256: contentHash(content),
        totalLines: lines.length,
        startLine: window.startLine,
        endLine: window.endLine,
        omittedBefore: window.omittedBefore,
        omittedAfter: window.omittedAfter,
        truncated,
        content: withEmptyNotice(text),
        ...(window.omittedAfter > 0
          ? {
              hint: `${window.omittedAfter} more lines below. Use offset=${window.endLine} to continue.`,
            }
          : {}),
      }
    },
  }
}

function looksBinaryBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  for (const byte of sample) {
    if (byte === 0) return true
  }
  return false
}

/* ------------------------------------------------------------------ *
 * repo.search_text
 * ------------------------------------------------------------------ */

const SearchTextInput = z.object({
  pattern: z.string().min(1),
  path: AbsolutePath.optional(),
  /** 文件名后缀过滤。 */
  extension: z.string().optional(),
  /** 是否返回匹配行内容。默认只给文件与命中计数（ACI 纪律）。 */
  withLines: z.boolean().default(false),
  maxResults: z.number().int().positive().max(500).default(50),
  caseSensitive: z.boolean().default(true),
})
export type SearchTextInput = z.infer<typeof SearchTextInput>

export function createSearchTextTool(deps: RepoToolContext): AgentTool<SearchTextInput> {
  return {
    name: "repo.search_text",
    description:
      "Search for a literal string or regex inside the authorized workspace. By default returns only file paths with hit counts; pass withLines:true to see matching lines. Results are capped — narrow the pattern rather than paging.",
    inputSchema: SearchTextInput,
    risk: "read",
    idempotency: "safe",
    timeoutMs: 30_000,
    isReadOnly: true,
    isConcurrencySafe: () => true,
    policyPaths: (input) => (input.path ? [input.path] : [deps.pathGuard.root]),
    async execute(input, ctx: ToolExecutionContext) {
      const root = input.path
        ? await deps.pathGuard.assertReadable(input.path)
        : deps.pathGuard.root

      let regex: RegExp
      try {
        regex = new RegExp(input.pattern, input.caseSensitive ? "g" : "gi")
      } catch (err) {
        throw new AppError("INVALID_INPUT", `Invalid search pattern: ${String(err)}`)
      }

      const files = await walk(root, 8, deps.excludeDirs)
      const hits: Array<{ file: string; count: number; lines: string[] }> = []
      const cap = Math.min(input.maxResults, 50)

      for (const entry of files) {
        if (input.extension && !entry.rel.toLowerCase().endsWith(input.extension.toLowerCase()))
          continue
        if (entry.bytes > 2 * 1024 * 1024) continue
        if (hits.length >= cap) break

        const full = path.join(root, entry.rel)
        let content: string
        try {
          content = await fs.readFile(full, "utf8")
        } catch {
          continue
        }
        const lines = content.split("\n")
        const matchedLines: string[] = []
        let count = 0
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]
          if (line === undefined) continue
          regex.lastIndex = 0
          if (!regex.test(line)) continue
          count += 1
          if (input.withLines && matchedLines.length < 20) {
            matchedLines.push(`${index + 1}: ${line.trim().slice(0, 200)}`)
          }
        }
        if (count > 0) hits.push({ file: entry.rel, count, lines: matchedLines })
      }

      if (hits.length === 0) {
        return { root, pattern: input.pattern, hits: [], note: "No matches found." }
      }
      if (hits.length >= cap) {
        return {
          root,
          pattern: input.pattern,
          capped: true,
          hits: [],
          note:
            `Found at least ${cap} matching files. Results withheld — narrow the pattern, ` +
            "add an extension filter, or scope the search to a subdirectory.",
        }
      }
      return {
        root,
        pattern: input.pattern,
        matchedFiles: hits.length,
        totalMatches: hits.reduce((sum, h) => sum + h.count, 0),
        hits,
        ...(ctx.budgetTokens < 1_000
          ? { note: "Context budget is tight; only counts returned." }
          : {}),
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 * repo.git_status / repo.read_diff
 * ------------------------------------------------------------------ */

const GitStatusInput = z.object({
  path: AbsolutePath,
})
export type GitStatusInput = z.infer<typeof GitStatusInput>

export function createGitStatusTool(deps: RepoToolContext): AgentTool<GitStatusInput> {
  return {
    name: "repo.git_status",
    description:
      "Show the working tree state of a git repository inside the authorized workspace (branch, staged/unstaged changes, untracked files). Read-only.",
    inputSchema: GitStatusInput,
    risk: "read",
    idempotency: "safe",
    timeoutMs: 15_000,
    isReadOnly: true,
    isConcurrencySafe: () => true,
    policyPaths: (input) => [input.path],
    async execute(input, ctx: ToolExecutionContext) {
      const resolved = await deps.pathGuard.assertReadable(input.path)
      const result = await ctx.runCommand({
        executable: "git",
        args: ["status", "--porcelain=v1", "--branch"],
        cwd: resolved,
        timeoutMs: 10_000,
        reason: "Inspect working tree state before editing",
      })
      if (result.exitCode !== 0) {
        throw new AppError(
          "COMMAND_EXIT_NONZERO",
          `git status failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
        )
      }
      const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0)
      const branchLine = lines.find((l) => l.startsWith("## "))
      const changes = lines.filter((l) => !l.startsWith("## "))
      return {
        cwd: resolved,
        branch: branchLine?.replace(/^## /, "") ?? "unknown",
        dirty: changes.length > 0,
        changeCount: changes.length,
        changes: changes.slice(0, 100),
        note: changes.length === 0 ? "Working tree clean." : undefined,
      }
    },
  }
}

const ReadDiffInput = z.object({
  path: AbsolutePath,
  /** 只显示这些路径的 diff。 */
  files: z.array(AbsolutePath).optional(),
  /** 是否包含未提交的暂存改动。 */
  staged: z.boolean().default(false),
})
export type ReadDiffInput = z.infer<typeof ReadDiffInput>

export function createReadDiffTool(deps: RepoToolContext): AgentTool<ReadDiffInput> {
  return {
    name: "repo.read_diff",
    description:
      "Read the current unified diff of a git repository inside the authorized workspace. Use it to review what has changed before delivering. Read-only.",
    inputSchema: ReadDiffInput,
    risk: "read",
    idempotency: "safe",
    timeoutMs: 15_000,
    isReadOnly: true,
    isConcurrencySafe: () => true,
    policyPaths: (input) => [input.path, ...(input.files ?? [])],
    async execute(input, ctx: ToolExecutionContext) {
      const resolved = await deps.pathGuard.assertReadable(input.path)
      const args = ["diff", "--no-color", "--stat=200"]
      if (input.staged) args.push("--cached")
      if (input.files && input.files.length > 0)
        args.push("--", ...input.files.map((f) => path.relative(resolved, f)))

      const statResult = await ctx.runCommand({
        executable: "git",
        args,
        cwd: resolved,
        timeoutMs: 10_000,
        reason: "Review the diff before delivery",
      })
      if (statResult.exitCode !== 0) {
        throw new AppError(
          "COMMAND_EXIT_NONZERO",
          `git diff failed (exit ${statResult.exitCode}): ${statResult.stderr || statResult.stdout}`,
        )
      }

      const fullArgs = ["diff", "--no-color", "--unified=3"]
      if (input.staged) fullArgs.push("--cached")
      if (input.files && input.files.length > 0) {
        fullArgs.push("--", ...input.files.map((f) => path.relative(resolved, f)))
      }
      const fullResult = await ctx.runCommand({
        executable: "git",
        args: fullArgs,
        cwd: resolved,
        timeoutMs: 10_000,
        reason: "Review the diff before delivery",
      })

      return {
        cwd: resolved,
        stat: withEmptyNotice(statResult.stdout),
        diff: fullResult.stdout,
        truncated: fullResult.truncated,
        empty: fullResult.stdout.trim().length === 0,
      }
    },
  }
}
