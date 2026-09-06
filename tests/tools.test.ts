/**
 * 工具层测试：注册表装配 + 执行生命周期 + 内置工具。
 *
 * 重点验证三类"文档写了但很容易实现错"的约束：
 * - 只读档在**注册层**收口（plan/ask 模式写工具根本不出现），而不是执行时被拒；
 * - 工具错误是**数据**不是异常（unknown tool / schema 错 / 被拒 都回到 ToolExecutionResult）；
 * - ACI 纪律：强制绝对路径、空输出固定文案、搜索默认只给文件+命中计数。
 */

import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import path from "node:path"

import { DuplicateToolError, ToolRegistry } from "../src/tools/registry.js"
import { EMPTY_OUTPUT_NOTICE, ToolExecutor, renderCommandResult } from "../src/tools/executor.js"
import { AppError } from "../src/shared/errors.js"
import type { AgentTool, ToolExecutionResult } from "../src/shared/contracts.js"
import {
  createListFilesTool,
  createReadFileTool,
  createSearchTextTool,
  createGitStatusTool,
} from "../src/tools/builtin/repo.js"
import { createEditFileTool, createWriteFileTool } from "../src/tools/builtin/edit.js"
import {
  createCommandRunTool,
  discoverChecks,
  extractFailureSummary,
} from "../src/tools/builtin/command.js"
import {
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createToolSearchTool,
} from "../src/tools/builtin/plan.js"
import { EditEngine } from "../src/patch/edit.js"
import {
  createTempWorkspace,
  fakeCommandRunner,
  makePathGuard,
  makeToolContext,
  makeToolRuntime,
} from "./helpers.js"

/* ------------------------------------------------------------------ *
 * 测试用工具
 * ------------------------------------------------------------------ */

const EchoInput = z.object({ message: z.string(), delay: z.number().optional() })

function echoTool(
  overrides: Partial<AgentTool<z.infer<typeof EchoInput>>> = {},
): AgentTool<z.infer<typeof EchoInput>> {
  return {
    name: "test.echo",
    description: "echo back",
    inputSchema: EchoInput,
    risk: "read",
    idempotency: "safe",
    timeoutMs: 5_000,
    isReadOnly: true,
    async execute(input) {
      if (input.delay) await new Promise((r) => setTimeout(r, input.delay))
      return `echo:${input.message}`
    },
    ...overrides,
  }
}

const runTool = async (
  executor: ToolExecutor,
  toolName: string,
  args: unknown,
  ctxParams: Partial<Parameters<typeof makeToolContext>[0]> = {},
  extra: Parameters<ToolExecutor["execute"]>[0] extends infer P ? Partial<P> : never = {},
): Promise<ToolExecutionResult> => {
  const ctx = makeToolContext({ workspace: tempWs, ...ctxParams })
  const outcome = await executor.execute({
    toolName,
    args,
    ctx,
    taskMode: "edit",
    permissionMode: "default",
    ...extra,
  })
  return outcome.result
}

let tempWs: Awaited<ReturnType<typeof createTempWorkspace>>

async function withWorkspace<T>(
  fn: (ws: Awaited<ReturnType<typeof createTempWorkspace>>) => Promise<T>,
): Promise<T> {
  const ws = await createTempWorkspace()
  tempWs = ws
  try {
    return await fn(ws)
  } finally {
    await ws.cleanup()
  }
}

