/**
 * Windows `.cmd` shim 解析的测试。
 *
 * 背景：`npm` / `npx` / `yarn` 在 Windows 上是批处理 shim，
 * `shell: false` 既做不了 PATHEXT 解析（ENOENT），
 * 也不能直接 spawn 批处理（Node 对 CVE-2024-27980 的修复会抛 EINVAL）。
 * 这里验证"解析成 cmd.exe 包装"与"元字符一律拒绝"两条纪律。
 */

import { afterEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { resolveExecutable } from "../src/sandbox/executable-resolver.js"
import { runProcess } from "../src/sandbox/process-runner.js"
import { normalizeCommandRequest } from "../src/shared/contracts.js"

const isWindows = process.platform === "win32"
const temps: string[] = []

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "mod-exe-"))
  const dir = await fs.realpath(raw)
  temps.push(dir)
  return dir
}

describe("sandbox/executable-resolver", () => {
  it("非 Windows 原样返回，不做任何查找", async () => {
    const resolved = await resolveExecutable("npm", ["run", "test"], {
      platform: "linux",
      env: { PATH: "/usr/bin" },
    })
    expect(resolved.command).toBe("npm")
    expect(resolved.args).toEqual(["run", "test"])
    expect(resolved.viaCmdHost).toBe(false)
  })

  it("Windows：PATH 里的 npm.cmd 会被解析成 cmd.exe 包装", async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, "npm.cmd"), "@echo off\r\n", "utf8")

    const resolved = await resolveExecutable("npm", ["run", "test"], {
      platform: "win32",
      env: {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
      cwd: dir,
    })

    expect(resolved.viaCmdHost).toBe(true)
    expect(resolved.command).toBe("C:\\Windows\\System32\\cmd.exe")
    expect(resolved.shimPath?.toLowerCase()).toContain("npm.cmd")
    expect(resolved.args.slice(0, 3)).toEqual(["/d", "/s", "/c"])
    // 最外层引号 + 逐参引号：这是 cmd /s 的标准写法
    // 扩展名大小写沿用 PATHEXT（`.CMD`），Windows 上不敏感，断言统一转小写
    expect(resolved.args[3]?.toLowerCase()).toContain("npm.cmd")
    expect(resolved.args[3]?.startsWith('""')).toBe(true)
    expect(resolved.args[3]).toContain('"run"')
    expect(resolved.args[3]).toContain('"test"')
  })

  it("Windows：.exe 命中时不经 cmd 包装", async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, "tool.exe"), "", "utf8")

    const resolved = await resolveExecutable("tool", ["--flag"], {
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      cwd: dir,
    })

    expect(resolved.viaCmdHost).toBe(false)
    expect(resolved.command.toLowerCase()).toContain("tool.exe")
    expect(resolved.args).toEqual(["--flag"])
  })

  it("Windows：含 cmd 元字符的参数直接拒绝，不做转义尝试", async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, "npm.cmd"), "@echo off\r\n", "utf8")

    await expect(
      resolveExecutable("npm", ["run", "a&echo pwned"], {
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".CMD" },
        cwd: dir,
      }),
    ).rejects.toMatchObject({ code: "COMMAND_DENIED" })
  })

  it("Windows：找不到时不抛错，交给 spawn 报 ENOENT", async () => {
    const resolved = await resolveExecutable("definitely-not-installed", [], {
      platform: "win32",
      env: { PATH: await tempDir(), PATHEXT: ".CMD" },
    })
    expect(resolved.command).toBe("definitely-not-installed")
    expect(resolved.viaCmdHost).toBe(false)
  })

  it.runIf(isWindows)("端到端：真的能执行一个 .cmd fixture", async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, "hello.cmd"), "@echo off\r\necho hello-from-cmd\r\n", "utf8")

    const result = await runProcess(
      normalizeCommandRequest({
        executable: "hello",
        args: [],
        cwd: dir,
        timeoutMs: 30_000,
        networkProfile: "none",
        reason: "run .cmd fixture",
      }),
      { maxOutputChars: 4096, maxTotalOutputBytes: 4096 },
    )

    expect(result.spawnError).toBeUndefined()
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("hello-from-cmd")
  })

  it.runIf(isWindows)("端到端：npm --version 不再 ENOENT（原症状）", async () => {
    const dir = await tempDir()
    const result = await runProcess(
      normalizeCommandRequest({
        executable: "npm",
        args: ["--version"],
        cwd: dir,
        timeoutMs: 60_000,
        networkProfile: "none",
        reason: "smoke npm",
      }),
      { maxOutputChars: 4096, maxTotalOutputBytes: 4096 },
    )

    expect(result.spawnError).toBeUndefined()
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+/)
  })
})
