/**
 * 回归测试：每一个用例对应一个**真实发生过的缺陷**。
 *
 * 这些用例的共同点是"旧实现能跑通、测试也是绿的，但行为是错的"——
 * 要么静默丢数据，要么静默改坏文件，要么配置根本不生效。
 * 因此每个用例都断言**用户可观察的后果**，而不是内部实现细节：
 * 库里存了什么状态、模型到底收到了什么、磁盘上的文件变成了什么样。
 */

import { afterEach, describe, expect, it } from "vitest"
import { statSync } from "node:fs"

import {
  collect,
  createTempWorkspace,
  createTestRuntime,
  eventTypes,
  makePathGuard,
  makeToolContext,
  settingsWith,
  type TempWorkspace,
} from "./helpers.js"
import { final, toolUse } from "../src/model/scripted.js"
import { driveTask } from "../src/runtime/driver.js"
import { EditEngine } from "../src/patch/edit.js"
import { createWriteFileTool } from "../src/tools/builtin/edit.js"
import { createTestRunTool, discoverChecks } from "../src/tools/builtin/command.js"
import type { ModelRequest } from "../src/model/types.js"
import type { TaskEvent } from "../src/shared/contracts.js"

const workspaces: TempWorkspace[] = []

afterEach(async () => {
  while (workspaces.length > 0) {
    const ws = workspaces.pop()
    if (ws) await ws.cleanup()
  }
})

async function workspace(files: Record<string, string> = {}): Promise<TempWorkspace> {
  const ws = await createTempWorkspace()
  workspaces.push(ws)
  for (const [rel, content] of Object.entries(files)) {
    await ws.write(rel, content)
  }
  return ws
}

function reasons(events: ReadonlyArray<TaskEvent>): string[] {
  return events
    .filter((event) => event.type === "task.warning")
    .map((event) => String((event.payload as { reason?: unknown }).reason ?? ""))
}

/* ------------------------------------------------------------------ *
 * ① 取消：内存说 cancelled，库里必须也是 cancelled
 * ------------------------------------------------------------------ */

describe("回归 · 取消路径的状态落库", () => {
  it("中断后数据库状态是 cancelled，而不是卡在 executing", async () => {
    const ws = await workspace({ "src/a.ts": "x\n" })
    const runtime = await createTestRuntime({
      workspace: ws,
      script: [final("never")],
      settings: settingsWith({}),
    })
    const taskId = await runtime.createTask({ title: "t", userRequest: "do it", mode: "edit" })

    const controller = new AbortController()
    controller.abort()
    const { events, outcome } = await collect(runtime.run(taskId, { signal: controller.signal }))

    expect(outcome.status).toBe("cancelled")
    // 关键断言：库里的状态。旧实现只改内存，库永远停在 executing，
    // 于是 `--continue` 会把一个已取消的任务当成"可恢复"重新跑一遍。
    const persisted = await runtime.store.getTask(taskId)
    expect(persisted?.status).toBe("cancelled")
    // 状态机要求经 cancelling 中转，事件流里必须看得到这一步
    expect(eventTypes(events)).toContain("task.status_changed")
    const toCancelling = events.some(
      (event) =>
        event.type === "task.status_changed" &&
        (event.payload as { to?: string }).to === "cancelling",
    )
    expect(toCancelling).toBe(true)
  })

  it("cancelRequestedAt 落库后同样把终态写进库", async () => {
    const ws = await workspace({ "src/a.ts": "x\n" })
    const runtime = await createTestRuntime({ workspace: ws, script: [final("never")] })
    const taskId = await runtime.createTask({ title: "t", userRequest: "do it", mode: "edit" })
    const state = await runtime.store.getTask(taskId)
    await runtime.store.updateTask(
      taskId,
      { cancelRequestedAt: new Date().toISOString() },
      state!.stateVersion,
    )

    const { outcome } = await collect(runtime.run(taskId))
    expect(outcome.status).toBe("cancelled")
    expect((await runtime.store.getTask(taskId))?.status).toBe("cancelled")
  })
})

/* ------------------------------------------------------------------ *
 * ② 项目规则：不能把用户请求挤掉
 * ------------------------------------------------------------------ */

