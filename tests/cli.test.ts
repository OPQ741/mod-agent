/**
 * CLI 端到端测试（ADR-7 CLI-first / usage.md §4）。
 *
 * 用 `runCli(argv, { io: createMemoryIo(), cwd, homeDir, env })` 把 CLI 当库来调：
 * 不 fork 子进程、不碰真实 HOME、不联网（模型走 `--script` 回放）。
 *
 * 三条硬要求在这里被逐条验证：
 * 1. stdout 只有机器可读的结果，日志与提示一律走 stderr；
 * 2. `--output-format json` 是一个对象，`stream-json` 是每行一个对象 + 末尾 result；
 * 3. 退出码就是成败：0 成功、1 失败、2 被人打断或挡在审批上。
 */

import { afterEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { runCli } from "../src/cli/index.js"
import { createMemoryIo } from "../src/cli/io.js"
import { renderEventText, parseOutputFormat, buildJsonResult } from "../src/cli/render.js"
import { createInteractivePrompter, createDenyResolver } from "../src/cli/approval.js"
import { EXIT_ERROR, EXIT_OK, EXIT_BLOCKED } from "../src/runtime/driver.js"
import { type TempWorkspace } from "./helpers.js"

const temps: string[] = []

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(prefix = "mod-cli-"): Promise<string> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const dir = await fs.realpath(raw)
  temps.push(dir)
  return dir
}

interface CliRun {
  code: number
  stdout: string
  stderr: string
}

async function run(
  argv: string[],
  options: {
    cwd: string
    homeDir: string
    env?: NodeJS.ProcessEnv
    isTty?: boolean
    answers?: string[]
  },
): Promise<CliRun> {
  const io = createMemoryIo({
    isTty: options.isTty ?? false,
    ...(options.answers ? { answers: options.answers } : {}),
  })
  const code = await runCli(argv, {
    io,
    cwd: options.cwd,
    homeDir: options.homeDir,
    // 不继承真实环境：避免宿主上的 ANTHROPIC_API_KEY / MOD_AGENT_* 影响断言
    env: options.env ?? {},
  })
  return { code, stdout: io.stdoutText(), stderr: io.stderrText() }
}

/** 一个"读一个文件然后收尾"的离线脚本。 */
async function writeScript(dir: string, steps: unknown[]): Promise<string> {
  const file = path.join(dir, "script.json")
  await fs.writeFile(file, JSON.stringify(steps), "utf8")
  return file
}

async function setup(): Promise<{ cwd: string; homeDir: string; workspace: TempWorkspace }> {
  const homeDir = await tempDir("mod-home-")
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "mod-cliws-"))
  const cwd = await fs.realpath(raw)
  temps.push(cwd)
  const workspace = {
    root: cwd,
    async cleanup() {},
    async write(relPath: string, content: string) {
      const target = path.join(cwd, relPath)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, content, "utf8")
      return target
    },
    async read(relPath: string) {
      return fs.readFile(path.join(cwd, relPath), "utf8")
    },
    async exists(relPath: string) {
      try {
        await fs.access(path.join(cwd, relPath))
        return true
      } catch {
        return false
      }
    },
    abs(relPath: string) {
      return path.join(cwd, relPath)
    },
  } satisfies TempWorkspace
  return { cwd, homeDir, workspace }
}

/* ------------------------------------------------------------------ *
 * 元命令
 * ------------------------------------------------------------------ */

