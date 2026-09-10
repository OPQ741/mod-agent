/**
 * 主循环集成测试（agent-loop.md §2 / §6）。
 *
 * 这里**不 mock 循环本身**：真的建 runtime、真的建任务、真的跑工具、真的写文件。
 * 唯一被替换的是模型（ScriptedProvider 回放）与网络（无）。
 *
 * 覆盖的每一条分支都对应文档里的一条硬性纪律：
 * - 工具错误是数据不是异常 → 循环不断；
 * - 审批要"存下请求就退出"，不阻塞；
 * - 每轮落检查点，任何一轮可恢复；
 * - 预算 / 取消 / 进度守卫三个开关必须真的能停下循环。
 */

import { afterEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"

import {
  collect,
  createTempWorkspace,
  createTestRuntime,
  eventTypes,
  settingsWith,
  type TempWorkspace,
  type TestRuntime,
} from "./helpers.js"
import { ask, final, toolUse } from "../src/model/scripted.js"
import { driveTask, exitCodeFor, EXIT_BLOCKED, EXIT_ERROR, EXIT_OK } from "../src/runtime/driver.js"
import type { LoopOutcome } from "../src/runtime/loop.js"
import type { ModelRequest } from "../src/model/types.js"
import type { Settings } from "../src/config/settings.js"
import type { ScriptStep } from "../src/model/scripted.js"
import type { TaskEvent } from "../src/shared/contracts.js"
import type { ValidationCheck } from "../src/validation/runner.js"
import { DEFAULT_BUDGET } from "../src/shared/contracts.js"

const workspaces: TempWorkspace[] = []

afterEach(async () => {
  while (workspaces.length > 0) {
    const ws = workspaces.pop()
    if (ws) await ws.cleanup()
  }
})

/** 先建工作区：脚本里要用到 `ws.abs(...)` 拼绝对路径。 */
async function workspace(files?: Record<string, string>): Promise<TempWorkspace> {
  const ws = await createTempWorkspace()
  workspaces.push(ws)
  for (const [rel, content] of Object.entries(files ?? {})) {
    await ws.write(rel, content)
  }
  return ws
}

async function boot(options: {
  ws: TempWorkspace
  script: ScriptStep[]
  settings?: Settings
  hasTty?: boolean
  onRequest?: (request: ModelRequest, stepIndex: number) => void
  budget?: Partial<typeof DEFAULT_BUDGET>
  mode?: "ask" | "plan" | "edit" | "autopilot"
  now?: () => Date
  userRequest?: string
}): Promise<{ ws: TempWorkspace; runtime: TestRuntime; taskId: string }> {
  const { ws } = options
  const runtime = await createTestRuntime({
    workspace: ws,
    script: options.script,
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.hasTty !== undefined ? { hasTty: options.hasTty } : {}),
    ...(options.onRequest ? { onRequest: options.onRequest } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  const taskId = await runtime.createTask({
    title: "test task",
    userRequest: options.userRequest ?? "do the thing",
    mode: options.mode ?? options.settings?.mode ?? "edit",
    ...(options.budget ? { budget: options.budget } : {}),
  })
  return { ws, runtime, taskId }
}

/** 一条必然成功的验证命令：用 node 自身，任何机器都有。 */
function okCheck(cwd: string): ValidationCheck {
  return { id: "smoke", kind: "test", command: [process.execPath, "-e", "0"], required: true, cwd }
}

/** 一条必然失败的验证命令。 */
function failCheck(cwd: string): ValidationCheck {
  return {
    id: "smoke",
    kind: "test",
    command: [process.execPath, "-e", "process.exit(1)"],
    required: true,
    cwd,
  }
}

/** 第一次失败、之后通过的验证命令（用标记文件模拟"修好了"）。 */
function flakyCheck(marker: string, cwd: string): ValidationCheck {
  return {
    id: "flaky",
    kind: "test",
    command: [
      process.execPath,
      "-e",
      `const fs=require('fs');const p=${JSON.stringify(marker)};` +
        `if(fs.existsSync(p))process.exit(0);fs.writeFileSync(p,'done');process.exit(1);`,
    ],
    required: true,
    cwd,
  }
}

const commandArgs = (ws: TempWorkspace, variant = "") => ({
  executable: process.execPath,
  // 用 `--version` 而不是 `-e`：`node -e` 会被策略判为"无法静态解析"直接 deny，
  // 审批类用例需要的是一个会走到"问一次"的命令，`--version` 正好满足且跨平台。
  args: variant ? ["--version", variant] : ["--version"],
  cwd: ws.root,
  reason: "smoke test",
  timeoutMs: 120_000,
  networkProfile: "none" as const,
  onTimeout: "kill" as const,
})

/* ------------------------------------------------------------------ *
 * final 分支：验证与交付
 * ------------------------------------------------------------------ */

describe("主循环 · final 分支", () => {
  it("直接 final → completed/success，summary 与 turns 都进 outcome", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({ ws, script: [final("all done")] })
    const { events, outcome } = await collect(runtime.run(taskId))

    expect(outcome.status).toBe("completed")
    expect(outcome.subtype).toBe("success")
    expect(outcome.summary).toBe("all done")
    expect(outcome.turns).toBe(1)
    expect(outcome.changedFiles).toEqual([])
    expect(eventTypes(events)).toContain("task.completed")
    expect((await runtime.store.getTask(taskId))?.status).toBe("completed")
  })

  it("交付报告落盘为产物，且明确标注'没跑验证'而不是伪装成通过", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({ ws, script: [final("done")] })
    await collect(runtime.run(taskId))

    const artifacts = await runtime.store.listArtifacts(taskId)
    const report = artifacts.find((a) => a.kind === "delivery-report")
    expect(report).toBeDefined()
    const text = await fs.readFile(report!.uri, "utf8")
    expect(text).toContain("done")
    expect(text).toContain("No validation commands were run")
    expect(report!.uri.startsWith(ws.root)).toBe(true)
  })

  it("验证通过 → 经 validating 阶段 → completed，事件与报告都带真实退出码", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({ ws, script: [final("done")] })
    const { events, outcome } = await collect(
      runtime.run(taskId, { validationChecks: [okCheck(ws.root)] }),
    )

    expect(outcome.status).toBe("completed")
    expect(outcome.validation?.status).toBe("passed")
    expect(outcome.validation?.checks[0]?.exitCode).toBe(0)
    expect(eventTypes(events)).toContain("validation.started")
    expect(eventTypes(events)).toContain("validation.completed")
    const tos = events
      .filter((e) => e.type === "task.status_changed")
      .map((e) => (e.payload as { to: string }).to)
    expect(tos).toContain("validating")
  })

  it("验证失败 → 进 Repair Loop（不是照常交付），修复轮次用尽才判失败", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({
      ws,
      script: [final("attempt 1"), final("attempt 2"), final("attempt 3")],
      budget: { maxRepairRounds: 1 },
    })
    const { events, outcome } = await collect(
      runtime.run(taskId, { validationChecks: [failCheck(ws.root)] }),
    )

    const tos = events
      .filter((e) => e.type === "task.status_changed")
      .map((e) => (e.payload as { to: string }).to)
    expect(tos).toContain("repairing")
    expect(
      events.some(
        (e) =>
          e.type === "task.warning" &&
          (e.payload as { reason?: string }).reason === "validation_failed",
      ),
    ).toBe(true)

    expect(outcome.status).toBe("failed")
    expect(outcome.subtype).toBe("error_during_execution")
    expect(outcome.validation?.status).toBe("failed")
    expect(outcome.turns).toBe(2)

    // 模型必须看到失败证据，而不是只知道"没通过"
    const messages = await runtime.store.getMessages(taskId)
    expect(JSON.stringify(messages)).toContain("validation-failed")
  })

  it("修复后验证通过 → 交付成功（验证真的能救回来一次失败）", async () => {
    const ws = await workspace()
    const marker = ws.abs(".repair-marker")
    const { runtime, taskId } = await boot({
      ws,
      script: [final("attempt 1"), final("attempt 2")],
      budget: { maxRepairRounds: 2 },
    })
    const { outcome } = await collect(
      runtime.run(taskId, { validationChecks: [flakyCheck(marker, ws.root)] }),
    )

    expect(outcome.status).toBe("completed")
    expect(outcome.subtype).toBe("success")
    expect(outcome.validation?.status).toBe("passed")
    expect(outcome.turns).toBe(2)
    expect(await ws.exists(".repair-marker")).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * ask 分支
 * ------------------------------------------------------------------ */

describe("主循环 · ask 分支", () => {
  it("ask → paused / approval_required，并发出 clarification_required 警告", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({ ws, script: [ask("which file?")] })
    const { events, outcome } = await collect(runtime.run(taskId))

    expect(outcome.status).toBe("paused")
    expect(outcome.subtype).toBe("approval_required")
    expect(outcome.summary).toBe("which file?")
    const warning = events.find((e) => e.type === "task.warning")
    expect((warning?.payload as { reason?: string }).reason).toBe("clarification_required")
    expect((await runtime.store.getTask(taskId))?.status).toBe("paused")
  })
})

/* ------------------------------------------------------------------ *
 * 工具分支：成功 / 失败 / 权限
 * ------------------------------------------------------------------ */

describe("主循环 · 工具执行", () => {
  it("工具成功后把结果回灌给模型：第二轮请求里能看到上一轮的输出", async () => {
    const ws = await workspace({ "src/a.ts": "export const marker = 42\n" })
    const requests: ModelRequest[] = []
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("repo.read_file", { path: ws.abs("src/a.ts") }), final("read it")],
      onRequest: (req) => requests.push(req),
    })
    const { events, outcome } = await collect(runtime.run(taskId))

    expect(outcome.status).toBe("completed")
    const completed = events.find((e) => e.type === "tool.completed")
    expect((completed?.payload as { status: string }).status).toBe("succeeded")

    const serialized = JSON.stringify(requests[1]?.messages ?? [])
    expect(serialized).toContain("tool_result")
    expect(serialized).toContain("marker = 42")
  })

  it("工具失败是数据不是异常：未知工具 → failed 结果回喂，循环继续", async () => {
    const ws = await workspace()
    const requests: ModelRequest[] = []
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("does.not_exist", { x: 1 }), final("recovered")],
      onRequest: (req) => requests.push(req),
    })
    const { events, outcome } = await collect(runtime.run(taskId))

    expect(outcome.status).toBe("completed")
    expect(outcome.turns).toBe(2)
    const completed = events.find((e) => e.type === "tool.completed")
    expect((completed?.payload as { status: string }).status).toBe("failed")
    expect((completed?.payload as { errorCode?: string }).errorCode).toBe("TOOL_NOT_FOUND")
    expect(JSON.stringify(requests[1]?.messages ?? [])).toContain("TOOL_NOT_FOUND")
  })

  it("参数不合法 → TOOL_SCHEMA_INVALID，不掀翻循环", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("repo.read_file", {}), final("ok")],
    })
    const { events } = await collect(runtime.run(taskId))
    const completed = events.find((e) => e.type === "tool.completed")
    expect((completed?.payload as { errorCode?: string }).errorCode).toBe("TOOL_SCHEMA_INVALID")
  })

  it("权限拒绝计入 permissionDenials，且指标记为 deny", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("command.run", commandArgs(ws)), final("blocked")],
      // dontAsk：本该弹框的一律拒绝
      settings: settingsWith({ mode: "edit", permissionMode: "dontAsk" }),
      hasTty: true,
    })
    const { outcome } = await collect(runtime.run(taskId))
    expect(outcome.permissionDenials.length).toBeGreaterThan(0)
    expect(outcome.permissionDenials[0]?.toolName).toBe("command.run")
    expect(runtime.metrics.snapshot().counters["policy.decision.deny"]).toBeGreaterThan(0)
  })

  it("写文件端到端：落盘 + file.changed 事件 + changedFiles 进交付", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({
      ws,
      script: [
        toolUse("repo.write_file", { path: ws.abs("src/new.ts"), content: "export const a = 1\n" }),
        final("created"),
      ],
      settings: settingsWith({ mode: "edit", permissionMode: "acceptEdits" }),
    })
    const { events, outcome } = await collect(runtime.run(taskId))

    expect(await ws.read("src/new.ts")).toBe("export const a = 1\n")
    expect(outcome.changedFiles.some((f) => f.includes("new.ts"))).toBe(true)
    expect(events.some((e) => e.type === "file.changed")).toBe(true)
  })

  it("read-before-edit：没读就改会被挡下（文件保持原样）", async () => {
    const ws = await workspace({ "src/a.ts": "const a = 1\n" })
    const { runtime, taskId } = await boot({
      ws,
      script: [
        toolUse("repo.edit_file", { path: ws.abs("src/a.ts"), oldString: "a", newString: "b" }),
        final("edited"),
      ],
      settings: settingsWith({ mode: "edit", permissionMode: "acceptEdits" }),
    })
    const { events } = await collect(runtime.run(taskId))
    const completed = events.find((e) => e.type === "tool.completed")
    expect((completed?.payload as { status: string }).status).toBe("failed")
    expect(await ws.read("src/a.ts")).toBe("const a = 1\n")
  })

  it("先读再改：编辑成功且文件真的变了", async () => {
    const ws = await workspace({ "src/a.ts": "const a = 1\n" })
    const { runtime, taskId } = await boot({
      ws,
      script: [
        toolUse("repo.read_file", { path: ws.abs("src/a.ts") }),
        toolUse("repo.edit_file", {
          path: ws.abs("src/a.ts"),
          oldString: "const a = 1",
          newString: "const a = 2",
        }),
        final("edited"),
      ],
      settings: settingsWith({ mode: "edit", permissionMode: "acceptEdits" }),
    })
    const { events } = await collect(runtime.run(taskId))
    const edit = events.find(
      (e) =>
        e.type === "tool.completed" && (e.payload as { tool: string }).tool === "repo.edit_file",
    )
    expect((edit?.payload as { status: string }).status).toBe("succeeded")
    expect(await ws.read("src/a.ts")).toBe("const a = 2\n")
  })

  it("工具调用记录会开合：成功后闭合，不留在未闭合状态", async () => {
    const ws = await workspace({ "src/a.ts": "x\n" })
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("repo.read_file", { path: ws.abs("src/a.ts") }), final("ok")],
    })
    await collect(runtime.run(taskId))
    expect(await runtime.store.openToolCalls(taskId)).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * 长命令增量输出（tool.progress）
 * ------------------------------------------------------------------ */

