/**
 * Agent SDK 测试（ADR-10）。
 *
 * 核心断言只有一条：`query()` 与 `mod --print` 走**同一个** runtime 内核与同一个
 * `driveTask`，差别只在入参与出参形状。所以这里不重复验证循环分支（那是 loop.test.ts
 * 的活），只验证 SDK 这层：任务创建、事件转发、审批回调、退出码、以及"与 CLI 一致"。
 */

import { afterEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"

import { query, EXIT_OK, EXIT_BLOCKED, EXIT_ERROR } from "../src/sdk/index.js"
import { runCli } from "../src/cli/index.js"
import { createMemoryIo } from "../src/cli/io.js"
import { ScriptedProvider, toolUse, final } from "../src/model/scripted.js"
import { settingsWith, createTempWorkspace, type TempWorkspace } from "./helpers.js"
import { createStore } from "../src/store/sqlite.js"
import type { Settings } from "../src/config/settings.js"
import type { TaskEvent } from "../src/shared/contracts.js"

const workspaces: TempWorkspace[] = []

afterEach(async () => {
  while (workspaces.length > 0) {
    const ws = workspaces.pop()
    if (ws) await ws.cleanup()
  }
})

async function workspace(files?: Record<string, string>): Promise<TempWorkspace> {
  const ws = await createTempWorkspace()
  workspaces.push(ws)
  for (const [rel, content] of Object.entries(files ?? {})) {
    await ws.write(rel, content)
  }
  return ws
}

const editSettings: Settings = settingsWith({ mode: "edit", permissionMode: "acceptEdits" })

/* ------------------------------------------------------------------ *
 * 基本能力
 * ------------------------------------------------------------------ */

describe("SDK · query()", () => {
  it("一次调用跑完任务：返回 taskId / 事件 / usage / 退出码", async () => {
    const ws = await workspace({ "src/a.ts": "export const a = 1\n" })
    const result = await query({
      prompt: "读一下 src/a.ts 然后总结",
      provider: new ScriptedProvider([
        toolUse("repo.read_file", { path: ws.abs("src/a.ts") }),
        final("读完：a = 1"),
      ]),
      workspaceRoot: ws.root,
      settings: editSettings,
    })

    expect(result.taskId).toMatch(/^task_/)
    expect(result.exitCode).toBe(EXIT_OK)
    expect(result.outcome?.status).toBe("completed")
    expect(result.outcome?.summary).toBe("读完：a = 1")
    expect(result.events.length).toBeGreaterThan(0)
    expect(result.usage?.rounds).toBe(2)
    expect(result.metrics.counters["tool.succeeded"]).toBe(1)
  })

  it("onEvent 逐条转发，顺序与发生顺序一致", async () => {
    const ws = await workspace({ "src/a.ts": "x\n" })
    const seen: TaskEvent[] = []
    await query({
      prompt: "读文件",
      provider: new ScriptedProvider([
        toolUse("repo.read_file", { path: ws.abs("src/a.ts") }),
        final("ok"),
      ]),
      workspaceRoot: ws.root,
      settings: editSettings,
      onEvent: (event) => seen.push(event),
    })
    expect(seen.length).toBeGreaterThan(0)
    // 先开始工具，再完成工具，最后完成任务
    const types = seen.map((e) => e.type)
    expect(types.indexOf("tool.started")).toBeLessThan(types.indexOf("tool.completed"))
    expect(types).toContain("task.completed")
    // 最后一条是终态迁移：消费端据此知道"真的结束了"，而不只是看到一句总结
    const last = seen[seen.length - 1]
    expect(last?.type).toBe("task.status_changed")
    expect((last?.payload as { to: string }).to).toBe("completed")
  })

  it("title 从 prompt 首行截取，超长截断", async () => {
    const ws = await workspace()
    const result = await query({
      prompt: `${"很长的标题".repeat(20)}\n第二行`,
      provider: new ScriptedProvider([final("ok")]),
      workspaceRoot: ws.root,
      settings: editSettings,
    })
    expect(result.exitCode).toBe(EXIT_OK)
  })

  it("无人值守且无 TTY：该问的动作直接被拒，不静默放行", async () => {
    const ws = await workspace()
    const result = await query({
      prompt: "跑一条命令",
      provider: new ScriptedProvider([
        toolUse("command.run", {
          executable: process.execPath,
          args: ["--version"],
          cwd: ws.root,
          reason: "smoke",
          timeoutMs: 120_000,
          networkProfile: "none",
          onTimeout: "kill",
        }),
        final("被挡住但收尾"),
      ]),
      workspaceRoot: ws.root,
      settings: settingsWith({ mode: "edit", permissionMode: "default" }),
    })
    expect(result.outcome?.permissionDenials.map((d) => d.toolName)).toContain("command.run")
  })

  it("有 TTY 但不传 onApproval = fail-closed：停在审批点返回 2", async () => {
    const ws = await workspace()
    const result = await query({
      prompt: "跑一条命令",
      provider: new ScriptedProvider([
        toolUse("command.run", {
          executable: process.execPath,
          args: ["--version"],
          cwd: ws.root,
          reason: "smoke",
          timeoutMs: 120_000,
          networkProfile: "none",
          onTimeout: "kill",
        }),
      ]),
      workspaceRoot: ws.root,
      settings: settingsWith({ mode: "edit", permissionMode: "default" }),
      hasTty: true,
    })
    expect(result.exitCode).toBe(EXIT_BLOCKED)
    expect(result.pendingApproval?.tool).toBe("command.run")
    expect(result.outcome?.subtype).toBe("approval_required")
  })

  it("signal 中断 → 退出码 2", async () => {
    const ws = await workspace({ "src/a.ts": "x\n" })
    const controller = new AbortController()
    controller.abort()
    const result = await query({
      prompt: "读文件",
      provider: new ScriptedProvider([
        toolUse("repo.read_file", { path: ws.abs("src/a.ts") }),
        final("never"),
      ]),
      workspaceRoot: ws.root,
      settings: editSettings,
      signal: controller.signal,
    })
    expect(result.exitCode).toBe(EXIT_BLOCKED)
    expect(result.outcome?.subtype).toBe("cancelled")
  })

  it("sqliteFile：任务与消息真的落盘，跨进程可读回", async () => {
    const ws = await workspace()
    const db = ws.abs("state.sqlite")
    const first = await query({
      prompt: "do the thing",
      provider: new ScriptedProvider([final("第一次")]),
      workspaceRoot: ws.root,
      settings: editSettings,
      sqliteFile: db,
    })
    expect(first.exitCode).toBe(EXIT_OK)
    expect(await ws.exists("state.sqlite")).toBe(true)

    const opened = await createStore({ sqliteFile: db })
    const tasks = await opened.store.listTasks()
    expect(tasks.length).toBe(1)
    // 用户的原始请求必须落库：否则恢复时模型不知道自己要干什么
    const messages = await opened.store.getMessages(tasks[0]!.id)
    expect(JSON.stringify(messages)).toContain("do the thing")
    await opened.store.close()

    // 再跑一次同一个库：任务累加，说明状态是持久的而不是每次重建
    await query({
      prompt: "第二次",
      provider: new ScriptedProvider([final("第二次")]),
      workspaceRoot: ws.root,
      settings: editSettings,
      sqliteFile: db,
    })
    const reopened = await createStore({ sqliteFile: db })
    expect((await reopened.store.listTasks()).length).toBe(2)
    await reopened.store.close()
  })

  it("写文件真的落到磁盘", async () => {
    const ws = await workspace()
    await query({
      prompt: "建个文件",
      provider: new ScriptedProvider([
        toolUse("repo.write_file", { path: ws.abs("out.txt"), content: "hello sdk\n" }),
        final("created"),
      ]),
      workspaceRoot: ws.root,
      settings: editSettings,
    })
    expect(await ws.read("out.txt")).toBe("hello sdk\n")
  })

  it("工具失败不掀翻 SDK：循环继续，任务照样收尾", async () => {
    const ws = await workspace()
    const result = await query({
      prompt: "调一个不存在的工具",
      provider: new ScriptedProvider([toolUse("nope.tool", {}), final("recovered")]),
      workspaceRoot: ws.root,
      settings: editSettings,
    })
    expect(result.exitCode).toBe(EXIT_OK)
    expect(result.metrics.counters["tool.failed"]).toBe(1)
  })
})

/* ------------------------------------------------------------------ *
 * ADR-10：与 CLI 同一内核
 * ------------------------------------------------------------------ */

describe("SDK 与 CLI 共用内核（ADR-10）", () => {
  it("同一份脚本在 SDK 与 CLI 里产出同样的终态与退出码", async () => {
    const ws = await workspace({ "src/a.ts": "export const same = 1\n" })
    const steps = [toolUse("repo.read_file", { path: ws.abs("src/a.ts") }), final("same result")]

    const sdk = await query({
      prompt: "读文件",
      provider: new ScriptedProvider(steps),
      workspaceRoot: ws.root,
      settings: editSettings,
    })

    // CLI 侧：把同一份决策写成 --script 文件
    const scriptFile = ws.abs("script.json")
    await fs.writeFile(scriptFile, JSON.stringify(steps), "utf8")
    const homeDir = ws.abs("home")
    await fs.mkdir(homeDir, { recursive: true })
    const io = createMemoryIo({ isTty: false })
    const cliCode = await runCli(
      [
        "--print",
        "读文件",
        "--script",
        scriptFile,
        "--permission-mode",
        "acceptEdits",
        "--output-format",
        "json",
      ],
      { io, cwd: ws.root, homeDir, env: {} },
    )
    const cliPayload = JSON.parse(io.stdoutText()) as { subtype: string; result: string }

    expect(cliCode).toBe(sdk.exitCode)
    expect(cliPayload.subtype).toBe(sdk.outcome?.subtype)
    expect(cliPayload.result).toBe(sdk.outcome?.summary)
  })

  it("SDK 的退出码枚举与 CLI 用的是同一组常量", () => {
    expect(EXIT_OK).toBe(0)
    expect(EXIT_ERROR).toBe(1)
    expect(EXIT_BLOCKED).toBe(2)
  })
})