describe("tools/registry: 三层装配", () => {
  it("重名注册直接抛错 —— 重名会让模型分不清该调哪一个", async () => {
    await withWorkspace(async (ws) => {
      const { registry } = makeToolRuntime({ workspace: ws })
      registry.register(echoTool())
      expect(() => registry.register(echoTool())).toThrow(DuplicateToolError)
    })
  })

  it("注册时就把 schema 转 JSON Schema 校验一遍，避免下发阶段才炸", async () => {
    await withWorkspace(async (ws) => {
      const { registry } = makeToolRuntime({ workspace: ws })
      registry.register(echoTool())
      const spec = registry.assemble({ taskMode: "edit", permissionMode: "default" }).specs[0]!
      expect(spec.name).toBe("test.echo")
      expect(spec.inputSchema.type).toBe("object")
      expect(spec.inputSchema.required).toContain("message")
    })
  })

  it("MCP 工具名超长显式报错，不静默丢弃", async () => {
    await withWorkspace(async (ws) => {
      const { registry } = makeToolRuntime({ workspace: ws })
      const tooLong = echoTool({ name: `mcp_${"x".repeat(140)}` })
      expect(() => registry.registerWithLengthCheck(tooLong, "mcp:srv")).toThrow(/too long/)
    })
  })

  it("内置工具字母序在前、外部工具追加在后，并有缓存断点", async () => {
    await withWorkspace(async (ws) => {
      const { registry } = makeToolRuntime({ workspace: ws })
      registry.register(echoTool({ name: "zz.builtin" }))
      registry.register(echoTool({ name: "aa.builtin" }))
      registry.register(echoTool({ name: "mcp.server_tool" }), "mcp:srv")
      const assembled = registry.assemble({ taskMode: "edit", permissionMode: "default" })
      expect(assembled.executable).toEqual(["aa.builtin", "zz.builtin", "mcp.server_tool"])
      expect(assembled.cacheBreakpoint).toBe(2)
    })
  })

  it("延迟加载工具未激活时不给 schema、也不可执行；激活后立刻拿到完整 schema", async () => {
    await withWorkspace(async (ws) => {
      const { registry } = makeToolRuntime({ workspace: ws })
      registry.register(echoTool({ name: "deferred.tool", deferred: true }))
      const before = registry.assemble({ taskMode: "edit", permissionMode: "default" })
      expect(before.specs.some((s) => s.name === "deferred.tool")).toBe(false)
      expect(before.deferredNames).toContain("deferred.tool")
      expect(before.executable).not.toContain("deferred.tool")

      const after = registry.assemble({
        taskMode: "edit",
        permissionMode: "default",
        activatedDeferred: new Set(["deferred.tool"]),
      })
      expect(after.executable).toContain("deferred.tool")
      expect(after.specs.some((s) => s.name === "deferred.tool")).toBe(true)
    })
  })

  it("plan / ask 模式在注册层收口：写与命令工具直接不在清单里", async () => {
    await withWorkspace(async (ws) => {
      const { registry } = makeToolRuntime({ workspace: ws })
      registry.register(echoTool({ name: "read.tool", risk: "read" }))
      registry.register(echoTool({ name: "write.tool", risk: "workspace_write" }))
      registry.register(echoTool({ name: "cmd.tool", risk: "command" }))

      const plan = registry.assemble({ taskMode: "plan", permissionMode: "default" })
      expect(plan.executable).toEqual(["read.tool"])
      expect(plan.filtered.map((f) => f.name)).toContain("write.tool")
      expect(plan.filtered.map((f) => f.name)).toContain("cmd.tool")
      expect(plan.filtered[0]!.reason).toMatch(/read-only mode/)
    })
  })

  it("deny / disallow / allow 白名单在装配层过滤并记录原因", async () => {
    await withWorkspace(async (ws) => {
      const { registry } = makeToolRuntime({ workspace: ws })
      registry.register(echoTool({ name: "a.tool" }))
      registry.register(echoTool({ name: "b.tool" }))
      registry.register(echoTool({ name: "c.tool" }))

      const assembled = registry.assemble({
        taskMode: "edit",
        permissionMode: "default",
        deniedTools: new Set(["a.tool"]),
        disallowTools: new Set(["b.tool"]),
        allowTools: new Set(["c.tool"]),
      })
      // c.tool 命中白名单 → 不被过滤；另两个各自留下一条可审计的原因
      expect(assembled.executable).toEqual(["c.tool"])
      expect(assembled.filtered.map((f) => f.reason).sort()).toEqual([
        "denied by policy rule",
        "disallowed for this agent",
      ])
    })
  })

  it("注册层 disable 的工具不再下发", async () => {
    await withWorkspace(async (ws) => {
      const { registry } = makeToolRuntime({ workspace: ws })
      registry.register(echoTool({ name: "a.tool" }))
      registry.disable("a.tool")
      expect(registry.assemble({ taskMode: "edit", permissionMode: "default" }).executable).toEqual(
        [],
      )
      registry.enable("a.tool")
      expect(registry.assemble({ taskMode: "edit", permissionMode: "default" }).executable).toEqual(
        ["a.tool"],
      )
    })
  })

  it("fail-closed 元数据：未声明即最保守值", async () => {
    await withWorkspace(async (ws) => {
      const { registry } = makeToolRuntime({ workspace: ws })
      registry.register(
        echoTool({ name: "quiet.tool", isConcurrencySafe: undefined, isReadOnly: undefined }),
      )
      const tool = registry.get("quiet.tool")!
      expect(ToolRegistry.isConcurrencySafe(tool, {})).toBe(false)
      expect(ToolRegistry.isReadOnly(tool)).toBe(false)
      expect(ToolRegistry.isDestructive(tool)).toBe(false)
    })
  })

  it("isConcurrencySafe 抛错时按不安全算（标记出错要落在多打扰这一边）", async () => {
    await withWorkspace(async (ws) => {
      const { registry } = makeToolRuntime({ workspace: ws })
      registry.register(
        echoTool({
          name: "flaky.tool",
          isConcurrencySafe: () => {
            throw new Error("boom")
          },
        }),
      )
      expect(ToolRegistry.isConcurrencySafe(registry.get("flaky.tool")!, {})).toBe(false)
    })
  })

  it("isEnabled 返回 false 的工具被过滤并记录原因", async () => {
    await withWorkspace(async (ws) => {
      const { registry } = makeToolRuntime({ workspace: ws })
      registry.register(echoTool({ name: "off.tool", isEnabled: () => false }))
      const assembled = registry.assemble({ taskMode: "edit", permissionMode: "default" })
      expect(assembled.executable).toEqual([])
      expect(assembled.filtered[0]!.reason).toMatch(/isEnabled/)
    })
  })
})

