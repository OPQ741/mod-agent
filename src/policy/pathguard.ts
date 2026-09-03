/**
 * 路径守卫（development-guide.md §7 第 4 步 / security.md §3.2 失败模式 2）。
 *
 * 三条硬要求：
 * 1. 判定用 **realpath**，不是字符串比较 —— `.env`、符号链接看解析结果，不看写法；
 * 2. 解析后必须落在授权工作区内；
 * 3. 高危清单覆盖"看着像数据、实则是代码"的位置（hook 配置、IDE task 配置、
 *    venv 解释器、`.git` 元数据、CI 配置）—— 它们被沙箱外的受信任程序读取即逃逸。
 */

import { promises as fs } from "node:fs"
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
  private readonly gitignorePatterns: readonly string[]

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
   * 解析路径并判断是否在工作区内。
   *
   * 文件不存在时 realpath 会抛错，此时退化为 lexical resolve —— 新建文件是合法场景，
   * 不能因为文件不存在就拒绝，但**父目录必须存在且落在工作区内**。
   */
  async resolve(target: string): Promise<ResolvedPath> {
    const lexical = path.resolve(this.workspaceRoot, target)
    let real: string
    try {
      real = await fs.realpath(lexical)
    } catch {
      // 文件不存在：用 lexical 路径，调用方会再校验父目录
      real = lexical
    }
    const insideWorkspace = this.isInsideRoot(real)
    const symlinkEscape = !insideWorkspace && real !== lexical
    return { real, insideWorkspace, symlinkEscape }
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

  /** 命令 cwd 校验（code-editing.md §3.3 规则 ②：cwd 不得落回主检出）。 */
  assertCwd(cwd: string): string {
    const resolved = path.resolve(cwd)
    if (!this.isSubPath(this.workspaceRoot, resolved)) {
      throw new AppError(
        "PATH_POLICY_VIOLATION",
        `Command cwd must be inside the authorized workspace: ${cwd}`,
        { details: { resolved, workspaceRoot: this.workspaceRoot } },
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

/** 极简 gitignore 匹配：支持 `dir/`、`*.ext`、`name`、路径前缀。 */
export function matchSimpleIgnore(relPath: string, pattern: string): boolean {
  const p = pattern.trim().replace(/^\/+/, "").replace(/\/+$/, "")
  if (p.length === 0) return false
  const segments = relPath.split("/")

  if (p.includes("/")) {
    return relPath === p || relPath.startsWith(`${p}/`)
  }
  if (p.startsWith("*")) {
    const suffix = p.slice(1)
    return relPath.endsWith(suffix) || segments.some((s) => s.endsWith(suffix))
  }
  return segments.includes(p)
}

export function defaultHome(): string {
  return os.homedir()
}