describe("回归 · 项目规则与用户请求共存", () => {
  it("仓库有 AGENTS.md 时，模型仍能看到用户请求（规则不得顶掉种子消息）", async () => {
    const ws = await workspace({ "AGENTS.md": "# rules\n\n- 提交信息用中文\n" })
    const requests: ModelRequest[] = []
    const runtime = await createTestRuntime({
      workspace: ws,
      script: [final("done")],
      onRequest: (request) => requests.push(request),
    })
    const taskId = await runtime.createTask({
      title: "t",
      userRequest: "把 README 里的错别字改掉",
      mode: "edit",
    })

    await collect(runtime.run(taskId))

    const sent = JSON.stringify(requests[0]?.messages ?? [])
    // 旧实现把规则先写进 store，循环因此判定"不是全新任务"，
    // 用户请求永远不会被 seed —— 模型只看到规则，压根不知道要做什么。
    expect(sent).toContain("错别字")
    expect(sent).toContain("project-rules")
  })

  it("skipProjectRules 一路透传到循环：规则不出现，用户请求仍在", async () => {
    const ws = await workspace({ "AGENTS.md": "# rules\n\n- 提交信息用中文\n" })
    const requests: ModelRequest[] = []
    const runtime = await createTestRuntime({
      workspace: ws,
      script: [final("done")],
      onRequest: (request) => requests.push(request),
    })
    const taskId = await runtime.createTask({ title: "t", userRequest: "改个错别字", mode: "edit" })

    // 走 driveTask 而不是 runtime.run：`--bare` 断在 driver → run 这一跳上，
    // 只测 runtime.run 是测不出来的。
    await driveTask(runtime, taskId, { skipProjectRules: true })

    const sent = JSON.stringify(requests[0]?.messages ?? [])
    expect(sent).toContain("错别字")
    expect(sent).not.toContain("project-rules")
  })
})

/* ------------------------------------------------------------------ *
 * ③ 编辑：排版字符不得让下标错位
 * ------------------------------------------------------------------ */

describe("回归 · 含破折号的文件编辑", () => {
  it("文件里有 —— 时，替换必须落在正确位置，不能把上下文一起吃掉", async () => {
    const ws = await workspace()
    const content = "# 标题\n\n这是一段说明——后面还有内容。\nTODO: fix me\n"
    const file = await ws.write("doc.md", content)

    const engine = new EditEngine()
    engine.recordRead(file, statSync(file).mtimeMs, content)
    const outcome = await engine.replace({ path: file, oldString: "fix me", newString: "fixed" })

    // 旧实现把 `—` 规范化成 `--`（1 字符 → 2 字符），却仍用规范化后的下标切原始文本，
    // 于是 `fix me` 被定位成 `x me`，结果写成 `fifixed`。
    expect(outcome.content).toBe("# 标题\n\n这是一段说明——后面还有内容。\nTODO: fixed\n")
  })

  it("oldString 用 ASCII 双连字符也能匹配文件里的 ——（容错仍然保留）", async () => {
    const ws = await workspace()
    const content = "说明——后面\n"
    const file = await ws.write("doc.md", content)

    const engine = new EditEngine()
    engine.recordRead(file, statSync(file).mtimeMs, content)
    const outcome = await engine.replace({
      path: file,
      oldString: "说明--后面",
      newString: "说明后面",
    })
    expect(outcome.content).toBe("说明后面\n")
  })
})

/* ------------------------------------------------------------------ *
 * ④ 整文件覆写：必须仍然过 read-before-edit
 * ------------------------------------------------------------------ */

describe("回归 · write_file 覆写护栏", () => {
  it("overwrite:true 覆写没读过的文件必须被拒绝（不能绕过 read-before-edit）", async () => {
    const ws = await workspace({ "src/a.ts": "original\n" })
    const file = ws.abs("src/a.ts")
    const tool = createWriteFileTool({ pathGuard: makePathGuard(ws), editEngine: new EditEngine() })

    await expect(
      tool.execute(
        { path: file, content: "clobbered", overwrite: true, maxBytes: 64_000 },
        makeToolContext({ workspace: ws }),
      ),
    ).rejects.toMatchObject({ code: "READ_BEFORE_EDIT" })

    // 文件内容必须原样保留 —— 拒绝要真的没写
    expect(await ws.read("src/a.ts")).toBe("original\n")
  })

  it("读过之后 overwrite:true 可以正常覆写", async () => {
    const ws = await workspace({ "src/a.ts": "original\n" })
    const file = ws.abs("src/a.ts")
    const engine = new EditEngine()
    engine.recordRead(file, statSync(file).mtimeMs, "original\n")
    const tool = createWriteFileTool({ pathGuard: makePathGuard(ws), editEngine: engine })

    await tool.execute(
      { path: file, content: "replaced\n", overwrite: true, maxBytes: 64_000 },
      makeToolContext({ workspace: ws }),
    )
    expect(await ws.read("src/a.ts")).toBe("replaced\n")
  })
})