describe("主循环 · tool.progress", () => {
  it("长命令执行期间就有进度事件，不是等命令结束才补发", async () => {
    const ws = await workspace({
      // 逐行打印 + 间隔：让执行跨越至少一个 flush tick（200ms）
      "scripts/chatty.js":
        "const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));\n" +
        "(async()=>{console.log('step-1');await sleep(150);" +
        "console.log('step-2');await sleep(150);console.log('step-3');})();\n",
    })
    const { runtime, taskId } = await boot({
      ws,
      script: [
        toolUse("command.run", {
          executable: process.execPath,
          // 不用 `-e`：那种形状会被策略判为"不可静态解析"而 deny，与本节无关
          args: [ws.abs("scripts/chatty.js")],
          cwd: ws.root,
          reason: "watch incremental output",
          timeoutMs: 30_000,
          networkProfile: "none",
          onTimeout: "kill",
        }),
        final("watched"),
      ],
      // 绕过审批，专注进度事件本身
      settings: settingsWith({ mode: "edit", permissionMode: "bypassPermissions" }),
    })

    const { events, outcome } = await collect(runtime.run(taskId))
    expect(outcome.status).toBe("completed")

    const progress = events.filter((e) => e.type === "tool.progress")
    expect(progress.length).toBeGreaterThan(0)
    const joined = progress
      .map((e) => String((e.payload as { text?: unknown }).text ?? ""))
      .join("")
    expect(joined).toContain("step-1")
    // 进度事件必须挂在这次调用上，而不是一条无主日志
    expect((progress[0]?.payload as { tool?: string }).tool).toBe("command.run")
    expect((progress[0]?.payload as { callId?: string }).callId).toBeTruthy()

    // 完整结果仍然只走 tool.completed
    const completed = events.find((e) => e.type === "tool.completed")
    expect((completed?.payload as { status?: string }).status).toBe("succeeded")
  })

  it("不声明 streamsOutput 的工具不产生进度事件（只读调用不白等 tick）", async () => {
    const ws = await workspace({ "src/a.ts": "x\n" })
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("repo.read_file", { path: ws.abs("src/a.ts") }), final("ok")],
    })
    const { events } = await collect(runtime.run(taskId))
    expect(events.some((e) => e.type === "tool.progress")).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * 审批
 * ------------------------------------------------------------------ */

describe("主循环 · 审批分支", () => {
  it("需要审批时：存下请求、转 awaiting_approval、发事件，然后**退出**不阻塞", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("command.run", commandArgs(ws))],
      settings: settingsWith({ mode: "edit", permissionMode: "default" }),
      hasTty: true,
    })
    const { events, outcome } = await collect(runtime.run(taskId))

    expect(outcome.status).toBe("awaiting_approval")
    expect(outcome.subtype).toBe("approval_required")

    const required = events.find((e) => e.type === "approval.required")
    expect(required).toBeDefined()
    const payload = required!.payload as { approvalId: string; tool: string; parameterHash: string }
    expect(payload.tool).toBe("command.run")
    expect(payload.parameterHash.length).toBeGreaterThan(0)

    const approval = await runtime.store.getApproval(payload.approvalId)
    expect(approval?.status).toBe("pending")
    expect(approval?.toolName).toBe("command.run")
    expect(approval?.policyVersion).toBe(runtime.policyVersion())

    // 检查点必须落在这个状态上，否则恢复方不知道自己停在审批点
    expect((await runtime.store.latestCheckpoint(taskId))?.status).toBe("awaiting_approval")

    // 未闭合的非幂等调用留着，恢复时才能标 outcome_unknown
    const open = await runtime.store.openToolCalls(taskId)
    expect(open.length).toBe(1)
    expect(open[0]?.idempotency).toBe("non_idempotent")
  })

  it("批准后恢复：driver 一路驱动到完成，退出码 0，命令真的执行了", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("command.run", commandArgs(ws))],
      settings: settingsWith({ mode: "edit", permissionMode: "default" }),
      hasTty: true,
    })
    // 审批之后模型接着跑：重放同一条命令（这次已获会话放行），再 final
    runtime.provider.append(toolUse("command.run", commandArgs(ws)), final("done after approval"))

    const seen: TaskEvent[] = []
    const result = await driveTask(runtime, taskId, {
      onEvent: (e) => seen.push(e),
      resolveApproval: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
        return { decision: "allowed", by: "tester" }
      },
    })

    expect(result.exitCode).toBe(EXIT_OK)
    expect(result.outcome?.status).toBe("completed")
    // 等审批的时间要落进指标：这是用户等待的真实成本，不能只算模型耗时。
    const blocked = result.metrics.timings["approval.blocked_ms"]
    expect(blocked?.count).toBe(1)
    expect(blocked?.totalMs).toBeGreaterThanOrEqual(20)
    const stored = await runtime.store.readAllEvents(taskId)
    expect(stored.some((e) => e.type === "approval.decided")).toBe(true)
    expect(seen.some((e) => e.type === "task.completed")).toBe(true)
    const messages = await runtime.store.getMessages(taskId)
    expect(JSON.stringify(messages)).toContain(process.version)
  })

  it("拒绝审批 → 停在审批点，退出码 2（被人挡住，不是失败）", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("command.run", commandArgs(ws))],
      settings: settingsWith({ mode: "edit", permissionMode: "default" }),
      hasTty: true,
    })
    const result = await driveTask(runtime, taskId, {
      resolveApproval: async () => ({ decision: "denied", by: "tester" }),
    })
    expect(result.exitCode).toBe(EXIT_BLOCKED)
    expect(result.pendingApproval).toBeDefined()
    expect(result.outcome?.subtype).toBe("approval_required")
  })

  it("不给审批求解器 = fail-closed：无人值守默认不许做", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("command.run", commandArgs(ws, "SHOULD-NOT-RUN"))],
      settings: settingsWith({ mode: "edit", permissionMode: "default" }),
      hasTty: true,
    })
    const seen: TaskEvent[] = []
    const result = await driveTask(runtime, taskId, { onEvent: (e) => seen.push(e) })
    expect(result.exitCode).toBe(EXIT_BLOCKED)
    expect(result.pendingApproval?.tool).toBe("command.run")
    expect(result.outcome?.status).toBe("awaiting_approval")
    expect(
      seen.some(
        (e) =>
          e.type === "tool.completed" && (e.payload as { status: string }).status === "succeeded",
      ),
    ).toBe(false)
  })

  it("连续审批轮次到上限就停手，不把人耗死", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("command.run", commandArgs(ws))],
      settings: settingsWith({ mode: "edit", permissionMode: "default" }),
      hasTty: true,
    })
    // 补两步：每次参数都要不同（批准是按参数哈希记的，同参数第二次会被会话放行表放过），
    // 让第 3 次真的撞上审批上限
    runtime.provider.append(
      toolUse("command.run", commandArgs(ws, "exit0")),
      toolUse("command.run", commandArgs(ws, "exit1")),
    )
    let asked = 0
    const result = await driveTask(runtime, taskId, {
      maxApprovalRounds: 2,
      resolveApproval: async () => {
        asked += 1
        return { decision: "allowed", by: "tester" }
      },
    })
    expect(asked).toBeLessThanOrEqual(2)
    expect(result.exitCode).toBe(EXIT_BLOCKED)
  })

  it("审批绑定参数：换参数必须重新问，参数哈希对不上直接报错", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("command.run", commandArgs(ws))],
      settings: settingsWith({ mode: "edit", permissionMode: "default" }),
      hasTty: true,
    })
    const { events } = await collect(runtime.run(taskId))
    const payload = events.find((e) => e.type === "approval.required")!.payload as {
      approvalId: string
      parameterHash: string
    }

    await runtime.decideApproval(payload.approvalId, "allowed", "tester")
    expect(await runtime.isApproved("command.run", commandArgs(ws))).toBe(true)
    // 参数一变就不算批过
    expect(await runtime.isApproved("command.run", commandArgs(ws, "1"))).toBe(false)

    // 用错误的哈希去批准 → 拒绝
    await expect(
      runtime.decideApproval(payload.approvalId, "allowed", "tester", {
        parameterHash: "deadbeef",
      }),
    ).rejects.toThrow(/Parameter hash mismatch/)
  })

  it("审批过期后不再生效：决策返回 expired，会话放行表也不会被写入", async () => {
    const ws = await workspace()
    // 从"现在"起步：预算按墙钟计时，时钟倒拨会被判成 BUDGET_EXCEEDED
    let clock = new Date()
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("command.run", commandArgs(ws))],
      settings: settingsWith({ mode: "edit", permissionMode: "default" }),
      hasTty: true,
      now: () => clock,
    })
    const { events } = await collect(runtime.run(taskId))
    const payload = events.find((e) => e.type === "approval.required")!.payload as {
      approvalId: string
    }

    // 30 分钟 TTL 已过：批准必须失效，而不是"后台没清理所以还能批"
    clock = new Date(clock.getTime() + 31 * 60_000)
    expect(await runtime.decideApproval(payload.approvalId, "allowed", "tester")).toBe("expired")
    expect(await runtime.store.getApproval(payload.approvalId)).toMatchObject({
      status: "expired",
    })
    expect(await runtime.isApproved("command.run", commandArgs(ws))).toBe(false)
  })

  it("driver：用户过期后才点允许 → 停在审批点，不恢复执行", async () => {
    const ws = await workspace()
    // 从"现在"起步：预算按墙钟计时，时钟倒拨会被判成 BUDGET_EXCEEDED
    let clock = new Date()
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("command.run", commandArgs(ws))],
      settings: settingsWith({ mode: "edit", permissionMode: "default" }),
      hasTty: true,
      now: () => clock,
    })
    const result = await driveTask(runtime, taskId, {
      resolveApproval: async () => {
        // 模拟"用户第二天才回来点允许"
        clock = new Date(clock.getTime() + 24 * 60 * 60_000)
        return { decision: "allowed", by: "tester" }
      },
    })
    expect(result.exitCode).toBe(EXIT_BLOCKED)
    expect(result.outcome?.status).toBe("awaiting_approval")
    expect(await runtime.isApproved("command.run", commandArgs(ws))).toBe(false)
  })

  it("resume 会清掉过期审批：pending 不会一直挂在库里", async () => {
    const ws = await workspace()
    let clock = new Date()
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("command.run", commandArgs(ws))],
      settings: settingsWith({ mode: "edit", permissionMode: "default" }),
      hasTty: true,
      now: () => clock,
    })
    const { events } = await collect(runtime.run(taskId))
    const payload = events.find((e) => e.type === "approval.required")!.payload as {
      approvalId: string
    }

    clock = new Date(clock.getTime() + 31 * 60_000)
    await runtime.resume(taskId)
    expect((await runtime.store.getApproval(payload.approvalId))?.status).toBe("expired")
  })

  it("退出码映射：success→0，失败→1，取消/审批→2", () => {
    const outcome = (subtype: LoopOutcome["subtype"]): LoopOutcome => ({
      status: "completed",
      subtype,
      turns: 1,
      permissionDenials: [],
      changedFiles: [],
    })
    expect(exitCodeFor(outcome("success"), false)).toBe(EXIT_OK)
    expect(exitCodeFor(outcome("error_during_execution"), false)).toBe(EXIT_ERROR)
    expect(exitCodeFor(outcome("error_max_turns"), false)).toBe(EXIT_ERROR)
    expect(exitCodeFor(outcome("cancelled"), false)).toBe(EXIT_BLOCKED)
    expect(exitCodeFor(outcome("approval_required"), false)).toBe(EXIT_BLOCKED)
    expect(exitCodeFor(outcome("success"), true)).toBe(EXIT_BLOCKED)
    expect(exitCodeFor(undefined, false)).toBe(EXIT_ERROR)
  })
})

