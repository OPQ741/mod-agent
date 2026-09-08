/**
 * Runtime 的**任务隔离**与**单飞锁**（可靠性基线 P1）。
 *
 * 背景：`AgentRuntime` 是 CLI 与 SDK 共用的内核。一旦上层把它交给调度器
 * 同时跑多个任务，任何"runtime 级"的可变状态都会变成跨任务污染：
 *
 * - 计划模式曾是 `private planModeActive`：任务 A 进入后没来得及退出，
 *   任务 B 的下一次请求也变成只读，而且没有任何报错；
 * - 延迟工具激活曾是 runtime 级 Set：A 激活的 schema 会出现在 B 的工具表里；
 * - 同一个 taskId 可以同时跑两个循环：事件 seq 按"已有事件数 + 1"分配，
 *   两边会撞序号、重复工具副作用、互相覆盖任务状态。
 *
 * 这三条都靠"任务结束即销毁任务级状态 + 同一 taskId 只允许一个循环"收口。
 * 这里断言的都是**用户可观察结果**：模型这一轮到底看到了哪些工具、
 * 工具到底有没有执行、第二个循环有没有被拒绝。
 */

import { afterEach, describe, expect, it } from "vitest"

import {
  collect,
  createTempWorkspace,
  createTestRuntime,
  settingsWith,
  type TempWorkspace,
} from "./helpers.js"
import { final, toolUse } from "../src/model/scripted.js"
import type { ModelRequest } from "../src/model/types.js"

const workspaces: TempWorkspace[] = []

afterEach(async () => {
  while (workspaces.length > 0) {
    const ws = workspaces.pop()
    if (ws) await ws.cleanup()
  }
})

async function workspace(): Promise<TempWorkspace> {
  const ws = await createTempWorkspace()
  workspaces.push(ws)
  return ws
}

describe("Runtime · 任务级状态隔离", () => {
  it("任务 A 的计划模式与延迟激活都不会泄漏给任务 B", async () => {
    const ws = await workspace()
    const seen: string[][] = []
    const runtime = await createTestRuntime({
      workspace: ws,
      script: [
        // 任务 A：先激活延迟工具，再进入计划模式，最后**不退出**就交付
        toolUse("tool_search", { query: "plan" }),
        toolUse("plan.enter_plan_mode", { reason: "multi-file change" }),
        final("A done"),
        // 任务 B：只跑一轮 final
        final("B done"),
      ],
      settings: settingsWith({ permissionMode: "acceptEdits" }),
      onRequest: (request: ModelRequest) => seen.push(request.tools.map((tool) => tool.name)),
    })

    const taskA = await runtime.createTask({ title: "A", userRequest: "plan it", mode: "edit" })
    const { outcome: outcomeA } = await collect(runtime.run(taskA))
    expect(outcomeA.status).toBe("completed")

    // 第一轮：延迟工具还没激活，只以名字形式出现在系统提示词里
    expect(seen[0]).not.toContain("plan.enter_plan_mode")
    // tool_search 之后：下一轮必须带完整 schema（否则激活等于没做）
    expect(seen[1]).toContain("plan.enter_plan_mode")
    // 计划模式在"进入"那一轮**执行后**生效：再下一轮的装配里写工具已被收走
    expect(seen[2]).not.toContain("repo.write_file")

    const taskB = await runtime.createTask({ title: "B", userRequest: "edit it", mode: "edit" })
    const { outcome: outcomeB } = await collect(runtime.run(taskB))
    expect(outcomeB.status).toBe("completed")

    // 任务 B 是独立任务：计划模式必须已解除，延迟激活也不能继承
    expect(seen[3]).toContain("repo.write_file")
    expect(seen[3]).not.toContain("plan.enter_plan_mode")
  })

  it("模型点名未激活的延迟工具：不执行，并提示先 tool_search", async () => {
    const ws = await workspace()
    const runtime = await createTestRuntime({
      workspace: ws,
      script: [
        // 跳过 tool_search，直接调用延迟工具
        toolUse("plan.enter_plan_mode", { reason: "skip activation" }),
        final("done"),
      ],
      settings: settingsWith({ permissionMode: "acceptEdits" }),
    })
    const taskId = await runtime.createTask({ title: "t", userRequest: "x", mode: "edit" })
    const { events, outcome } = await collect(runtime.run(taskId))

    expect(outcome.status).toBe("completed")
    // 没有真正执行：连 tool.started 都不该出现
    expect(events.some((event) => event.type === "tool.started")).toBe(false)
    // 回喂给模型的是可读的补救提示，而不是"未知工具"或静默成功
    const messages = await runtime.store.getMessages(taskId)
    expect(JSON.stringify(messages)).toContain("has not been activated")
    expect(JSON.stringify(messages)).toContain("tool_search")
  })
})

describe("Runtime · 同一任务单飞锁", () => {
  it("同一 taskId 已有循环在跑时，第二个 run() 直接拒绝", async () => {
    const ws = await workspace()
    const runtime = await createTestRuntime({
      workspace: ws,
      script: [final("done")],
      settings: settingsWith({ permissionMode: "acceptEdits" }),
    })
    const taskId = await runtime.createTask({ title: "t", userRequest: "x", mode: "edit" })

    const first = runtime.run(taskId)
    // 消费一次：生成器体已执行，锁必须已被持有
    await first.next()

    const second = runtime.run(taskId)
    await expect(second.next()).rejects.toMatchObject({ code: "INVALID_INPUT" })

    // 第一个循环不受影响，仍能正常收尾
    const { outcome } = await collect(first)
    expect(outcome.status).toBe("completed")
  })

  it("循环自然结束后锁会释放，不会把任务永久锁死", async () => {
    const ws = await workspace()
    const runtime = await createTestRuntime({
      workspace: ws,
      script: [final("done"), final("done again")],
      settings: settingsWith({ permissionMode: "acceptEdits" }),
    })
    const taskId = await runtime.createTask({ title: "t", userRequest: "x", mode: "edit" })
    const { outcome } = await collect(runtime.run(taskId))
    expect(outcome.status).toBe("completed")

    /**
     * 已 completed 的任务再次 run() 不应因为"锁没释放"被拒。
     * 这里只断言"没有被锁挡住"：终态任务本身由状态机决定不再推进，
     * 具体返回值不是这条用例的关注点。
     */
    const again = runtime.run(taskId)
    await expect(again.next()).resolves.toBeDefined()
  })
})
