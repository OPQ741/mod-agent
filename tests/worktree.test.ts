/**
 * Git Worktree 管理器（P1 文件隔离）。
 *
 * 断言的是用户可观察结果：改动落在哪个目录、主检出是否保持干净、
 * 删除后 git 是否还登记着这个 worktree —— 而不是"函数被调用过"。
 */

import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import {
  createWorktree,
  findRepoRoot,
  removeWorktree,
  type WorktreeInfo,
} from "../src/worktree/index.js"

const execFileAsync = promisify(execFile)
const temps: string[] = []
const created: WorktreeInfo[] = []

afterEach(async () => {
  while (created.length > 0) {
    const info = created.pop()
    if (info) await removeWorktree(info).catch(() => undefined)
  }
  while (temps.length > 0) {
    const dir = temps.pop()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(prefix: string): Promise<string> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const dir = await fs.realpath(raw)
  temps.push(dir)
  return dir
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args as string[], {
    cwd,
    windowsHide: true,
    shell: false,
  })
  return stdout.trim()
}

async function initRepo(): Promise<string> {
  const dir = await tempDir("mod-wt-")
  await git(dir, ["init", "-b", "main"])
  await git(dir, ["config", "user.email", "test@example.com"])
  await git(dir, ["config", "user.name", "Test"])
  await fs.writeFile(path.join(dir, "README.md"), "# repo\n", "utf8")
  await git(dir, ["add", "."])
  await git(dir, ["commit", "-m", "init"])
  return dir
}

describe("worktree: 创建与隔离", () => {
  it("worktree 在仓库兄弟目录，改动不落到主检出", async () => {
    const repo = await initRepo()
    const info = await createWorktree({ cwd: repo, taskId: "task_iso" })
    created.push(info)

    // 不在主检出内部：否则 git status 永远脏，路径守卫的"根"也会含混
    expect(info.path.startsWith(`${repo}${path.sep}`)).toBe(false)
    expect(info.path).toContain(".mod-worktrees")
    expect(info.branch).toBe("mod-agent/task_iso")
    expect(info.baseCommit).toMatch(/^[0-9a-f]{40}$/)
    await expect(fs.access(info.path)).resolves.toBeUndefined()

    // 在 worktree 里改动：主检出看不到这个文件，git status 仍然是干净的
    await fs.writeFile(path.join(info.path, "only-in-worktree.txt"), "isolated\n", "utf8")
    await expect(fs.access(path.join(repo, "only-in-worktree.txt"))).rejects.toThrow()
    expect(await git(repo, ["status", "--porcelain"])).toBe("")
  })

  it("同一 taskId 重复创建会被拒绝，而不是复用同一个检出", async () => {
    const repo = await initRepo()
    created.push(await createWorktree({ cwd: repo, taskId: "dup" }))
    await expect(createWorktree({ cwd: repo, taskId: "dup" })).rejects.toMatchObject({
      code: "WORKSPACE_CONFLICT",
    })
  })

  it("findRepoRoot 在子目录里也能找到仓库根", async () => {
    const repo = await initRepo()
    const nested = path.join(repo, "src", "deep")
    await fs.mkdir(nested, { recursive: true })
    expect(await findRepoRoot(nested)).toBe(repo)
  })
})

describe("worktree: 失败与清理", () => {
  it("非 Git 目录明确报错，并告诉用户两个可行做法", async () => {
    const dir = await tempDir("mod-wt-nogit-")
    await expect(createWorktree({ cwd: dir })).rejects.toMatchObject({
      code: "WORKSPACE_CONFLICT",
    })
    await expect(createWorktree({ cwd: dir })).rejects.toThrow(/Git 仓库/)
    await expect(createWorktree({ cwd: dir })).rejects.toThrow(/--worktree/)
  })

  it("removeWorktree 同时清掉目录与 git 登记", async () => {
    const repo = await initRepo()
    const info = await createWorktree({ cwd: repo, taskId: "cleanup" })
    await removeWorktree(info)

    await expect(fs.access(info.path)).rejects.toThrow()
    expect(await git(repo, ["worktree", "list"])).not.toContain(info.path)
  })
})
