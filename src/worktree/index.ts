/**
 * Git Worktree 管理（多任务 / 多 Agent 的文件隔离基础）。
 *
 * 为什么这层必须存在：`EditEngine` 的"按任务隔离"只解决了**已读表**互不污染，
 * 两个任务仍然改同一份工作区文件。Worktree 才是真正的隔离边界 ——
 * 每个任务在自己的检出里工作，主检出保持干净。
 *
 * 三个刻意的约束：
 *
 * 1. **不接受用户可拼接的参数进入 shell**：所有 git 调用都是 `execFile` +
 *    argv 数组，`shell: false`。worktree 路径与分支名只由本模块生成。
 * 2. **禁止 worktree 落在主检出内部**：默认放到仓库的**兄弟目录**
 *    `.mod-worktrees/`。放在主检出内部会让 `git status` 永远脏、也让
 *    路径守卫的"根目录"语义变得含混。
 * 3. **失败必须可行动**：不是 git 仓库时明确说"需要 git 仓库"，
 *    而不是把 git 的原始 stderr 甩给用户。
 *
 * 这一版是 PoC：创建 / 查询 / 删除 + CLI 接线。**不自动合并**，
 * 任务结束后改动留在 worktree 里，由人或上层调度器决定如何 review / 合并。
 */

import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

import { AppError } from "../shared/errors.js"
import { shortId } from "../shared/ids.js"

const execFileAsync = promisify(execFile)

export interface WorktreeInfo {
  /** 主检出的仓库根目录。 */
  repoRoot: string
  /** worktree 检出目录（不在主检出内部）。 */
  path: string
  /** 为任务创建的分支名。 */
  branch: string
  /** 创建时返回基准提交；从 `git worktree list` 读回来的是该检出当前的 HEAD。 */
  baseCommit: string
}

export interface CreateWorktreeOptions {
  /** 任意位于目标仓库内的目录。 */
  cwd: string
  /** 任务标识，用于生成人类可读的分支 / 目录名；省略则随机。 */
  taskId?: string
  /** 基准引用，默认 HEAD。 */
  baseRef?: string
}

/** 执行一条 git 命令，返回 trim 后的 stdout。 */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args as string[], {
      cwd,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      shell: false,
    })
    return stdout.trim()
  } catch (err) {
    throw new AppError("WORKSPACE_CONFLICT", `git ${args.join(" ")} 失败：${messageOf(err)}`, {
      cause: err,
    })
  }
}

export async function findRepoRoot(cwd: string): Promise<string> {
  try {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"])
    if (!root) throw new Error("empty output")
    /**
     * Windows 上 git 输出的是 `C:/a/b`（正斜杠），而 fs.realpath / path.join
     * 一律用反斜杠。不归一化的话，"worktree 是否在主检出内部"这类判断会
     * 因为分隔符不同而误判成"在外面"。
     */
    return path.resolve(await fs.realpath(root))
  } catch (err) {
    throw new AppError(
      "WORKSPACE_CONFLICT",
      `--worktree 需要 Git 仓库：${cwd} 不在任何 Git 工作区内。` +
        "请先 git init / git clone，或去掉 --worktree。",
      { cause: err },
    )
  }
}

/** 分支名里不能出现空格与路径分隔符；taskId 来自上层，做最小净化。 */
function sanitizeRef(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || shortId(8)
}

export async function createWorktree(options: CreateWorktreeOptions): Promise<WorktreeInfo> {
  const repoRoot = await findRepoRoot(options.cwd)
  const baseRef = options.baseRef ?? "HEAD"
  const baseCommit = await git(repoRoot, ["rev-parse", baseRef])
  const suffix = sanitizeRef(options.taskId ?? shortId(8))
  const branch = `mod-agent/${suffix}`
  const checkout = path.join(
    path.dirname(repoRoot),
    ".mod-worktrees",
    `${path.basename(repoRoot)}-${suffix}`,
  )

  // 同一秒内跑两个任务也要拿到不同的 worktree：先确保路径与分支都不存在
  if (await exists(checkout)) {
    throw new AppError("WORKSPACE_CONFLICT", `worktree 目录已存在：${checkout}`)
  }
  const branchExists = await git(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]).then(
    () => true,
    () => false,
  )
  if (branchExists) {
    throw new AppError("WORKSPACE_CONFLICT", `分支已存在：${branch}`)
  }

  await fs.mkdir(path.dirname(checkout), { recursive: true })
  await git(repoRoot, ["worktree", "add", "-b", branch, checkout, baseCommit])

  return { repoRoot, path: checkout, branch, baseCommit }
}

/** 删除 worktree；`removeBranch` 为真时连同分支一起删。 */
export async function removeWorktree(
  info: WorktreeInfo,
  options: { removeBranch?: boolean } = {},
): Promise<void> {
  await git(info.repoRoot, ["worktree", "remove", "--force", info.path])
  // git 偶尔会留下空目录（比如被外部进程占用过），补一次清理
  await fs.rm(info.path, { recursive: true, force: true }).catch(() => undefined)
  if (options.removeBranch) {
    await git(info.repoRoot, ["branch", "-D", info.branch]).catch(() => undefined)
  }
}

