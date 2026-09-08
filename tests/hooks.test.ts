/**
 * Hook 生命周期与失败语义。
 *
 * 这里断言的核心不是"钩子能被调用"，而是**钩子失败时到底发生了什么**：
 * 安全钩子抛错绝不能变成"放行"，观察钩子抛错也不该拖垮用户的命令。
 * 这是可扩展机制里最容易埋雷的一处 —— fail-open 的拦截器等于没有拦截器。
 */

import path from "node:path"

import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { ToolExecutor } from "../src/tools/executor.js"
import { HookManager, type HookDefinition } from "../src/tools/hooks.js"
import { ToolRegistry } from "../src/tools/registry.js"
import type { AgentTool } from "../src/shared/contracts.js"
import type { PolicyDecision } from "../src/policy/engine.js"
import {
  collect,
  createTempWorkspace,
  createTestRuntime,
  makeToolContext,
  settingsWith,
  type TempWorkspace,
} from "./helpers.js"
import { final, toolUse } from "../src/model/scripted.js"

const Allow: PolicyDecision = {
  effect: "allow",
  reason: "test allow",
  bypassImmune: false,
  timeoutMs: 5_000,
  networkProfile: "inherit",
  parameterHash: "test-hash",
}

const Input = z.object({ message: z.string(), path: z.string().optional() })

function echoTool(run: (input: z.infer<typeof Input>) => void = () => {}) {
  const tool: AgentTool<z.infer<typeof Input>> = {
    name: "test.echo",
    description: "echo back",
    inputSchema: Input,
    risk: "read",
    idempotency: "safe",
    timeoutMs: 5_000,
    isReadOnly: true,
    async execute(input) {
      run(input)
      return `echo:${input.message}`
    },
  }
  return tool
}

function makeExecutor(hooks: readonly HookDefinition[], registry = new ToolRegistry()) {
  return new ToolExecutor({
    registry,
    hooks: new HookManager({ hooks }).toToolHooks(),
    policyVersion: "test",
  })
}

async function runTool(
  executor: ToolExecutor,
  workspace: TempWorkspace,
  args: unknown = { message: "hi" },
) {
  const outcome = await executor.execute({
    toolName: "test.echo",
    args,
    ctx: makeToolContext({ workspace }),
    decision: Allow,
    taskMode: "edit",
    permissionMode: "acceptEdits",
  })
  expect(outcome.kind).toBe("result")
  if (outcome.kind !== "result") throw new Error("unreachable")
  return outcome.result
}