/* ------------------------------------------------------------------ *
 * 三个刹车：取消 / 预算 / 进度守卫
 * ------------------------------------------------------------------ */

describe("主循环 · 终止条件", () => {
  it("中断信号 → cancelled，退出码 2", async () => {
    const ws = await workspace({ "src/a.ts": "x\n" })
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("repo.read_file", { path: ws.abs("src/a.ts") }), final("never")],
    })
    const controller = new AbortController()
    controller.abort()
    const { outcome } = await collect(runtime.run(taskId, { signal: controller.signal }))
    expect(outcome.status).toBe("cancelled")
    expect(outcome.subtype).toBe("cancelled")
    expect(exitCodeFor(outcome, false)).toBe(EXIT_BLOCKED)
  })

  it("cancelRequestedAt 落库后，下一轮入口就退出（不靠工具自觉检查信号）", async () => {
    const ws = await workspace({ "src/a.ts": "x\n" })
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("repo.read_file", { path: ws.abs("src/a.ts") }), final("never")],
    })
    const state = await runtime.store.getTask(taskId)
    await runtime.store.updateTask(
      taskId,
      { cancelRequestedAt: new Date().toISOString() },
      state!.stateVersion,
    )
    const { outcome } = await collect(runtime.run(taskId))
    expect(outcome.status).toBe("cancelled")
  })

  it("预算：轮次用尽 → expired / error_max_turns", async () => {
    const ws = await workspace({ "src/a.ts": "x\n" })
    const { runtime, taskId } = await boot({
      ws,
      script: [
        toolUse("repo.read_file", { path: ws.abs("src/a.ts") }),
        toolUse("repo.read_file", { path: ws.abs("src/a.ts") }),
        final("never"),
      ],
      budget: { maxRounds: 1 },
    })
    const { events, outcome } = await collect(runtime.run(taskId))
    expect(outcome.status).toBe("expired")
    expect(outcome.subtype).toBe("error_max_turns")
    expect(events.some((e) => e.type === "task.failed")).toBe(true)
  })

  it("预算：成本用尽 → failed / error_max_budget_usd", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({ ws, script: [final("never")] })
    const state = await runtime.store.getTask(taskId)
    await runtime.store.updateTask(
      taskId,
      { usage: { ...state!.usage, costUsd: state!.budget.maxCostUsd } },
      state!.stateVersion,
    )
    const { outcome } = await collect(runtime.run(taskId))
    expect(outcome.status).toBe("failed")
    expect(outcome.subtype).toBe("error_max_budget_usd")
  })

  it("进度守卫：连续三次同参数同结果 → 压缩成诊断回喂模型，循环继续", async () => {
    const ws = await workspace({ "src/a.ts": "same\n" })
    const requests: ModelRequest[] = []
    const { runtime, taskId } = await boot({
      ws,
      script: [
        toolUse("repo.read_file", { path: ws.abs("src/a.ts") }),
        toolUse("repo.read_file", { path: ws.abs("src/a.ts") }),
        toolUse("repo.read_file", { path: ws.abs("src/a.ts") }),
        final("changed approach"),
      ],
      onRequest: (req) => requests.push(req),
    })
    const { events, outcome } = await collect(runtime.run(taskId))

    const warning = events.find(
      (e) =>
        e.type === "task.warning" &&
        (e.payload as { reason?: string }).reason === "no_progress_compressed",
    )
    expect(warning).toBeDefined()
    expect(outcome.status).toBe("completed")
    const serialized = JSON.stringify(requests[3]?.messages ?? [])
    expect(serialized).toContain("progress-guard")
    expect(serialized).toContain("Recent steps:")
  })

  it("进度守卫：同一错误复发到上限 → failed / error_no_progress（停手等人）", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({
      ws,
      script: [
        toolUse("does.not_exist", { a: 1 }),
        toolUse("does.not_exist", { a: 2 }),
        toolUse("does.not_exist", { a: 3 }),
        final("never"),
      ],
      budget: { maxNoProgressRounds: 9 },
    })
    const { events, outcome } = await collect(runtime.run(taskId))
    expect(outcome.status).toBe("failed")
    expect(outcome.subtype).toBe("error_no_progress")
    expect(
      events.some(
        (e) =>
          e.type === "task.warning" && (e.payload as { reason?: string }).reason === "no_progress",
      ),
    ).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * 检查点与恢复
 * ------------------------------------------------------------------ */

describe("主循环 · 检查点与恢复", () => {
  it("每轮结束落检查点，version 单调递增", async () => {
    const ws = await workspace({ "src/a.ts": "a\n", "src/b.ts": "b\n" })
    const { runtime, taskId } = await boot({
      ws,
      script: [
        toolUse("repo.read_file", { path: ws.abs("src/a.ts") }),
        toolUse("repo.read_file", { path: ws.abs("src/b.ts") }),
        final("done"),
      ],
    })
    const { events } = await collect(runtime.run(taskId))
    const versions = events
      .filter((e) => e.type === "checkpoint.created")
      .map((e) => (e.payload as { version: number }).version)
    expect(versions.length).toBeGreaterThanOrEqual(2)
    expect(versions).toEqual([...versions].sort((x, y) => x - y))
  })

  it("事件 seq 严格递增且唯一（(task_id, seq) 是唯一约束）", async () => {
    const ws = await workspace({ "src/a.ts": "a\n" })
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("repo.read_file", { path: ws.abs("src/a.ts") }), final("done")],
    })
    await collect(runtime.run(taskId))
    const events = await runtime.store.readAllEvents(taskId)
    const seqs = events.map((e) => e.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
  })

  it("恢复时非幂等的未闭合调用被标 outcome_unknown，只读调用保留", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("command.run", commandArgs(ws))],
      settings: settingsWith({ mode: "edit", permissionMode: "default" }),
      hasTty: true,
    })
    await collect(runtime.run(taskId))

    await runtime.store.startToolCall({
      id: "call_read_only",
      taskId,
      toolName: "repo.read_file",
      inputHash: "h",
      idempotencyKey: "k",
      idempotency: "safe",
      status: "started",
      startedAt: new Date().toISOString(),
      retryCount: 0,
    })

    const result = await runtime.resume(taskId)
    expect(result.resumed).toBe(true)
    expect(result.unknownOutcomes.length).toBe(1)
    expect((await runtime.store.openToolCalls(taskId)).map((c) => c.id)).toEqual(["call_read_only"])
    expect((await runtime.store.getTask(taskId))?.status).toBe("queued")
  })

  it("不可恢复的状态拒绝 resume（completed 的任务不能被复活重跑）", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({ ws, script: [final("done")] })
    await collect(runtime.run(taskId))
    await expect(runtime.resume(taskId)).rejects.toThrow(/cannot be resumed/)
  })

  it("恢复续跑不丢上下文：用户原始请求与已改动文件都还在", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({
      ws,
      script: [
        toolUse("repo.write_file", {
          path: ws.abs("src/keep.ts"),
          content: "export const k = 1\n",
        }),
        toolUse("command.run", commandArgs(ws)),
      ],
      // acceptEdits：文件写入放行，命令仍需审批 —— 审批点只出现在命令上
      settings: settingsWith({ mode: "edit", permissionMode: "acceptEdits" }),
      hasTty: true,
    })
    runtime.provider.append(final("finished after resume"))

    const first = await collect(runtime.run(taskId))
    expect(first.outcome.status).toBe("awaiting_approval")

    await runtime.resume(taskId)
    const second = await collect(runtime.run(taskId))

    expect(second.outcome.status).toBe("completed")
    expect(second.outcome.changedFiles.some((f) => f.includes("keep.ts"))).toBe(true)
    expect(JSON.stringify(await runtime.store.getMessages(taskId))).toContain("do the thing")
  })

  it("规则提醒只注入一次：多次 run 不会攒出 N 份 AGENTS.md", async () => {
    const ws = await workspace({ "AGENTS.md": "# 项目规则\n\n- 用 pnpm\n" })
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("repo.read_file", { path: ws.abs("AGENTS.md") }), final("x")],
    })
    await collect(runtime.run(taskId))
    const count = async (): Promise<number> =>
      (await runtime.store.getMessages(taskId)).filter(
        (m) => typeof m.content === "string" && m.content.includes("项目规则"),
      ).length
    const afterFirst = await count()

    await runtime.store.updateTask(
      taskId,
      { status: "paused" },
      (await runtime.store.getTask(taskId))!.stateVersion,
    )
    await runtime.resume(taskId)
    runtime.provider.append(final("y"))
    await collect(runtime.run(taskId))

    expect(afterFirst).toBe(1)
    expect(await count()).toBe(1)
  })

  it("项目技能只注入索引；激活并调用后才回灌正文一次", async () => {
    const ws = await workspace({
      ".mod/skills/release/SKILL.md": [
        "---",
        "name: release-checklist",
        "description: Cut a release safely",
        "when: user asks to release",
        "---",
        "",
        "RELEASE BODY: run the checklist before tagging",
      ].join("\n"),
    })
    const requests: ModelRequest[] = []
    const { runtime, taskId } = await boot({
      ws,
      script: [
        toolUse("tool_search", { query: "release" }),
        toolUse("skill.release-checklist", {}),
        final("ok"),
      ],
      onRequest: (request) => requests.push(request),
    })
    await collect(runtime.run(taskId))

    const firstRequest = String(requests[0]?.system ?? "")
    // 索引在：模型知道有这个技能，也知道该什么时候用
    expect(firstRequest).toContain("release-checklist")
    expect(firstRequest).toContain("Cut a release safely")
    // 正文不在：没有激活就不该付这份上下文成本
    expect(firstRequest).not.toContain("RELEASE BODY")

    const messages = await runtime.store.getMessages(taskId)
    const occurrences = JSON.stringify(messages).split("RELEASE BODY").length - 1
    expect(occurrences).toBe(1)
  })

  it("请求点名了子目录文件时，就近的 AGENTS.md 也会进规则（不是只读根规则）", async () => {
    const ws = await workspace({
      "src/AGENTS.md": "# src 规则\n\n- 改动必须带测试\n",
      "AGENTS.md": "# 根规则\n\n- 提交信息用 Conventional Commits\n",
    })
    const { runtime, taskId } = await boot({
      ws,
      script: [final("ok")],
      userRequest: "请修改 src/app.ts 里的解析逻辑",
    })
    await collect(runtime.run(taskId))
    const messages = JSON.stringify(await runtime.store.getMessages(taskId))
    // 从根到目标目录逐级拼接，近处排在后面
    expect(messages).toContain("提交信息用 Conventional Commits")
    expect(messages).toContain("改动必须带测试")
  })
})