describe("tools/executor: 八阶段生命周期", () => {
  it("① 未知工具：回喂已知工具提示，而不是抛异常", async () => {
    await withWorkspace(async (ws) => {
      const { executor } = makeToolRuntime({ workspace: ws })
      const result = await runTool(executor, "does.not_exist", {})
      expect(result.status).toBe("failed")
      expect(result.error?.code).toBe("TOOL_NOT_FOUND")
      expect(String(result.error?.message)).toMatch(/Unknown tool/)
    })
  })

  it("② Zod 校验失败：返回具体字段，让模型下一轮能改对", async () => {
    await withWorkspace(async (ws) => {
      const { registry, executor } = makeToolRuntime({ workspace: ws })
      registry.register(echoTool())
      const result = await runTool(executor, "test.echo", { message: 123 })
      expect(result.status).toBe("failed")
      expect(result.error?.code).toBe("TOOL_SCHEMA_INVALID")
      expect(result.error?.message).toMatch(/message/)
    })
  })

  it("② 业务校验（validate）失败同样回喂", async () => {
    await withWorkspace(async (ws) => {
      const { registry, executor } = makeToolRuntime({ workspace: ws })
      registry.register(
        echoTool({
          name: "strict.tool",
          validate: () => {
            throw new AppError("INVALID_INPUT", "not allowed to echo that")
          },
        }),
      )
      const result = await runTool(executor, "strict.tool", { message: "hi" })
      expect(result.status).toBe("failed")
      expect(result.error?.code).toBe("INVALID_INPUT")
    })
  })

  it("④ 策略 deny：返回值里明确写「换个办法，别绕策略」", async () => {
    await withWorkspace(async (ws) => {
      const { registry, executor } = makeToolRuntime({ workspace: ws })
      registry.register(echoTool())
      const result = await runTool(
        executor,
        "test.echo",
        { message: "hi" },
        {},
        {
          decision: {
            effect: "deny",
            reason: "matched a deny rule",
            bypassImmune: false,
            timeoutMs: 1000,
            networkProfile: "none",
            parameterHash: "hash",
          },
        },
      )
      expect(result.status).toBe("failed")
      expect(result.error?.code).toBe("TOOL_PERMISSION_DENIED")
      expect(result.error?.message).toMatch(/bypass the policy/)
    })
  })

  it("④ 策略 ask：返回审批请求 + APPROVAL_REQUIRED 结果，不阻塞线程", async () => {
    await withWorkspace(async (ws) => {
      const { registry, executor } = makeToolRuntime({ workspace: ws })
      registry.register(echoTool())
      const ctx = makeToolContext({ workspace: ws })
      const outcome = await executor.execute({
        toolName: "test.echo",
        args: { message: "hi" },
        ctx,
        taskMode: "edit",
        permissionMode: "default",
        decision: {
          effect: "ask",
          reason: "needs confirmation",
          bypassImmune: false,
          timeoutMs: 1234,
          networkProfile: "none",
          parameterHash: "abc123",
        },
      })
      expect(outcome.kind).toBe("approval")
      if (outcome.kind === "approval") {
        expect(outcome.approval.toolName).toBe("test.echo")
        expect(outcome.approval.parameterHash).toBe("abc123")
        expect(outcome.approval.policyVersion).toBe("test-policy")
      }
      expect(outcome.result.status).toBe("failed")
      expect(outcome.result.error?.code).toBe("APPROVAL_REQUIRED")
    })
  })

  it("⑤ 工具内部抛错转成 failed 结果，循环不断", async () => {
    await withWorkspace(async (ws) => {
      const { registry, executor } = makeToolRuntime({ workspace: ws })
      registry.register(
        echoTool({
          name: "boom.tool",
          execute: async () => {
            throw new AppError("EDIT_NOT_FOUND", "old_string not found")
          },
        }),
      )
      const result = await runTool(executor, "boom.tool", { message: "x" })
      expect(result.status).toBe("failed")
      expect(result.error?.code).toBe("EDIT_NOT_FOUND")
    })
  })

  it("⑤ 超时（runWithTimeout）：防 sleep永不返回的工具", async () => {
    await withWorkspace(async (ws) => {
      const { registry, executor } = makeToolRuntime({ workspace: ws })
      registry.register(
        echoTool({
          name: "slow.tool",
          timeoutMs: 50,
          execute: async (_input, ctx) => {
            await new Promise((r) => setTimeout(r, 3_000))
            return ctx.signal.aborted ? "aborted" : "finished"
          },
        }),
      )
      const result = await runTool(executor, "slow.tool", { message: "x" })
      expect(result.status).toBe("timed_out")
      expect(result.error?.code).toBe("TOOL_TIMEOUT")
      expect(result.error?.retryable).toBe(true)
    })
  })

  it("⑤ 取消：ctx.signal 已 abort 时记为 cancelled", async () => {
    await withWorkspace(async (ws) => {
      const { registry, executor } = makeToolRuntime({ workspace: ws })
      registry.register(
        echoTool({
          name: "cancel.tool",
          execute: async (_input, ctx) => {
            await new Promise((r) => setTimeout(r, 20))
            return ctx.signal.aborted ? "aborted" : "finished"
          },
        }),
      )
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 5)
      const result = await runTool(
        executor,
        "cancel.tool",
        { message: "x" },
        { signal: controller.signal },
      )
      expect(result.status).toBe("cancelled")
      expect(result.error?.code).toBe("TOOL_CANCELLED")
    })
  })

  it("⑥ 超大输出先落盘再给预览（截断不可逆，落盘可逆）", async () => {
    await withWorkspace(async (ws) => {
      const { registry } = makeToolRuntime({ workspace: ws })
      registry.register(
        echoTool({
          name: "huge.tool",
          execute: async () => "x".repeat(40_000),
        }),
      )
      const persisted: string[] = []
      const executor = new ToolExecutor({
        registry,
        policyVersion: "v1",
        persistThresholdTokens: 500,
      })
      const result = await runTool(executor, "huge.tool", { message: "x" })
      expect(result.truncated).toBe(true)
      const output = result.output as { persisted: boolean; uri: string; preview: string }
      expect(output.persisted).toBe(true)
      expect(output.preview.length).toBeLessThan(40_000)
      expect(result.artifacts[0]?.kind).toBe("tool-output")
      void persisted
    })
  })

  it("⑥ 中等输出按 budgetTokens 裁剪", async () => {
    await withWorkspace(async (ws) => {
      const { registry } = makeToolRuntime({ workspace: ws })
      registry.register(echoTool({ name: "medium.tool", execute: async () => "y".repeat(5_000) }))
      const executor = new ToolExecutor({
        registry,
        policyVersion: "v1",
        persistThresholdTokens: 100_000,
      })
      const ctx = makeToolContext({ workspace: ws })
      ctx.budgetTokens = 200
      const outcome = await executor.execute({
        toolName: "medium.tool",
        args: { message: "x" },
        ctx,
        taskMode: "edit",
        permissionMode: "default",
      })
      expect(outcome.result.truncated).toBe(true)
      expect(String(outcome.result.output).length).toBeLessThan(5_000)
    })
  })

  it("⑦ Pre-Tool Hook 能阻断，也能改写入参", async () => {
    await withWorkspace(async (ws) => {
      const { registry } = makeToolRuntime({ workspace: ws })
      registry.register(echoTool())

      const blocking = new ToolExecutor({
        registry,
        policyVersion: "v1",
        hooks: { preToolUse: async () => ({ block: true, reason: "policy says no" }) },
      })
      const blocked = await runTool(blocking, "test.echo", { message: "hi" })
      expect(blocked.error?.code).toBe("TOOL_PERMISSION_DENIED")
      expect(blocked.error?.message).toMatch(/policy says no/)

      const rewriting = new ToolExecutor({
        registry,
        policyVersion: "v1",
        hooks: { preToolUse: async () => ({ updatedInput: { message: "rewritten" } }) },
      })
      const rewritten = await runTool(rewriting, "test.echo", { message: "original" })
      expect(rewritten.output).toBe("echo:rewritten")
    })
  })

  it("⑦ Pre-Tool Hook 自身异常不阻断（fail-open 只对 hook，安全判定仍在 policy）", async () => {
    await withWorkspace(async (ws) => {
      const { registry } = makeToolRuntime({ workspace: ws })
      registry.register(echoTool())
      const executor = new ToolExecutor({
        registry,
        policyVersion: "v1",
        hooks: {
          preToolUse: async () => {
            throw new Error("hook crashed")
          },
        },
      })
      const result = await runTool(executor, "test.echo", { message: "hi" })
      expect(result.status).toBe("succeeded")
    })
  })

  it("⑦ Post-Tool Hook 能追加事实或替换输出（例如给 stdout 里的密钥打码）", async () => {
    await withWorkspace(async (ws) => {
      const { registry } = makeToolRuntime({ workspace: ws })
      registry.register(
        echoTool({ name: "secret.tool", execute: async () => "key sk-abcdefghijklmnop123456" }),
      )
      const executor = new ToolExecutor({
        registry,
        policyVersion: "v1",
        hooks: {
          // 用真实结果做判断：既验证 hook 拿得到 result，也验证 replaceOutput 生效
          postToolUse: async ({ result }) =>
            String(result.output ?? "").includes("sk-") ? { replaceOutput: "[scrubbed]" } : {},
        },
      })
      const result = await runTool(executor, "secret.tool", { message: "x" })
      expect(result.output).toBe("[scrubbed]")

      const appending = new ToolExecutor({
        registry,
        policyVersion: "v1",
        hooks: { postToolUse: async () => ({ additionalContext: "note: exit 0" }) },
      })
      const appended = await runTool(appending, "secret.tool", { message: "x" })
      expect(String(appended.output)).toContain("note: exit 0")
    })
  })

  it("⑧ 成功路径返回结构与时长", async () => {
    await withWorkspace(async (ws) => {
      const { registry, executor } = makeToolRuntime({ workspace: ws })
      registry.register(echoTool())
      const result = await runTool(executor, "test.echo", { message: "hello" })
      expect(result.status).toBe("succeeded")
      expect(result.output).toBe("echo:hello")
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
      expect(result.callId).toBe("call_test")
    })
  })
})