describe("tools/hooks: 失败语义", () => {
  it("安全钩子抛错 → 拒绝执行（fail-closed），而不是放行", async () => {
    const ws = await createTempWorkspace()
    try {
      const executed = vi.fn()
      const registry = new ToolRegistry()
      registry.register(echoTool(executed))
      const executor = makeExecutor(
        [
          {
            name: "deny-all-guard",
            kind: "security",
            preToolUse: () => {
              throw new Error("guard backend unavailable")
            },
          },
        ],
        registry,
      )

      const result = await runTool(executor, ws)
      expect(executed).not.toHaveBeenCalled()
      expect(result.status).toBe("failed")
      expect(result.error?.code).toBe("TOOL_PERMISSION_DENIED")
      // 错误信息必须指出是哪个钩子坏了，否则排障只能靠猜
      expect(result.error?.message).toContain("deny-all-guard")
      expect(result.error?.message).toContain("Failing closed")
    } finally {
      await ws.cleanup()
    }
  })

  it("观察钩子抛错 → 放行（fail-open），用户命令不因埋点损坏而失败", async () => {
    const ws = await createTempWorkspace()
    try {
      const executed = vi.fn()
      const registry = new ToolRegistry()
      registry.register(echoTool(executed))
      const executor = makeExecutor(
        [
          {
            name: "metrics-only",
            kind: "observer",
            preToolUse: () => {
              throw new Error("metrics sink down")
            },
          },
        ],
        registry,
      )

      const result = await runTool(executor, ws)
      expect(executed).toHaveBeenCalledTimes(1)
      expect(result.status).toBe("succeeded")
    } finally {
      await ws.cleanup()
    }
  })

  it("入参改写钩子抛错 → 拒绝执行：拿不到确定入参就不能让策略审 A 跑 B", async () => {
    const ws = await createTempWorkspace()
    try {
      const executed = vi.fn()
      const registry = new ToolRegistry()
      registry.register(echoTool(executed))
      const executor = makeExecutor(
        [
          {
            name: "normalize-args",
            kind: "input",
            preToolUse: () => {
              throw new Error("cannot normalize")
            },
          },
        ],
        registry,
      )

      const result = await runTool(executor, ws)
      expect(executed).not.toHaveBeenCalled()
      expect(result.error?.code).toBe("TOOL_PERMISSION_DENIED")
    } finally {
      await ws.cleanup()
    }
  })

  it("入参改写生效后执行的是改后的参数，且改写结果仍会重新过 Schema", async () => {
    const ws = await createTempWorkspace()
    try {
      const seen: string[] = []
      const registry = new ToolRegistry()
      registry.register(echoTool((input) => seen.push(input.message)))
      const executor = makeExecutor(
        [
          {
            name: "trim",
            kind: "input",
            preToolUse: ({ args }) => ({
              updatedInput: { ...args, message: String(args.message).trim() },
            }),
          },
        ],
        registry,
      )

      const result = await runTool(executor, ws, { message: "  padded  " })
      expect(result.status).toBe("succeeded")
      expect(seen).toEqual(["padded"])
      expect(String(result.output)).toContain("echo:padded")
    } finally {
      await ws.cleanup()
    }
  })

  it("拦截后不再运行后面的钩子（顺序短路）", async () => {
    const ws = await createTempWorkspace()
    try {
      const later = vi.fn()
      const registry = new ToolRegistry()
      registry.register(echoTool())
      const executor = makeExecutor(
        [
          {
            name: "policy-guard",
            kind: "security",
            preToolUse: () => ({ block: true, reason: "blocked on purpose" }),
          },
          {
            name: "later-observer",
            kind: "observer",
            preToolUse: () => {
              later()
            },
          },
        ],
        registry,
      )

      const result = await runTool(executor, ws)
      expect(result.status).toBe("failed")
      expect(result.error?.message).toContain("policy-guard: blocked on purpose")
      expect(later).not.toHaveBeenCalled()
    } finally {
      await ws.cleanup()
    }
  })

  it("matches 只让钩子作用于目标工具", async () => {
    const ws = await createTempWorkspace()
    try {
      const called = vi.fn()
      const registry = new ToolRegistry()
      registry.register(echoTool())
      const executor = makeExecutor(
        [
          {
            name: "only-for-other",
            kind: "observer",
            matches: (toolName) => toolName === "other.tool",
            preToolUse: () => {
              called()
            },
          },
        ],
        registry,
      )

      const result = await runTool(executor, ws)
      expect(result.status).toBe("succeeded")
      expect(called).not.toHaveBeenCalled()
    } finally {
      await ws.cleanup()
    }
  })
})

describe("runtime: hooks 真的接进了执行链", () => {
  it("安全钩子拦住 repo.write_file：文件不落盘，模型收到可读的拦截原因", async () => {
    const ws = await createTempWorkspace()
    try {
      const target = path.join(ws.root, "blocked.txt")
      const runtime = await createTestRuntime({
        workspace: ws,
        script: [
          toolUse("repo.write_file", { path: target, content: "should not exist" }),
          final("done"),
        ],
        settings: settingsWith({ permissionMode: "acceptEdits" }),
        hooks: [
          {
            name: "no-write-guard",
            kind: "security",
            matches: (toolName) => toolName === "repo.write_file",
            preToolUse: () => ({ block: true, reason: "writes are disabled in this test" }),
          },
        ],
      })
      const taskId = await runtime.createTask({ title: "t", userRequest: "write", mode: "edit" })
      const { outcome } = await collect(runtime.run(taskId))

      expect(outcome.status).toBe("completed")
      // 用户可观察结果：文件没有被创建
      await expect(ws.read("blocked.txt")).rejects.toThrow()

      const messages = await runtime.store.getMessages(taskId)
      const text = JSON.stringify(messages)
      expect(text).toContain("no-write-guard")
      expect(text).toContain("writes are disabled in this test")
    } finally {
      await ws.cleanup()
    }
  })
})