/* ------------------------------------------------------------------ *
 * ⑤ 进度守卫：只读调用不能被算成"又改了一次文件"
 * ------------------------------------------------------------------ */

describe("回归 · 进度守卫的改动计数", () => {
  it("改一次文件后连续做只读操作，不应误报「反复重写同一文件」", async () => {
    const ws = await workspace()
    const file = ws.abs("a.txt")
    const runtime = await createTestRuntime({
      workspace: ws,
      script: [
        toolUse("repo.write_file", { path: file, content: "l1\nl2\nl3\nl4\nl5\n" }),
        toolUse("repo.read_file", { path: file, offset: 0, limit: 2 }),
        toolUse("repo.read_file", { path: file, offset: 2, limit: 2 }),
        toolUse("repo.list_files", { path: ws.root }),
        final("ok"),
      ],
      settings: settingsWith({ permissionMode: "acceptEdits" }),
    })
    const taskId = await runtime.createTask({
      title: "t",
      userRequest: "write then inspect",
      mode: "edit",
    })

    const { events, outcome } = await collect(runtime.run(taskId))

    expect(outcome.status).toBe("completed")
    // 旧实现把累计改动集合当成"本次改动的文件"，于是每个只读调用都给它 +1，
    // 四次调用后触发"a.txt 已被重写 4 次"的假警报。
    expect(reasons(events)).not.toContain("no_progress_compressed")
  })
})

/* ------------------------------------------------------------------ *
 * ⑥ 配置文件里的 budget 必须生效
 * ------------------------------------------------------------------ */

describe("回归 · settings.budget 生效", () => {
  it("配置文件写 maxRounds=1 时，任务在第 1 轮后就被预算拦住", async () => {
    const ws = await workspace()
    const runtime = await createTestRuntime({
      workspace: ws,
      script: [
        toolUse("repo.list_files", { path: ws.root }),
        toolUse("repo.list_files", { path: ws.root, maxDepth: 2 }),
        final("done"),
      ],
      settings: settingsWith({ permissionMode: "acceptEdits", budget: { maxRounds: 1 } }),
    })
    // 不传显式 budget：预算只能来自 settings
    const taskId = await runtime.createTask({ title: "t", userRequest: "list", mode: "edit" })

    const state = await runtime.store.getTask(taskId)
    expect(state?.budget.maxRounds).toBe(1)

    const { outcome } = await collect(runtime.run(taskId))
    expect(outcome.status).toBe("expired")
    expect(outcome.subtype).toBe("error_max_turns")
  })
})

/* ------------------------------------------------------------------ *
 * ⑦ test.run：策略判定必须看到真正要执行的命令
 * ------------------------------------------------------------------ */

describe("回归 · test.run 的策略输入", () => {
  it("省略 command 时，validate 会把自动发现的命令写回入参", async () => {
    const ws = await workspace()
    const tool = createTestRunTool({
      pathGuard: makePathGuard(ws),
      readPackageJson: async () => ({
        packageManager: "pnpm@9.0.0",
        scripts: { test: "vitest run" },
      }),
    })

    // 显式标注 command 可选：validate 会把它补全，这正是本用例要断言的行为
    const input: { cwd: string; timeoutMs: number; command?: string[] } = {
      cwd: ws.root,
      timeoutMs: 30_000,
    }
    await tool.validate?.(input, makeToolContext({ workspace: ws }))

    // 策略判定发生在 validate 之后，所以这里必须已经能看到真实命令
    expect(input.command).toEqual(["pnpm", "run", "test"])
    expect(tool.policyCommand?.(input)?.executable).toBe("pnpm")
  })

  it("filter 参与策略判定（否则批准的命令与实际 argv 差一个参数）", async () => {
    const ws = await workspace()
    const tool = createTestRunTool({
      pathGuard: makePathGuard(ws),
      readPackageJson: async () => ({ scripts: { test: "vitest run" } }),
    })
    const input = {
      cwd: ws.root,
      command: ["npm", "run", "test"],
      filter: "src/a",
      timeoutMs: 30_000,
    }
    expect(tool.policyCommand?.(input)?.args).toEqual(["run", "test", "src/a"])
  })

  it("没有可发现的命令时 validate 直接报错，而不是等到执行阶段", async () => {
    const ws = await workspace()
    const tool = createTestRunTool({
      pathGuard: makePathGuard(ws),
      readPackageJson: async () => ({}),
    })
    await expect(
      tool.validate?.({ cwd: ws.root, timeoutMs: 30_000 }, makeToolContext({ workspace: ws })),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" })
    expect(discoverChecks({})).toEqual([])
  })
})
