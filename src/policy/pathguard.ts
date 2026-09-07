/**
 * 路径守卫（development-guide.md §7 第 4 步 / security.md §3.2 失败模式 2）。
 *
 * 三条硬要求：
 * 1. 判定用 **realpath**，不是字符串比较 —— `.env`、符号链接看解析结果，不看写法；
 * 2. 解析后必须落在授权工作区内；
 * 3. 高危清单覆盖"看着像数据、实则是代码"的位置（hook 配置、IDE task 配置、
 *    venv 解释器、`.git` 元数据、CI 配置）—— 它们被沙箱外的受信任程序读取即逃逸。
 */

import { promises as fs, realpathSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { AppError } from "../shared/errors.js"
import { matchesBypassImmunePath } from "./rules.js"

export interface PathGuardOptions {
  workspaceRoot: string
  /** 允许读写的额外根目录（如 shadow snapshot 目录）。 */
  additionalReadRoots?: readonly string[]
  /** 是否禁止读写 gitignored 路径（security.md §3.1 的 respectGitignore）。 */
  respectGitignore?: boolean
  gitignorePatterns?: readonly string[]
}

export interface ResolvedPath {
  /** realpath 解析后的绝对路径（文件不存在时返回 lexical resolve 结果）。 */
  real: string
  /** 是否落在工作区内。 */
  insideWorkspace: boolean
  /** 是否为符号链接且解析后逃出工作区。 */
  symlinkEscape: boolean
}

/**
 * "看着像数据、实则是代码"的高危清单（code-editing.md §3.2 / security.md §3.2）。
 * 命中即需要审批，而不是直接放行写入。
 */
export const CODE_LIKE_PATHS: ReadonlyArray<string> = [
  ".git/config",
  ".git/hooks",
  ".git/info",
  ".vscode/tasks.json",
  ".vscode/settings.json",
  ".vscode/launch.json",
  ".idea/workspace.xml",
  ".github/workflows",
  ".gitlab-ci.yml",
  ".husky",
  ".mod/hooks",
  ".claude/settings.json",
  "pyvenv.cfg",
  "venv/pyvenv.cfg",
  ".venv/pyvenv.cfg",
]

export function isCodeLikePath(absolutePath: string): boolean {
  const normalized = path.resolve(absolutePath).replace(/\\/g, "/").toLowerCase()
  return CODE_LIKE_PATHS.some((entry) => {
    const needle = entry.toLowerCase()
    return (
      normalized === needle ||
      normalized.endsWith(`/${needle}`) ||
      normalized.includes(`/${needle}/`) ||
      normalized.startsWith(`${needle}/`)
    )
  })
}

export class PathGuard {
  private readonly workspaceRoot: string
  private readonly additionalReadRoots: readonly string[]
  private readonly respectGitignore: boolean
  private gitignorePatterns: readonly string[]

  constructor(options: PathGuardOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot)
    this.additionalReadRoots = (options.additionalReadRoots ?? []).map((p) => path.resolve(p))
    this.respectGitignore = options.respectGitignore ?? true
    this.gitignorePatterns = options.gitignorePatterns ?? []
  }

  get root(): string {
    return this.workspaceRoot
  }

  /**
   * 注入 gitignore 规则。
   *
   * 构造是同步的、读 `.gitignore` 是异步的，所以规则只能在构造之后补进来。
   * 之前这里根本没有调用方 —— `respectGitignore` 写着 `true`、文档说它会拦，
   * 而 `gitignorePatterns` 恒为空数组，`isGitignored` 恒返回 false。
   * "看起来有防护"比"没有防护"更危险，因为没人会再去补它。
   */
  setGitignorePatterns(patterns: readonly string[]): void {
    this.gitignorePatterns = [...patterns]
  }

  /**
   * 解析路径并判断是否在工作区内。
   *
   * 三条纪律（缺一条都能绕过）：
   * 1. **存在的路径**用 `fs.realpath`，符号链接看解析结果，不看写法；
   * 2. **不存在的路径**（新建文件的合法场景）也要解析：向上找到最近存在的祖先
   *    做 realpath，再把缺失的尾段拼回去。否则"父目录是逃出工作区的符号链接"
   *    永远识别不出来 —— 之前所有 realpath 异常一律退化成 lexical 路径，
   *    而注释里那句"调用方会再校验父目录"并没有任何调用方在做；
   * 3. **其他错误**（EACCES / EIO / ELOOP）必须 fail-closed：把它们当成
   *    "文件不存在"放行，等于让一次读盘失败变成一次策略失效。
   */
  async resolve(target: string): Promise<ResolvedPath> {
    const lexical = path.resolve(this.workspaceRoot, target)
    const real = await this.realPathOf(lexical)
    const insideWorkspace = this.isInsideRoot(real)
    const symlinkEscape = !insideWorkspace && real !== lexical
    return { real, insideWorkspace, symlinkEscape }
  }

  /** 解析真实路径：存在直接解析，缺失走祖先 + dangling 链接，其余错误 fail-closed。 */
  private async realPathOf(lexical: string, depth = 0): Promise<string> {
    try {
      return await fs.realpath(lexical)
    } catch (err) {
      const code = errnoCode(err)
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new AppError(
          "PATH_POLICY_VIOLATION",
          `Cannot resolve path (${code ?? "unknown error"}): ${lexical}`,
          { details: { path: lexical, code: code ?? null } },
        )
      }
      /**
       * dangling 符号链接：链接本身存在、目标不存在。`realpath` 报 ENOENT，
       * 但写入时内核会沿链接去创建目标文件 —— 若目标在工作区外，就是一条真实逃逸。
       * 所以先看它是不是链接，是就解析到目标再判定（限深，防链接环）。
       */
      if (depth < MAX_LINK_DEPTH) {
        const linkTarget = await this.readLinkTarget(lexical)
        if (linkTarget) return await this.realPathOf(linkTarget, depth + 1)
      }
      return await this.realPathOfNearestAncestor(lexical)
    }
  }

  /** 若 `lexical` 是符号链接，返回其**绝对**目标路径；否则 undefined。 */
  private async readLinkTarget(lexical: string): Promise<string | undefined> {
    try {
      const stat = await fs.lstat(lexical)
      if (!stat.isSymbolicLink()) return undefined
      const target = await fs.readlink(lexical)
      return path.resolve(path.dirname(lexical), target)
    } catch {
      return undefined
    }
  }

  /**
   * 目标不存在时：向上找最近存在的祖先目录，realpath 后再拼回缺失的尾段。
   * 这样 `.gitignore` 里刚被排除的新目录、新建的深层文件都能正确判定；
   * 而祖先若是逃出工作区的链接，拼出来的结果自然落在工作区外。
   */
  private async realPathOfNearestAncestor(lexical: string): Promise<string> {
    const tail: string[] = []
    let current = lexical
    for (;;) {
      const parent = path.dirname(current)
      if (parent === current) {
        throw new AppError(
          "PATH_POLICY_VIOLATION",
          `No existing ancestor directory could be resolved for: ${lexical}`,
          { details: { path: lexical } },
        )
      }
      tail.push(path.basename(current))
      current = parent
      try {
        const real = await fs.realpath(current)
        return path.join(real, ...tail.reverse())
      } catch (err) {
        const code = errnoCode(err)
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          throw new AppError(
            "PATH_POLICY_VIOLATION",
            `Cannot resolve ancestor directory (${code ?? "unknown error"}): ${current}`,
            { details: { path: current, code: code ?? null } },
          )
        }
      }
    }
  }

  private isInsideRoot(candidate: string): boolean {
    if (this.isSubPath(this.workspaceRoot, candidate)) return true
    return this.additionalReadRoots.some((root) => this.isSubPath(root, candidate))
  }

  private isSubPath(root: string, candidate: string): boolean {
    if (process.platform === "win32") {
      const a = root.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "")
      const b = candidate.replace(/\\/g, "/").toLowerCase()
      return b === a || b.startsWith(`${a}/`)
    }
    return candidate === root || candidate.startsWith(`${root}${path.sep}`)
  }

  /** 同步版路径包含判断（纯字符串场景，如规则匹配）。 */
  isInside(candidate: string): boolean {
    return this.isInsideRoot(path.resolve(candidate))
  }

  /**
   * 读路径校验。拒绝：工作区外、bypass-immune 高危路径、被 gitignore 屏蔽的路径。
   */
  async assertReadable(target: string): Promise<string> {
    const resolved = await this.resolve(target)
    if (!resolved.insideWorkspace) {
      throw new AppError(
        "PATH_POLICY_VIOLATION",
        `Refusing to read outside the workspace: ${target}`,
        {
          details: { resolved: resolved.real, workspaceRoot: this.workspaceRoot },
        },
      )
    }
    if (matchesBypassImmunePath(resolved.real)) {
      throw new AppError(
        "PATH_POLICY_VIOLATION",
        `Refusing to read a credential-like path (bypass-immune): ${resolved.real}`,
        { details: { bypassImmune: true } },
      )
    }
    if (this.respectGitignore && this.isGitignored(resolved.real)) {
      throw new AppError(
        "PATH_POLICY_VIOLATION",
        `Path is excluded by respectGitignore: ${resolved.real}`,
      )
    }
    return resolved.real
  }

  /**
   * 写路径校验。在读校验之上，额外对"看着像数据、实则是代码"的位置要求审批。
   * 返回 `needsApproval` 而不是直接拒绝 —— 这些位置并非一律禁止，但不能静默写。
   */
  async assertWritable(
    target: string,
  ): Promise<{ path: string; needsApproval: boolean; reason?: string }> {
    const resolved = await this.resolve(target)
    if (!resolved.insideWorkspace) {
      throw new AppError(
        "PATH_POLICY_VIOLATION",
        `Refusing to write outside the workspace: ${target}`,
        {
          details: { resolved: resolved.real, workspaceRoot: this.workspaceRoot },
        },
      )
    }
    if (matchesBypassImmunePath(resolved.real)) {
      throw new AppError(
        "PATH_POLICY_VIOLATION",
        `Refusing to write a credential-like path (bypass-immune): ${resolved.real}`,
        { details: { bypassImmune: true } },
      )
    }
    if (this.respectGitignore && this.isGitignored(resolved.real)) {
      throw new AppError(
        "PATH_POLICY_VIOLATION",
        `Path is excluded by respectGitignore: ${resolved.real}`,
      )
    }
    if (resolved.symlinkEscape) {
      throw new AppError(
        "PATH_POLICY_VIOLATION",
        `Refusing to write through a symlink that escapes the workspace: ${resolved.real}`,
      )
    }
    if (isCodeLikePath(resolved.real)) {
      return {
        path: resolved.real,
        needsApproval: true,
        reason: `Path feeds a program outside the sandbox (${path.basename(resolved.real)}); writing it requires approval`,
      }
    }
    return { path: resolved.real, needsApproval: false }
  }

  /**
   * 命令 cwd 校验（code-editing.md §3.3 规则 ②：cwd 不得落回主检出）。
   *
   * 必须走 realpath：只做 `path.resolve` + 字符串前缀比较时，工作区内一个
   * 指向工作区外的符号链接目录能直接过关，命令随后就在那个真实目录里执行 ——
   * 而 `assertWritable` 是拦 symlinkEscape 的，两处判定不对称。
   * 这里用同步 realpath：调用频率是"每条命令一次"，不值得为它改成异步签名。
   */
  assertCwd(cwd: string): string {
    const resolved = path.resolve(cwd)
    const real = realpathSyncOrMissing(resolved)
    // cwd 不存在时命令自己会失败，此时按 lexical 判定即可（不新增拒绝理由）
    const candidate = real ?? resolved
    if (!this.isSubPath(this.workspaceRoot, candidate)) {
      throw new AppError(
        "PATH_POLICY_VIOLATION",
        `Command cwd must be inside the authorized workspace: ${cwd}`,
        { details: { resolved, real: candidate, workspaceRoot: this.workspaceRoot } },
      )
    }
    return resolved
  }

  private isGitignored(absolutePath: string): boolean {
    if (this.gitignorePatterns.length === 0) return false
    const rel = path.relative(this.workspaceRoot, absolutePath).replace(/\\/g, "/")
    if (rel.startsWith("..")) return false
    return this.gitignorePatterns.some((pattern) => matchSimpleIgnore(rel, pattern))
  }
}