/** 列出该仓库下由本工具创建的 worktree（名称按约定前缀识别）。 */
export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const porcelain = await git(repoRoot, ["worktree", "list", "--porcelain"])
  const entries = porcelain.split(/\n\s*\n/).filter(Boolean)
  const out: WorktreeInfo[] = []
  for (const entry of entries) {
    const lines = entry.split("\n")
    const wtPath = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length)
    const branchLine = lines.find((line) => line.startsWith("branch "))
    const commit = lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length)
    if (!wtPath || !commit) continue
    if (!isManagedPath(wtPath)) continue
    out.push({
      repoRoot,
      // git 在 Windows 上输出正斜杠；统一成平台路径，避免"同一个目录两个字符串"
      path: path.resolve(wtPath),
      branch: branchLine ? branchLine.slice("branch ".length).replace(/^refs\/heads\//, "") : "",
      baseCommit: commit,
    })
  }
  return out
}

export interface WorktreeStatus {
  /** 是否有未提交改动（含未跟踪文件）。 */
  dirty: boolean
  /** `git status --porcelain` 的行数。 */
  changedFiles: number
  /** 分支上超出基准提交的提交数：>0 说明有已提交但未合并的产出。 */
  unmergedCommits: number
  summary: string
}

/**
 * 检查 worktree 是否还有未提交改动 / 未合并提交。
 *
 * `clean` 默认拒绝删除这两类检出：worktree 里的改动就是任务的产出，
 * 静默强删等于把用户几个小时的工作删掉。
 */
export async function worktreeStatus(info: WorktreeInfo): Promise<WorktreeStatus> {
  /**
   * 排除 `.mod/`：交付报告等 artifact 是工具自己写的运行产物，
   * 让它把每个 worktree 都判成"脏"，`clean` 就永远删不掉干净任务。
   */
  const porcelain = await git(info.path, ["status", "--porcelain", "--", ".", ":(exclude).mod"])
  const lines = porcelain.length > 0 ? porcelain.split("\n") : []
  /**
   * 用 `HEAD..<branch>` 而不是 `baseCommit..<branch>`：`listWorktrees` 里能拿到的
   * HEAD 是**检出当前**的提交，不是分叉点。拿它当基准的话，任务在 worktree 里
   * 提交过一次之后 `A..A` 恒为 0，`clean` 就会把带未合并提交的分支一起删掉。
   * 以主检出的 HEAD 为基准，未合并提交 = 只存在于这条分支上的提交。
   */
  const count = await git(info.repoRoot, ["rev-list", "--count", `HEAD..${info.branch}`])
  return {
    dirty: lines.length > 0,
    changedFiles: lines.length,
    unmergedCommits: Number(count),
    summary: lines.slice(0, 3).join(" | "),
  }
}

/**
 * 查看某个托管检出里的**未提交改动**（`git diff` + 未跟踪文件）。
 *
 * 为什么不 diff 分支：agent 的改动默认不提交，"改了什么"就是工作区里那份 diff；
 * 已提交的内容由 `worktreeStatus.unmergedCommits` 单独报告，`clean` 也会拦。
 *
 * 未跟踪文件不能只列名字：那等于告诉用户"有新文件，但我不给你看"。这里用
 * `git diff --no-index /dev/null <file>` 生成标准补丁，**全程不 `git add`** ——
 * 暂存区属于用户的工作区状态，看 diff 不该改它。
 */
export async function worktreeDiff(
  info: WorktreeInfo,
  options: { stat?: boolean } = {},
): Promise<string> {
  if (options.stat) {
    const tracked = await git(info.path, ["diff", "--stat"])
    const untracked = await listUntracked(info.path)
    const section =
      untracked.length > 0 ? `未跟踪文件（${untracked.length}）：\n${untracked.join("\n")}` : ""
    return [tracked, section].filter((part) => part.length > 0).join("\n\n")
  }

  const tracked = await git(info.path, ["diff"])
  const untracked = await listUntracked(info.path)
  const MAX_UNTRACKED_PATCHES = 20
  const patches: string[] = []
  for (const file of untracked.slice(0, MAX_UNTRACKED_PATCHES)) {
    patches.push(await diffUntracked(info.path, file))
  }
  if (untracked.length > MAX_UNTRACKED_PATCHES) {
    patches.push(
      `（还有 ${untracked.length - MAX_UNTRACKED_PATCHES} 个未跟踪文件未展开，用 git status 查看）`,
    )
  }
  return [tracked, ...patches].filter((part) => part.trim().length > 0).join("\n")
}

/** `git ls-files -z` 的输出按 NUL 切分，能安全处理带空格 / 中文的文件名。 */
async function listUntracked(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    {
      cwd,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      shell: false,
    },
  )
  return stdout.split("\0").filter((name) => name.length > 0)
}

/** 未跟踪文件相对空文件做 no-index diff；git 用退出码 1 表示"有差异"，不是失败。 */
async function diffUntracked(cwd: string, file: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--no-index", "--", "/dev/null", file], {
      cwd,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      shell: false,
    })
    return stdout
  } catch (err) {
    const typed = err as { code?: number; stdout?: string }
    if (typed.code === 1 && typeof typed.stdout === "string") return typed.stdout
    throw new AppError("WORKSPACE_CONFLICT", `git diff --no-index 失败：${messageOf(err)}`, {
      cause: err,
    })
  }
}

function isManagedPath(candidate: string): boolean {
  return path.basename(path.dirname(candidate)) === ".mod-worktrees"
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate)
    return true
  } catch {
    return false
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    const stderr = (err as { stderr?: unknown }).stderr
    if (typeof stderr === "string" && stderr.trim().length > 0) return stderr.trim()
    return err.message
  }
  return String(err)
}
