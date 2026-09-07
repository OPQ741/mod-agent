/**
 * 编辑类内置工具（code-editing.md §2 / §2.1）。
 *
 * 默认档是 **search-and-replace**，原因见 code-editing.md §2.2：行号编辑会被插入位移
 * 打乱，AST 编辑在语法坏掉的文件上直接报错（而那恰恰是最需要编辑的文件），
 * unified diff 对格式极敏感，整文件重写在大文件上既费 token 又容易漏掉未要求改的代码。
 *
 * search-and-replace 最被低估的优势是**幻觉安全**：模型给出文件中不存在的字符串会
 * 直接失败，逼着它重读纠正；而整文件重写会把错误内容静默写进去。
 */

import { promises as fs } from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { AgentTool, ToolExecutionContext } from "../../shared/contracts.js"
import { AppError } from "../../shared/errors.js"
import type { PathGuard } from "../../policy/pathguard.js"
import { validateStructuredFile } from "../../patch/edit.js"
import { diffText } from "../../patch/diff.js"

const AbsolutePath = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), {
    message: "path must be an absolute path (relative paths are never accepted)",
  })

export interface EditToolDeps {
  pathGuard: PathGuard
  /** 记录本次改动，供最终 diff 与 file.changed 事件使用。 */
  onFileChanged?: (absolutePath: string, before: string, after: string) => void
}

/* ------------------------------------------------------------------ *
 * repo.edit_file
 * ------------------------------------------------------------------ */

const EditFileInput = z.object({
  path: AbsolutePath,
  oldString: z.string().min(1, "oldString must not be empty"),
  newString: z.string(),
  /** 显式放开批量替换；默认要求恰好匹配一次。 */
  allowMultiple: z.boolean().default(false),
})
export type EditFileInput = z.infer<typeof EditFileInput>

export function createEditFileTool(deps: EditToolDeps): AgentTool<EditFileInput> {
  return {
    name: "repo.edit_file",
    description:
      "Replace an exact string in an existing file (search-and-replace). The file must have been read with repo.read_file in this session. oldString must match exactly once unless allowMultiple is true — this is the primary guard against hallucinated edits.",
    inputSchema: EditFileInput,
    risk: "workspace_write",
    idempotency: "keyed",
    timeoutMs: 15_000,
    isReadOnly: false,
    isConcurrencySafe: () => false,
    policyPaths: (input) => [input.path],
    async execute(input, ctx: ToolExecutionContext) {
      const guard = await deps.pathGuard.assertWritable(input.path)
      if (guard.needsApproval) {
        // "看着像数据、实则是代码"的位置：不静默写，抛给策略层走审批
        throw new AppError("TOOL_PERMISSION_DENIED", guard.reason ?? "Path requires approval")
      }

      const outcome = await ctx.editEngine.replace({
        path: guard.path,
        oldString: input.oldString,
        newString: input.newString,
        allowMultiple: input.allowMultiple,
      })

      // 结构化配置保护：改完必须仍是合法 JSON
      const structured = validateStructuredFile(outcome.path, outcome.content)
      if (!structured.ok) {
        throw new AppError("PATCH_CONFLICT", `${structured.error} The file was NOT written.`)
      }

      const before = await fs.readFile(outcome.path, "utf8").catch(() => "")
      await fs.writeFile(outcome.path, outcome.content, "utf8")
      await ctx.editEngine.recordWrite(outcome.path, outcome.content)
      ctx.trackWrite(outcome.path)
      deps.onFileChanged?.(outcome.path, before, outcome.content)

      const diff = diffText(before, outcome.content, outcome.path)
      return {
        path: outcome.path,
        matches: outcome.matches,
        additions: diff.additions,
        deletions: diff.deletions,
        baseHash: outcome.baseHash,
        newHash: outcome.newHash,
        note: `Edited ${outcome.path} (+${diff.additions}/-${diff.deletions}).`,
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 * repo.write_file
 * ------------------------------------------------------------------ */

const WriteFileInput = z.object({
  path: AbsolutePath,
  content: z.string(),
  /** 覆盖已有文件时必须为 true（防止误覆盖）。 */
  overwrite: z.boolean().default(false),
  /** 大文件整写上限（字节）。 */
  maxBytes: z.number().int().positive().max(2_000_000).default(64_000),
})
export type WriteFileInput = z.infer<typeof WriteFileInput>

export function createWriteFileTool(deps: EditToolDeps): AgentTool<WriteFileInput> {
  return {
    name: "repo.write_file",
    description:
      "Create a new file, or fully rewrite a small existing one. For existing files larger than maxBytes, use repo.edit_file instead — wholesale rewrites of large files risk dropping code you did not intend to change.",
    inputSchema: WriteFileInput,
    risk: "workspace_write",
    idempotency: "keyed",
    timeoutMs: 15_000,
    isReadOnly: false,
    isConcurrencySafe: () => false,
    policyPaths: (input) => [input.path],
    validate(input) {
      if (input.content.length > input.maxBytes) {
        throw new AppError(
          "FILE_TOO_LARGE",
          `Content is ${input.content.length} bytes, over maxBytes=${input.maxBytes}. Use repo.edit_file for incremental changes.`,
        )
      }
    },
    async execute(input, ctx: ToolExecutionContext) {
      const guard = await deps.pathGuard.assertWritable(input.path)
      if (guard.needsApproval) {
        throw new AppError("TOOL_PERMISSION_DENIED", guard.reason ?? "Path requires approval")
      }

      const exists = await fileExists(guard.path)
      if (exists && !input.overwrite) {
        throw new AppError(
          "PATCH_CONFLICT",
          `${guard.path} already exists. Pass overwrite:true to replace it, or use repo.edit_file for a targeted change.`,
        )
      }

      const structured = validateStructuredFile(guard.path, input.content)
      if (!structured.ok) {
        throw new AppError("PATCH_CONFLICT", `${structured.error} The file was NOT written.`)
      }

      const before = exists ? await fs.readFile(guard.path, "utf8").catch(() => "") : ""
      /**
       * 走 `EditEngine.writeWhole` 而不是直接 `fs.writeFile`。
       *
       * 它对已存在的文件强制 read-before-edit 与 mtime 一致性校验，并拒绝整写超过
       * maxBytes 的大文件。直接写会同时绕过这三道护栏，让"覆盖一个模型从没读过、
       * 且期间被别人改过"的文件变成静默发生的破坏 —— 而 overwrite:true 正是
       * 最容易被模型顺手用上的那条路径。
       */
      const outcome = await ctx.editEngine.writeWhole(guard.path, input.content, {
        maxBytes: input.maxBytes,
      })
      await fs.mkdir(path.dirname(guard.path), { recursive: true })
      await fs.writeFile(guard.path, outcome.content, "utf8")
      await ctx.editEngine.recordWrite(guard.path, outcome.content)
      ctx.trackWrite(guard.path)
      deps.onFileChanged?.(guard.path, before, input.content)

      const diff = diffText(before, input.content, guard.path)
      return {
        path: guard.path,
        created: !exists,
        additions: diff.additions,
        deletions: diff.deletions,
        note: exists
          ? `Rewrote ${guard.path} (+${diff.additions}/-${diff.deletions}).`
          : `Created ${guard.path} (${diff.additions} lines).`,
      }
    },
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