describe("tools/executor: 渲染辅助", () => {
  it("空输出统一文案 —— 让模型分清「没有输出」和「忘了给输出」", async () => {
    await withWorkspace(async (_ws) => {
      const rendered = renderCommandResult({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 3,
        timedOut: false,
        truncated: false,
        cancelled: false,
        outputLimitExceeded: false,
      })
      expect(rendered.text).toContain(EMPTY_OUTPUT_NOTICE)
    })
  })

  it("命令结果含退出码与耗时", async () => {
    await withWorkspace(async (_ws) => {
      const rendered = renderCommandResult({
        exitCode: 2,
        stdout: "out",
        stderr: "err",
        durationMs: 12,
        timedOut: false,
        truncated: true,
        cancelled: false,
        outputLimitExceeded: false,
      })
      expect(rendered.text).toContain("out")
      expect(rendered.text).toContain("err")
      expect(rendered.text).toContain("2")
    })
  })
})

describe("tools/builtin: repo 工具（ACI 纪律）", () => {
  it("repo.list_files 拒绝相对路径 —— 相对路径会随 cwd 漂移", async () => {
    await withWorkspace(async (ws) => {
      await ws.write("src/a.ts", "x")
      const tool = createListFilesTool({
        pathGuard: makePathGuard(ws),
        trackRead: () => undefined,
        excludeDirs: ["node_modules"],
      })
      expect(tool.inputSchema.safeParse({ path: "./src" }).success).toBe(false)
    })
  })

  it("repo.list_files 返回路径与大小，不给内容", async () => {
    await withWorkspace(async (ws) => {
      await ws.write("src/a.ts", "hello")
      await ws.write("src/b.log", "noise")
      const tool = createListFilesTool({
        pathGuard: makePathGuard(ws),
        trackRead: () => undefined,
        excludeDirs: [],
      })
      const out = (await tool.execute(
        { path: ws.root, maxDepth: 3, limit: 200 },
        makeToolContext({ workspace: ws }),
      )) as { files: Array<{ path: string; bytes: number }> }
      expect(out.files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.log"])
      expect(out.files[0]!.bytes).toBeGreaterThan(0)
    })
  })

  it("repo.list_files 超量时给收窄提示而不是硬塞", async () => {
    await withWorkspace(async (ws) => {
      for (let i = 0; i < 20; i += 1) await ws.write(`src/f${i}.ts`, "x")
      const tool = createListFilesTool({
        pathGuard: makePathGuard(ws),
        trackRead: () => undefined,
        excludeDirs: [],
      })
      const out = (await tool.execute(
        { path: ws.root, maxDepth: 3, limit: 5 },
        makeToolContext({ workspace: ws }),
      )) as { truncated: boolean; hint?: string }
      expect(out.truncated).toBe(true)
      expect(out.hint).toMatch(/Narrow/)
    })
  })

  it("repo.read_file 行号分页 + 记录已读（read-before-edit 的数据来源）", async () => {
    await withWorkspace(async (ws) => {
      const file = await ws.write(
        "src/a.ts",
        Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n"),
      )
      const trackRead = vi.fn()
      const tool = createReadFileTool(
        { pathGuard: makePathGuard(ws), trackRead, excludeDirs: [] },
        { maxBytes: 256 * 1024, maxOutputTokens: 25_000 },
      )
      const out = (await tool.execute(
        { path: file, offset: 2, limit: 3, allowLarge: false },
        makeToolContext({ workspace: ws }),
      )) as { content: string; startLine: number }
      expect(out.startLine).toBe(3)
      expect(out.content).toContain("line2")
      expect(out.content).not.toContain("line9")
      expect(trackRead).toHaveBeenCalledTimes(1)
    })
  })

  it("repo.read_file 拒绝超大文件，除非 allowLarge", async () => {
    await withWorkspace(async (ws) => {
      const file = await ws.write("big.txt", "x".repeat(2000))
      const tool = createReadFileTool(
        { pathGuard: makePathGuard(ws), trackRead: () => undefined, excludeDirs: [] },
        { maxBytes: 100, maxOutputTokens: 1_000 },
      )
      await expect(
        tool.execute(
          { path: file, offset: 0, limit: 10, allowLarge: false },
          makeToolContext({ workspace: ws }),
        ),
      ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" })
    })
  })

  it("repo.read_file 拒绝二进制文件（永远不该进模型上下文）", async () => {
    await withWorkspace(async (ws) => {
      const file = await ws.write("blob.bin", "\u0000\u0001\u0002\u0003binary\u0000\u0001")
      const tool = createReadFileTool(
        { pathGuard: makePathGuard(ws), trackRead: () => undefined, excludeDirs: [] },
        { maxBytes: 10 * 1024, maxOutputTokens: 1_000 },
      )
      await expect(
        tool.execute(
          { path: file, offset: 0, limit: 10, allowLarge: true },
          makeToolContext({ workspace: ws }),
        ),
      ).rejects.toMatchObject({ code: "TOOL_FAILED" })
    })
  })

  it("repo.search_text 默认只给文件与命中计数（ACI：先给地图再给街道）", async () => {
    await withWorkspace(async (ws) => {
      await ws.write("src/a.ts", "needle one\nneedle two\n")
      await ws.write("src/b.ts", "needle three\n")
      const tool = createSearchTextTool({
        pathGuard: makePathGuard(ws),
        trackRead: () => undefined,
        excludeDirs: [],
      })
      const out = (await tool.execute(
        {
          path: ws.root,
          pattern: "needle",
          withLines: false,
          maxResults: 100,
          caseSensitive: false,
        },
        makeToolContext({ workspace: ws }),
      )) as { hits: Array<{ file: string; count: number; lines: string[] }>; totalMatches: number }
      expect(out.hits.map((h) => h.count).sort()).toEqual([1, 2])
      expect(out.totalMatches).toBe(3)
      // 不带 withLines 绝不能把正文行塞进上下文
      expect(out.hits.every((h) => h.lines.length === 0)).toBe(true)
    })
  })

  it("repo.search_text withLines 才返回具体行", async () => {
    await withWorkspace(async (ws) => {
      await ws.write("src/a.ts", "needle here\n")
      const tool = createSearchTextTool({
        pathGuard: makePathGuard(ws),
        trackRead: () => undefined,
        excludeDirs: [],
      })
      const out = (await tool.execute(
        {
          path: ws.root,
          pattern: "needle",
          withLines: true,
          maxResults: 100,
          caseSensitive: false,
        },
        makeToolContext({ workspace: ws }),
      )) as { hits: Array<{ file: string; lines: string[] }> }
      expect(out.hits[0]!.lines[0]).toContain("needle")
    })
  })

  it("repo.search_text 命中过多时要求收窄，而不是硬塞", async () => {
    await withWorkspace(async (ws) => {
      for (let i = 0; i < 60; i += 1) await ws.write(`src/f${i}.ts`, "needle\n")
      const tool = createSearchTextTool({
        pathGuard: makePathGuard(ws),
        trackRead: () => undefined,
        excludeDirs: [],
      })
      const out = (await tool.execute(
        {
          path: ws.root,
          pattern: "needle",
          withLines: false,
          maxResults: 100,
          caseSensitive: false,
        },
        makeToolContext({ workspace: ws }),
      )) as { capped?: boolean; hits: unknown[]; note?: string }
      expect(out.capped).toBe(true)
      expect(out.hits).toEqual([])
      expect(out.note).toMatch(/narrow/i)
    })
  })

  it("repo.git_status 走沙箱命令通道，而不是自己 fork 一条 git", async () => {
    await withWorkspace(async (ws) => {
      const runner = fakeCommandRunner({ stdout: " M src/a.ts\n", exitCode: 0 })
      const tool = createGitStatusTool({
        pathGuard: makePathGuard(ws),
        trackRead: () => undefined,
        excludeDirs: [],
      })
      const out = await tool.execute(
        { path: ws.root },
        makeToolContext({ workspace: ws, runCommand: runner }),
      )
      expect(
        (runner as unknown as { calls: Array<{ executable: string }> }).calls[0]!.executable,
      ).toBe("git")
      expect(out).toMatchObject({ dirty: true, branch: expect.any(String) })
    })
  })

  it("repo.git_status 要求绝对路径（仓库位置，而不是 cwd）", async () => {
    await withWorkspace(async (ws) => {
      const tool = createGitStatusTool({
        pathGuard: makePathGuard(ws),
        trackRead: () => undefined,
        excludeDirs: [],
      })
      expect(tool.inputSchema.safeParse({ path: "./" }).success).toBe(false)
    })
  })

  it("repo 工具的路径守卫拦住工作区外的绝对路径", async () => {
    await withWorkspace(async (ws) => {
      const outside = await createTempWorkspace("mod-outside-")
      try {
        const tool = createListFilesTool({
          pathGuard: makePathGuard(ws),
          trackRead: () => undefined,
          excludeDirs: [],
        })
        await expect(
          tool.execute(
            { path: outside.root, maxDepth: 1, limit: 10 },
            makeToolContext({ workspace: ws }),
          ),
        ).rejects.toMatchObject({ code: "PATH_POLICY_VIOLATION" })
      } finally {
        await outside.cleanup()
      }
    })
  })
})

describe("tools/builtin: edit / write", () => {
  it("edit_file 改动磁盘内容并返回 diff", async () => {
    await withWorkspace(async (ws) => {
      const file = await ws.write("src/a.ts", "const value = 1\n")
      const editEngine = new EditEngine()
      await editEngine.recordRead(
        file,
        (await import("node:fs")).statSync(file).mtimeMs,
        "const value = 1\n",
      )
      const tool = createEditFileTool({ pathGuard: makePathGuard(ws), editEngine })
      const out = (await tool.execute(
        {
          path: file,
          oldString: "const value = 1",
          newString: "const value = 2",
          allowMultiple: false,
        },
        makeToolContext({ workspace: ws, readTracker: editEngine }),
      )) as { path: string; matches: number; additions: number; deletions: number; note: string }
      expect(out.matches).toBe(1)
      expect(out.note).toContain("+1")
      expect(out.additions).toBe(1)
      expect(out.deletions).toBe(1)
      expect(await ws.read("src/a.ts")).toBe("const value = 2\n")
    })
  })

  it("edit_file 未经 read 会因为 read-before-edit 失败（真实文件+真实 tracker）", async () => {
    await withWorkspace(async (ws) => {
      const file = await ws.write("src/a.ts", "const value = 1\n")
      const editEngine = new EditEngine()
      const tool = createEditFileTool({ pathGuard: makePathGuard(ws), editEngine })
      const result = await runToolVia(
        tool,
        { path: file, oldString: "const value = 1", newString: "x", allowMultiple: false },
        ws,
        editEngine,
      )
      expect(result).toMatchObject({ code: "READ_BEFORE_EDIT" })
    })
  })

  it("write_file 覆写已有文件需要显式 overwrite，防误覆盖", async () => {
    await withWorkspace(async (ws) => {
      const file = await ws.write("src/a.ts", "original\n")
      const editEngine = new EditEngine()
      await editEngine.recordRead(
        file,
        (await import("node:fs")).statSync(file).mtimeMs,
        "original\n",
      )
      const tool = createWriteFileTool({ pathGuard: makePathGuard(ws), editEngine })
      await expect(
        tool.execute(
          { path: file, content: "new", overwrite: false, maxBytes: 64_000 },
          makeToolContext({ workspace: ws }),
        ),
      ).rejects.toThrow()
    })
  })

  it("write_file 新建文件无需先读", async () => {
    await withWorkspace(async (ws) => {
      const editEngine = new EditEngine()
      const tool = createWriteFileTool({ pathGuard: makePathGuard(ws), editEngine })
      const out = await tool.execute(
        {
          path: ws.abs("src/new.ts"),
          content: "export const x = 1\n",
          overwrite: false,
          maxBytes: 64_000,
        },
        makeToolContext({ workspace: ws }),
      )
      expect(out).toBeDefined()
      expect(await ws.read("src/new.ts")).toBe("export const x = 1\n")
    })
  })

  it("写入非法 JSON 会被拦下（写后校验）", async () => {
    await withWorkspace(async (ws) => {
      const file = await ws.write("config.json", '{ "a": 1 }')
      const editEngine = new EditEngine()
      await editEngine.recordRead(
        file,
        (await import("node:fs")).statSync(file).mtimeMs,
        '{ "a": 1 }',
      )
      const tool = createEditFileTool({ pathGuard: makePathGuard(ws), editEngine })
      await expect(
        tool.execute(
          { path: file, oldString: '{ "a": 1 }', newString: '{ "a": 1, }', allowMultiple: false },
          makeToolContext({ workspace: ws, readTracker: editEngine }),
        ),
      ).rejects.toThrow()
      expect(await ws.read("config.json")).toBe('{ "a": 1 }')
    })
  })
})

async function runToolVia(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: { execute(input: any, ctx: any): Promise<unknown> },
  input: unknown,
  ws: Awaited<ReturnType<typeof createTempWorkspace>>,
  tracker: EditEngine,
): Promise<unknown> {
  try {
    await tool.execute(input, makeToolContext({ workspace: ws, readTracker: tracker }))
    return undefined
  } catch (err) {
    return err
  }
}

describe("tools/builtin: command / test", () => {
  it("command.run 导出结构化请求（executable + args），并渲染结果", async () => {
    await withWorkspace(async (ws) => {
      const runner = fakeCommandRunner({ stdout: "done\n", exitCode: 0 })
      const tool = createCommandRunTool({ pathGuard: makePathGuard(ws) })
      const input = {
        executable: "git",
        args: ["status"],
        cwd: ws.root,
        timeoutMs: 30_000,
        networkProfile: "none" as const,
        reason: "check status",
        onTimeout: "kill" as const,
      }
      expect(tool.policyCommand?.(input)).toMatchObject({ executable: "git", args: ["status"] })

      const out = (await tool.execute(
        input,
        makeToolContext({ workspace: ws, runCommand: runner }),
      )) as {
        exitCode: number
        output: string
      }
      expect(out.exitCode).toBe(0)
      expect(out.output).toContain("done")
    })
  })

  it("command.run 在非零退出时给出可操作提示", async () => {
    await withWorkspace(async (ws) => {
      const runner = fakeCommandRunner({ stdout: "", stderr: "boom", exitCode: 1 })
      const tool = createCommandRunTool({ pathGuard: makePathGuard(ws) })
      const out = (await tool.execute(
        {
          executable: "node",
          args: ["-e", "1"],
          cwd: ws.root,
          timeoutMs: 30_000,
          networkProfile: "none" as const,
          reason: "r",
          onTimeout: "kill" as const,
        },
        makeToolContext({ workspace: ws, runCommand: runner }),
      )) as { exitCode: number; output: string }
      expect(out.exitCode).toBe(1)
      expect(out.output.toLowerCase()).toMatch(/exit code|failed|failed with|command/)
    })
  })

  it("discoverChecks 从 package.json 识别 runner 与命令", () => {
    const checks = discoverChecks({
      scripts: {
        typecheck: "tsc --noEmit",
        test: "vitest run",
        lint: "eslint .",
        build: "tsc -p tsconfig.json",
      },
      packageManager: "pnpm@9",
    })
    const ids = checks.map((c) => c.id)
    expect(ids).toContain("typecheck")
    expect(ids).toContain("test")
    expect(checks.find((c) => c.id === "test")?.command[0]).toBe("pnpm")
  })

  it("discoverChecks 在没有脚本时返回空而不是崩", () => {
    expect(discoverChecks({})).toEqual([])
  })

  it("extractFailureSummary 抽取关键失败行并限制长度", () => {
    const summary = extractFailureSummary(
      `noise\nFAIL src/a.test.ts > case one\nAssertionError: expected 1 to be 2\n${"x".repeat(9000)}tail-a`,
      "",
    )
    expect(summary).toContain("FAIL")
    expect(summary).toContain("AssertionError")
    expect(summary.length).toBeLessThan(9_000)
  })
})

describe("tools/builtin: plan / tool_search", () => {
  it("plan.enter_plan_mode 返回激活状态与下一步提示", async () => {
    await withWorkspace(async (ws) => {
      const controller = {
        enter: () => ({ active: true as const }),
        exit: () => ({ status: "submitted" as const, steps: 0 }),
        isActive: () => true,
      }
      const tool = createEnterPlanModeTool(controller)
      expect(tool.deferred).toBe(true)
      const out = await tool.execute(
        { reason: "multi-file change" },
        makeToolContext({ workspace: ws }),
      )
      expect(out).toMatchObject({ active: true })
      // 描述必须与现实一致：它承诺"写工具不可用"，那就不能只是"不建议使用"
      expect(tool.description).toMatch(/removed from your tool list/)
    })
  })

  it("plan.exit_plan_mode 校验步骤 id 唯一与依赖存在（走 executor 才会跑到 validate）", async () => {
    await withWorkspace(async (ws) => {
      const submitted: unknown[] = []
      const controller = {
        enter: () => ({ active: true as const }),
        exit: (plan: unknown) => {
          submitted.push(plan)
          return { status: "submitted" as const, steps: 1 }
        },
        isActive: () => true,
      }
      const { registry, executor } = makeToolRuntime({ workspace: ws })
      registry.registerWithLengthCheck(createExitPlanModeTool(controller), "builtin")

      const duplicateId = await runTool(executor, "plan.exit_plan_mode", {
        plan: {
          summary: "do the thing",
          steps: [
            { id: "s1", objective: "first" },
            { id: "s1", objective: "dup id" },
          ],
        },
      })
      expect(duplicateId.status).toBe("failed")
      expect(duplicateId.error?.message).toMatch(/Duplicate step id/)

      const badDependency = await runTool(executor, "plan.exit_plan_mode", {
        plan: {
          summary: "do the thing",
          steps: [{ id: "s1", objective: "first", dependencies: ["missing"] }],
        },
      })
      expect(badDependency.status).toBe("failed")
      expect(badDependency.error?.message).toMatch(/unknown step/)

      const ok = await runTool(executor, "plan.exit_plan_mode", {
        plan: { summary: "do the thing", steps: [{ id: "s1", objective: "first" }] },
      })
      expect(ok.status).toBe("succeeded")
      expect(submitted).toHaveLength(1)
    })
  })

  it("tool_search 按关键字打分并激活命中工具（下一轮才带 schema）", async () => {
    await withWorkspace(async (ws) => {
      const activated: string[][] = []
      const tool = createToolSearchTool({
        listDeferred: () => [
          {
            name: "mcp.linear_create_issue",
            description: "create issues",
            keywords: ["mcp", "linear", "issue"],
          },
          { name: "mcp.slack_post", description: "post messages", keywords: ["mcp", "slack"] },
        ],
        activate: (names) => activated.push(names),
      })
      const out = (await tool.execute(
        { query: "linear issue", limit: 5 },
        makeToolContext({ workspace: ws }),
      )) as { activated: string[]; note: string }
      expect(out.activated[0]).toBe("mcp.linear_create_issue")
      expect(activated[0]).toContain("mcp.linear_create_issue")
      expect(out.note).toMatch(/next request/)
    })
  })

  it("tool_search 无命中时不激活任何工具", async () => {
    await withWorkspace(async (ws) => {
      const activated: string[][] = []
      const tool = createToolSearchTool({
        listDeferred: () => [{ name: "mcp.slack_post", description: "post", keywords: ["slack"] }],
        activate: (names) => activated.push(names),
      })
      const out = (await tool.execute(
        { query: "zzzz", limit: 5 },
        makeToolContext({ workspace: ws }),
      )) as {
        activated: string[]
        note: string
      }
      expect(out.activated).toEqual([])
      expect(activated).toEqual([])
      expect(out.note).toMatch(/No deferred tool matched/)
    })
  })
})

describe("tools: 路径与 ci 纪律收口", () => {
  it("内置工具的入参一律要求绝对路径", async () => {
    await withWorkspace(async (ws) => {
      const readInput = createReadFileTool(
        { pathGuard: makePathGuard(ws), trackRead: () => undefined, excludeDirs: [] },
        { maxBytes: 1024, maxOutputTokens: 1024 },
      ).inputSchema
      expect(readInput.safeParse({ path: "relative/path.ts" }).success).toBe(false)
      expect(readInput.safeParse({ path: ws.abs("a.ts") }).success).toBe(true)
      void path
    })
  })
})