describe("CLI · 元命令", () => {
  it("--help 列出主选项与子命令，退出码 0", async () => {
    const { cwd, homeDir } = await setup()
    const result = await run(["--help"], { cwd, homeDir })
    expect(result.code).toBe(EXIT_OK)
    expect(result.stdout).toContain("--print")
    expect(result.stdout).toContain("--output-format")
    expect(result.stdout).toContain("doctor")
    expect(result.stdout).toContain("config")
  })

  it("--version 输出 package.json 里的版本", async () => {
    const { cwd, homeDir } = await setup()
    const result = await run(["--version"], { cwd, homeDir })
    expect(result.code).toBe(EXIT_OK)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("未知子命令 → 非 0 退出（不能悄悄当成任务去跑）", async () => {
    const { cwd, homeDir } = await setup()
    const result = await run(["definitely-not-a-command"], { cwd, homeDir })
    expect(result.code).not.toBe(EXIT_OK)
  })
})

/* ------------------------------------------------------------------ *
 * doctor / config
 * ------------------------------------------------------------------ */

describe("CLI · doctor 与 config", () => {
  it("doctor：人读输出，含工作区 / 运行时 / 存储 / 沙箱 / 工具 / 策略版本", async () => {
    const { cwd, homeDir } = await setup()
    const result = await run(["doctor"], { cwd, homeDir })
    expect(result.code).toBe(EXIT_OK)
    expect(result.stdout).toContain("工作区")
    expect(result.stdout).toContain("运行时")
    expect(result.stdout).toContain("存储")
    expect(result.stdout).toContain("沙箱")
    expect(result.stdout).toContain("工具")
    expect(result.stdout).toContain("策略版本")
  })

  it("doctor --json：可被 JSON.parse，且沙箱覆盖声明是数组", async () => {
    const { cwd, homeDir } = await setup()
    const result = await run(["doctor", "--json"], { cwd, homeDir })
    expect(result.code).toBe(EXIT_OK)
    const parsed: unknown = JSON.parse(result.stdout)
    const report = parsed as { sandbox: { coverage: string[] }; tools: string[]; storeKind: string }
    expect(Array.isArray(report.sandbox.coverage)).toBe(true)
    expect(report.tools.length).toBeGreaterThan(0)
    expect(["memory", "sqlite"]).toContain(report.storeKind)
  })

  it("doctor 明确声明沙箱未覆盖的部分（不许把受限子进程说成完整沙箱）", async () => {
    const { cwd, homeDir } = await setup()
    const result = await run(["doctor"], { cwd, homeDir })
    if (result.stdout.includes("restricted-subprocess")) {
      expect(result.stdout).toMatch(/NOT covered/i)
    }
  })

  it("doctor -C <dir> 真的诊断那个目录（不能悄悄诊断当前目录）", async () => {
    const { cwd, homeDir } = await setup()
    const result = await run(["doctor", "-C", cwd, "--json"], { cwd: process.cwd(), homeDir })
    expect(result.code).toBe(EXIT_OK)
    const parsed = JSON.parse(result.stdout) as { workspaceRoot: string }
    // realpath 后比较：大小写与分隔符在 Windows 上会漂
    expect(await fs.realpath(parsed.workspaceRoot)).toBe(await fs.realpath(cwd))
  })

  it("config show -C <dir> 同样生效", async () => {
    const { cwd, homeDir } = await setup()
    await fs.writeFile(
      path.join(cwd, "settings.local.json"),
      JSON.stringify({ mode: "ask" }),
      "utf8",
    )
    const result = await run(["config", "show", "-C", cwd, "--json"], {
      cwd: process.cwd(),
      homeDir,
    })
    expect(result.code).toBe(EXIT_OK)
    const parsed = JSON.parse(result.stdout) as {
      settings: { mode?: string }
      layers: Array<{ name: string }>
    }
    expect(parsed.settings.mode).toBe("ask")
    expect(parsed.layers.map((l) => l.name)).toContain("project")
  })

  it("--settings 内联 JSON 生效（CLI 层优先级高于项目层）", async () => {
    const { cwd, homeDir } = await setup()
    const result = await run(
      ["config", "show", "--settings", JSON.stringify({ permissionMode: "acceptEdits" }), "--json"],
      { cwd, homeDir },
    )
    expect(result.code).toBe(EXIT_OK)
    const parsed = JSON.parse(result.stdout) as { settings: { permissionMode?: string } }
    expect(parsed.settings.permissionMode).toBe("acceptEdits")
  })

  it("config show --json：给出生效配置与分层来源", async () => {
    const { cwd, homeDir } = await setup()
    const result = await run(["config", "show", "--json"], { cwd, homeDir })
    expect(result.code).toBe(EXIT_OK)
    const parsed = JSON.parse(result.stdout) as { settings: { mode?: string }; layers: unknown[] }
    expect(parsed.settings).toBeDefined()
    expect(Array.isArray(parsed.layers)).toBe(true)
  })

  it("config show（人读）列出分层", async () => {
    const { cwd, homeDir } = await setup()
    const result = await run(["config", "show"], { cwd, homeDir })
    expect(result.code).toBe(EXIT_OK)
    expect(result.stdout).toContain("生效分层")
  })
})

/* ------------------------------------------------------------------ *
 * headless --print
 * ------------------------------------------------------------------ */

describe("CLI · headless --print", () => {
  it("text 格式：结果进 stdout，事件与提示进 stderr", async () => {
    const { cwd, homeDir, workspace } = await setup()
    await workspace.write("src/a.ts", "export const a = 1\n")
    const script = await writeScript(homeDir, [
      {
        type: "tool_use",
        callId: "c1",
        toolName: "repo.read_file",
        args: { path: workspace.abs("src/a.ts") },
      },
      { type: "final", summary: "读完了" },
    ])

    const result = await run(
      ["--print", "读一下 src/a.ts", "--script", script, "--permission-mode", "acceptEdits"],
      { cwd, homeDir },
    )
    expect(result.code).toBe(EXIT_OK)
    expect(result.stdout).toContain("读完了")
    // 事件行不能污染 stdout
    expect(result.stdout).not.toContain("[工具]")
    expect(result.stderr).toContain("[工具]")
  })

  it("json 格式：stdout 是**一个** JSON 对象，带 usage 与 total_cost_usd", async () => {
    const { cwd, homeDir } = await setup()
    const script = await writeScript(homeDir, [{ type: "final", summary: "done" }])
    const result = await run(["--print", "hi", "--script", script, "--output-format", "json"], {
      cwd,
      homeDir,
    })
    expect(result.code).toBe(EXIT_OK)
    const parsed = JSON.parse(result.stdout) as {
      type: string
      subtype: string
      is_error: boolean
      result: string
      total_cost_usd: number
      usage: { rounds: number }
    }
    expect(parsed.type).toBe("result")
    expect(parsed.subtype).toBe("success")
    expect(parsed.is_error).toBe(false)
    expect(parsed.result).toBe("done")
    expect(typeof parsed.total_cost_usd).toBe("number")
    expect(parsed.usage.rounds).toBe(1)
  })

  it("stream-json 格式：每行一个事件，最后一行是 result", async () => {
    const { cwd, homeDir } = await setup()
    const script = await writeScript(homeDir, [{ type: "final", summary: "streamed" }])
    const result = await run(
      ["--print", "hi", "--script", script, "--output-format", "stream-json"],
      { cwd, homeDir },
    )
    expect(result.code).toBe(EXIT_OK)
    const lines = result.stdout
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
    expect(lines.length).toBeGreaterThan(1)
    const parsed = lines.map((l) => JSON.parse(l) as { type?: string })
    expect(parsed[parsed.length - 1]?.type).toBe("result")
    // 中间必须能看到真实事件
    expect(parsed.some((p) => p.type === "task.status_changed")).toBe(true)
  })

  it("缺需求 → 退出码 1，且把原因写到 stderr", async () => {
    const { cwd, homeDir } = await setup()
    const result = await run(["--print", ""], { cwd, homeDir })
    expect(result.code).toBe(EXIT_ERROR)
    expect(result.stderr).toContain("缺少需求")
  })

  it("非法 --mode → 退出码 1，不落到默认分支去跑任务", async () => {
    const { cwd, homeDir } = await setup()
    const result = await run(["--print", "hi", "--mode", "chaos"], { cwd, homeDir })
    expect(result.code).toBe(EXIT_ERROR)
    expect(result.stderr).toContain("--mode 非法")
  })

  it("非法 --permission-mode → 退出码 1", async () => {
    const { cwd, homeDir } = await setup()
    const result = await run(["--print", "hi", "--permission-mode", "yolo"], { cwd, homeDir })
    expect(result.code).toBe(EXIT_ERROR)
    expect(result.stderr).toContain("--permission-mode 非法")
  })

  it("非法 --output-format → 退出码 1", async () => {
    const { cwd, homeDir } = await setup()
    const result = await run(["--print", "hi", "--output-format", "yaml"], { cwd, homeDir })
    expect(result.code).toBe(EXIT_ERROR)
  })

  it("任务失败 → 退出码 1（脚本耗尽时循环没在该停的地方停下）", async () => {
    const { cwd, homeDir, workspace } = await setup()
    await workspace.write("src/a.ts", "x\n")
    // 只给一条会失败的工具调用，后面没有 final：脚本必然耗尽
    const script = await writeScript(homeDir, [
      {
        type: "tool_use",
        callId: "c1",
        toolName: "repo.read_file",
        args: { path: workspace.abs("nope.ts") },
      },
    ])
    const result = await run(["--print", "读一个不存在的文件", "--script", script], {
      cwd,
      homeDir,
    })
    expect(result.code).toBe(EXIT_ERROR)
  })

  it("--bare：不加载仓库规则，也不自动跑验证", async () => {
    const { cwd, homeDir, workspace } = await setup()
    await workspace.write("AGENTS.md", "# 规则：绝不能提到 CANARY\n")
    const script = await writeScript(homeDir, [{ type: "final", summary: "ok" }])
    const result = await run(["--print", "hi", "--script", script, "--bare"], { cwd, homeDir })
    expect(result.code).toBe(EXIT_OK)
    expect(result.stderr).not.toContain("CANARY")
  })

  it("--resume 未知任务 → 退出码 1 且给出可操作的提示", async () => {
    const { cwd, homeDir } = await setup()
    const result = await run(["--resume", "task_does_not_exist"], { cwd, homeDir })
    expect(result.code).toBe(EXIT_ERROR)
    expect(result.stderr).toContain("找不到任务")
  })
})

/* ------------------------------------------------------------------ *
 * 审批：非交互一律拒绝
 * ------------------------------------------------------------------ */

describe("CLI · 审批", () => {
  it("headless（无 TTY）：需要审批的动作直接被拒，而不是静默放行", async () => {
    const { cwd, homeDir } = await setup()
    const script = await writeScript(homeDir, [
      {
        type: "tool_use",
        callId: "c1",
        toolName: "command.run",
        args: {
          executable: process.execPath,
          args: ["-e", "0"],
          cwd,
          reason: "smoke",
          timeoutMs: 120_000,
          networkProfile: "none",
          onTimeout: "kill",
        },
      },
      { type: "final", summary: "被挡住了，但任务收尾" },
    ])
    const result = await run(
      [
        "--print",
        "跑一条命令",
        "--script",
        script,
        "--mode",
        "edit",
        "--permission-mode",
        "default",
        "--output-format",
        "json",
      ],
      { cwd, homeDir },
    )
    expect(result.code).toBe(EXIT_OK)
    const parsed = JSON.parse(result.stdout) as {
      permission_denials: Array<{ toolName: string; reason: string }>
    }
    expect(parsed.permission_denials.map((d) => d.toolName)).toContain("command.run")
    // 拒绝必须带理由，否则模型只能瞎猜为什么被拒
    expect(parsed.permission_denials[0]?.reason.length ?? 0).toBeGreaterThan(0)
  })

  it("有 TTY 时真的会问人：回答 1 就放行并继续执行", async () => {
    const { cwd, homeDir } = await setup()
    const args = {
      executable: process.execPath,
      args: ["-e", "process.stdout.write('APPROVED-RAN')"],
      cwd,
      reason: "smoke",
      timeoutMs: 120_000,
      networkProfile: "none",
      onTimeout: "kill",
    }
    const script = await writeScript(homeDir, [
      { type: "tool_use", callId: "c1", toolName: "command.run", args },
      // 批准后恢复，模型重放同一条命令（这次已获会话放行）
      { type: "tool_use", callId: "c2", toolName: "command.run", args },
      { type: "final", summary: "批准后跑完了" },
    ])
    const result = await run(
      [
        "--print",
        "跑一条命令",
        "--script",
        script,
        "--mode",
        "edit",
        "--permission-mode",
        "default",
      ],
      { cwd, homeDir, isTty: true, answers: ["1"] },
    )
    expect(result.code).toBe(EXIT_OK)
    expect(result.stderr).toContain("需要批准")
    expect(result.stderr).toContain("允许一次")
  })

  it("有 TTY 但人选择拒绝：停在审批点，退出码 2", async () => {
    const { cwd, homeDir } = await setup()
    const script = await writeScript(homeDir, [
      {
        type: "tool_use",
        callId: "c1",
        toolName: "command.run",
        args: {
          executable: process.execPath,
          args: ["-e", "0"],
          cwd,
          reason: "smoke",
          timeoutMs: 120_000,
          networkProfile: "none",
          onTimeout: "kill",
        },
      },
    ])
    const result = await run(
      [
        "--print",
        "跑一条命令",
        "--script",
        script,
        "--mode",
        "edit",
        "--permission-mode",
        "default",
      ],
      { cwd, homeDir, isTty: true, answers: ["3"] },
    )
    expect(result.code).toBe(EXIT_BLOCKED)
    expect(result.stdout).toContain("停在审批")
  })
})

/* ------------------------------------------------------------------ *
 * 渲染与审批求解（纯函数部分）
 * ------------------------------------------------------------------ */

describe("CLI · 渲染与审批求解", () => {
  it("parseOutputFormat：只认三种，其余抛错", () => {
    expect(parseOutputFormat("json")).toBe("json")
    expect(parseOutputFormat("stream-json")).toBe("stream-json")
    expect(parseOutputFormat("text")).toBe("text")
    expect(parseOutputFormat(undefined)).toBe("text")
    expect(() => parseOutputFormat("yaml")).toThrow(/Unsupported/)
  })

  it("renderEventText：task.completed 不占一行（结果由收尾摘要统一输出）", () => {
    expect(
      renderEventText({
        eventId: "e1",
        taskId: "t1",
        seq: 1,
        type: "task.completed",
        timestamp: "",
        payload: {},
        parentCallId: null,
      }),
    ).toBeUndefined()
  })

  it("renderEventText：常见事件都有人读文案", () => {
    const render = (type: string, payload: Record<string, unknown>): string | undefined =>
      renderEventText({
        eventId: "e1",
        taskId: "t1",
        seq: 1,
        type: type as "tool.started",
        timestamp: "",
        payload,
        parentCallId: null,
      })
    expect(render("tool.started", { tool: "repo.read_file" })).toContain("repo.read_file")
    expect(render("approval.required", { tool: "command.run", reason: "r" })).toContain("需要批准")
    expect(render("validation.completed", { status: "passed" })).toContain("passed")
    expect(render("task.failed", { code: "TEST_FAILED", message: "m" })).toContain("TEST_FAILED")
  })

  it("buildJsonResult：没有 outcome 时不撒谎（is_error=true，subtype 明确）", () => {
    const payload = buildJsonResult({
      taskId: "t1",
      durationMs: 5,
      metrics: { counters: {}, timings: {} } as never,
    })
    expect(payload.is_error).toBe(true)
    expect(payload.subtype).toBe("error_during_execution")
    expect(payload.result).toBe("")
  })

  it("非交互 prompter 一律拒绝", async () => {
    const io = createMemoryIo({ isTty: false })
    const resolver = createInteractivePrompter(io)
    const resolution = await resolver({
      approvalId: "apr_1",
      tool: "command.run",
      parameterHash: "h",
      reason: "r",
    })
    expect(resolution.decision).toBe("denied")
    expect(io.stderrText()).toContain("非交互环境")
  })

  it("交互 prompter：1 允许一次，2 本会话放行，回车/乱码按拒绝", async () => {
    const one = createInteractivePrompter(createMemoryIo({ isTty: true, answers: ["1"] }))
    expect(
      (await one({ approvalId: "a", tool: "t", parameterHash: "h", reason: "r" })).decision,
    ).toBe("allowed")

    const two = createInteractivePrompter(createMemoryIo({ isTty: true, answers: ["2"] }))
    const twoResolution = await two({ approvalId: "a", tool: "t", parameterHash: "h", reason: "r" })
    expect(twoResolution.decision).toBe("allowed")
    expect(twoResolution.sessionScope).toBe(true)

    const enter = createInteractivePrompter(createMemoryIo({ isTty: true, answers: [""] }))
    expect(
      (await enter({ approvalId: "a", tool: "t", parameterHash: "h", reason: "r" })).decision,
    ).toBe("denied")

    const junk = createInteractivePrompter(createMemoryIo({ isTty: true, answers: ["maybe"] }))
    expect(
      (await junk({ approvalId: "a", tool: "t", parameterHash: "h", reason: "r" })).decision,
    ).toBe("denied")
  })

  it("deny resolver 给出「改用配置放行」的可操作提示", async () => {
    const io = createMemoryIo({ isTty: false })
    const resolution = await createDenyResolver(io)({
      approvalId: "apr_1",
      tool: "command.run",
      parameterHash: "h",
      reason: "r",
    })
    expect(resolution.decision).toBe("denied")
    expect(io.stderrText()).toContain("permissions.allow")
  })
})