/** 极简 gitignore 匹配：支持 `dir/`、`*.ext`、`name`、路径前缀、`**\/` 前缀。 */
export function matchSimpleIgnore(relPath: string, pattern: string): boolean {
  const p = pattern
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    // `**/dist` 与 `dist` 在这里等价：本函数不做完整的 gitignore 语义，
    // 只做"是否被排除"的粗筛，过度精确反而会引入一堆边角 bug。
    .replace(/^\*\*\//, "")
  if (p.length === 0) return false
  const segments = relPath.split("/")

  if (p.includes("/")) {
    return relPath === p || relPath.startsWith(`${p}/`) || relPath.includes(`/${p}/`)
  }
  if (p.startsWith("*")) {
    const suffix = p.slice(1)
    return relPath.endsWith(suffix) || segments.some((s) => s.endsWith(suffix))
  }
  return segments.includes(p)
}

/**
 * 读取工作区根目录的 `.gitignore` 与 `.git/info/exclude`，解析成扁平规则列表。
 *
 * 刻意**不支持**否定规则（`!foo`）：`matchSimpleIgnore` 没有"后匹配覆盖先匹配"
 * 的语义，硬塞进去会把"排除"变成"随机排除"。跳过否定行的后果是可能多拦一点，
 * 落在"多打扰"那一侧 —— 与元数据默认值 fail-closed 的取向一致。
 */
export async function loadGitignorePatterns(root: string): Promise<string[]> {
  const sources = [".gitignore", path.join(".git", "info", "exclude")]
  const patterns: string[] = []
  for (const relative of sources) {
    let text: string
    try {
      text = await fs.readFile(path.join(root, relative), "utf8")
    } catch {
      continue
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) continue
      patterns.push(line)
    }
  }
  return patterns
}

export function defaultHome(): string {
  return os.homedir()
}

/* ------------------------------------------------------------------ *
 * 路径解析辅助
 * ------------------------------------------------------------------ */

/** 符号链接解析的最大深度，防 `a → b → a` 这类环把判定挂死。 */
const MAX_LINK_DEPTH = 8

function errnoCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code
  return typeof code === "string" ? code : undefined
}

/**
 * 同步 realpath：只在"目标确实不存在"时返回 undefined。
 * 其他错误（权限、IO、链接环）一律上抛 —— 拿不准就拒绝，不猜。
 */
function realpathSyncOrMissing(target: string): string | undefined {
  try {
    return realpathSync(target)
  } catch (err) {
    const code = errnoCode(err)
    if (code === "ENOENT" || code === "ENOTDIR") return undefined
    throw new AppError(
      "PATH_POLICY_VIOLATION",
      `Cannot resolve command cwd (${code ?? "unknown error"}): ${target}`,
      { details: { path: target, code: code ?? null } },
    )
  }
}
