/**
 * 规则文件加载（context-engineering.md §2.1 / data-and-events.md §4.1）。
 *
 * 三条语义：
 * 1. **拼接而非覆盖**：从根到当前目录逐级拼接，越靠近被编辑文件的越**靠后**读。
 *    模型最后读到的印象最深，就近优先级由此而来。
 * 2. **AGENTS.md 是第一公民**（开放标准，6 万+ 项目采用，Linux 基金会托管），
 *    不自创私有文件；CLAUDE.md 作为兼容读取。
 * 3. `@import` 递归深度硬上限 4 —— 防止循环引用把上下文吃光。
 */

import { promises as fs } from "node:fs"
import path from "node:path"
import { contentHash } from "../shared/hash.js"
import { stripInvisibleCharacters } from "../shared/sanitize.js"

export const RULE_FILE_NAMES: ReadonlyArray<string> = ["AGENTS.md", "CLAUDE.md"]
const MAX_IMPORT_DEPTH = 4

export interface LoadedRuleFile {
  path: string
  sha256: string
  /** 距离工作区根的层级，越大越靠近被编辑文件（拼接时排在后面）。 */
  depth: number
  content: string
}

export interface RulesBundle {
  files: LoadedRuleFile[]
  /** 按顺序拼接后的正文（根在前，就近在后）。 */
  combined: string
}

/**
 * 从工作区根到目标目录收集规则文件。
 *
 * 返回顺序：**根在前、就近在后**。这条顺序是就近覆盖语义的实现方式，
 * 不是"近处覆盖远处"的覆盖逻辑 —— 全部内容都会进入上下文。
 */
export async function collectRuleFiles(
  workspaceRoot: string,
  targetDir: string = workspaceRoot,
): Promise<LoadedRuleFile[]> {
  const root = path.resolve(workspaceRoot)
  const target = path.resolve(targetDir)
  const relative = path.relative(root, target)
  if (relative.startsWith("..")) {
    throw new Error(`Target ${target} is outside workspace root ${root}`)
  }

  const segments = relative.length === 0 ? [] : relative.split(path.sep)
  const dirs: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  let current = root
  segments.forEach((segment, index) => {
    current = path.join(current, segment)
    dirs.push({ dir: current, depth: index + 1 })
  })

  const found: LoadedRuleFile[] = []
  for (const { dir, depth } of dirs) {
    for (const name of RULE_FILE_NAMES) {
      const candidate = path.join(dir, name)
      const content = await readIfFile(candidate)
      if (content === undefined) continue
      const cleaned = stripInvisibleCharacters(content)
      found.push({
        path: candidate,
        sha256: contentHash(cleaned.text),
        depth,
        content: cleaned.text,
      })
      // 同一目录里 AGENTS.md 优先，找到就不再读 CLAUDE.md
      break
    }
  }
  return found.sort((a, b) => a.depth - b.depth)
}

export async function bundleRules(workspaceRoot: string, targetDir?: string): Promise<RulesBundle> {
  const files = await collectRuleFiles(workspaceRoot, targetDir)
  // 展开 @import：规则文件常常拆成"根 AGENTS.md + 若干共享片段"，
  // 不展开的话模型只看到一行 `@import ./shared.md`，共享约定等于没加载。
  const expanded: LoadedRuleFile[] = []
  for (const file of files) {
    expanded.push({ ...file, content: await expandImports(file.content, file.path) })
  }
  const combined = expanded
    .map(
      (file) => `<project-rules source="${file.path}">\n${file.content.trim()}\n</project-rules>`,
    )
    .join("\n\n")
  return { files: expanded, combined }
}

/**
 * 展开 `@path` 导入（`context-engineering.md §2.1` 第 5 条，最多 4 跳）。
 * 路径相对**含 import 的那份文件**解析，不是 cwd。
 */
export async function expandImports(
  content: string,
  containingFile: string,
  depth = 0,
  visited: ReadonlySet<string> = new Set(),
): Promise<string> {
  if (depth >= MAX_IMPORT_DEPTH) {
    return `${content}\n\n<!-- import depth limit (${MAX_IMPORT_DEPTH}) reached -->`
  }
  const lines = content.split("\n")
  const out: string[] = []
  const containingDir = path.dirname(containingFile)
  const seen = new Set(visited)

  for (const line of lines) {
    const match = /^@import\s+(\S+)\s*$/.exec(line.trim())
    if (!match?.[1]) {
      out.push(line)
      continue
    }
    const rawTarget = match[1].replace(/\\(?=\s)/g, " ")
    const target = path.resolve(containingDir, rawTarget)
    if (seen.has(target)) {
      out.push(`<!-- circular import skipped: ${rawTarget} -->`)
      continue
    }
    seen.add(target)
    const imported = await readIfFile(target)
    if (imported === undefined) {
      out.push(`<!-- import not found: ${rawTarget} -->`)
      continue
    }
    out.push(await expandImports(imported, target, depth + 1, seen))
  }
  return out.join("\n")
}

async function readIfFile(target: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(target)
    if (!stat.isFile()) return undefined
    if (stat.size > 4 * 1024 * 1024) return undefined
    return await fs.readFile(target, "utf8")
  } catch {
    return undefined
  }
}

export { MAX_IMPORT_DEPTH }