/* ------------------------------------------------------------------ *
 * 任务模式约束
 * ------------------------------------------------------------------ */

describe("主循环 · 任务模式", () => {
  it("plan 模式下写工具被拒：只读契约由策略层兜住，不靠模型自觉", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({
      ws,
      script: [
        toolUse("repo.write_file", { path: ws.abs("src/x.ts"), content: "x\n" }),
        final("should not write"),
      ],
      settings: settingsWith({ mode: "plan", permissionMode: "bypassPermissions" }),
      mode: "plan",
    })
    const { outcome } = await collect(runtime.run(taskId))
    expect(outcome.permissionDenials.length).toBeGreaterThan(0)
    expect(await ws.exists("src/x.ts")).toBe(false)
  })

  it("plan 模式提交计划后：计划落检查点、未完成步骤进每轮上下文", async () => {
    const ws = await workspace()
    const requests: ModelRequest[] = []
    const plan = {
      summary: "split the parser and cover it",
      assumptions: [],
      steps: [
        {
          id: "s1",
          objective: "extract parseStep",
          filesLikelyAffected: ["src/parser.ts"],
          toolsAllowed: ["repo.edit_file"],
          dependencies: [],
          doneWhen: ["parser tests pass"],
          risk: "low",
        },
      ],
      validation: [],
      requiresApproval: false,
    }
    const { runtime, taskId } = await boot({
      ws,
      script: [
        toolUse("tool_search", { query: "plan" }),
        toolUse("plan.enter_plan_mode", { reason: "multi-file change" }),
        toolUse("plan.exit_plan_mode", { plan }),
        final("done"),
      ],
      settings: settingsWith({ permissionMode: "bypassPermissions" }),
      onRequest: (request) => requests.push(request),
    })
    const { outcome, events } = await collect(runtime.run(taskId))
    expect(outcome.status).toBe("completed")

    // 1) 检查点里必须有计划正文：否则进程退出后 --resume 就丢计划。
    const latest = await runtime.store.latestCheckpoint(taskId)
    expect(latest?.plan?.steps.map((step) => step.id)).toEqual(["s1"])
    expect(latest?.completedStepIds).toEqual([])

    // 计划必须真的落成一个人能打开的文件，而不是只活在事件与数据库里
    const planText = await fs.readFile(ws.abs(`.mod/plans/${taskId}.md`), "utf8")
    expect(planText).toContain("状态：已提交")
    expect(planText).toContain("s1：extract parseStep")
    expect(planText).toContain("完成标准：parser tests pass")

    // 2) 提交后的第一轮请求就带上待办步骤（模型不必回头翻历史工具调用）。
    const lastRequest = requests.at(-1)
    const afterSubmit = String(
      lastRequest?.messages.map((message) => String(message.content)).join("\n") ?? "",
    )
    expect(afterSubmit).toContain("pending-steps: s1: extract parseStep")
    // 提交前（第一轮）不能凭空出现计划步骤。
    expect(
      String(requests[0]?.messages.map((message) => String(message.content)).join("\n") ?? ""),
    ).not.toContain("pending-steps:")

    // 3) 事件流仍要留下可审计的 plan_ready。
    expect(eventTypes(events)).toContain("task.plan_ready")
    const ready = events.find((event) => event.type === "task.plan_ready")
    const payload = ready?.payload as { steps?: number; planFilePath?: string } | undefined
    expect(payload?.steps).toBe(1)
    expect(payload?.planFilePath).toContain(`${taskId}.md`)
  })

  it("ask 模式同样是只读", async () => {
    const ws = await workspace()
    const { runtime, taskId } = await boot({
      ws,
      script: [
        toolUse("repo.write_file", { path: ws.abs("src/x.ts"), content: "x\n" }),
        final("nope"),
      ],
      settings: settingsWith({ mode: "ask", permissionMode: "bypassPermissions" }),
      mode: "ask",
    })
    const { outcome } = await collect(runtime.run(taskId))
    expect(outcome.permissionDenials.length).toBeGreaterThan(0)
    expect(await ws.exists("src/x.ts")).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * 上下文压缩
 * ------------------------------------------------------------------ */

describe("主循环 · 上下文压缩", () => {
  it("开启压缩且超阈值 → 发 context_compacted 警告，任务照常完成", async () => {
    const ws = await workspace({ "big.ts": "x\n".repeat(4_000) })
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("repo.read_file", { path: ws.abs("big.ts") }), final("done")],
      settings: settingsWith({
        mode: "edit",
        limits: { contextWindowTokens: 1_000, compactionThreshold: 0.1 },
      }),
    })
    const { events, outcome } = await collect(runtime.run(taskId, { compactionEnabled: true }))
    expect(outcome.status).toBe("completed")
    expect(
      events.some(
        (e) =>
          e.type === "task.warning" &&
          (e.payload as { reason?: string }).reason === "context_compacted",
      ),
    ).toBe(true)
    expect(runtime.metrics.snapshot().counters["context.compaction"]).toBeGreaterThanOrEqual(1)
  })

  it("关闭压缩时不发警告", async () => {
    const ws = await workspace({ "big.ts": "x\n".repeat(4_000) })
    const { runtime, taskId } = await boot({
      ws,
      script: [toolUse("repo.read_file", { path: ws.abs("big.ts") }), final("done")],
      settings: settingsWith({
        mode: "edit",
        limits: { contextWindowTokens: 1_000, compactionThreshold: 0.1 },
      }),
    })
    const { events } = await collect(runtime.run(taskId, { compactionEnabled: false }))
    expect(
      events.some(
        (e) =>
          e.type === "task.warning" &&
          (e.payload as { reason?: string }).reason === "context_compacted",
      ),
    ).toBe(false)
  })
})
