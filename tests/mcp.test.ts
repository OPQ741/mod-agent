/**
 * MCP stdio 集成测试。
 *
 * 用一个真的子进程假 server（不是 mock 协议）验证四件事：
 * 1. initialize → tools/list → tools/call 这条链路能跑通，模型真的拿到结果；
 * 2. 外部工具默认按 external_side_effect 处理，bypassPermissions 下仍要审批；
 * 3. 超长工具名被显式拒绝注册，不会把工具表撑坏；
 * 4. 连接状态进 doctor，失败可见。
 */

import { afterEach, describe, expect, it } from "vitest"

import { PolicyEngine } from "../src/policy/engine.js"
import { createTempWorkspace, createTestRuntime, settingsWith } from "./helpers.js"
import { driveTask } from "../src/runtime/driver.js"
import { final, toolUse } from "../src/model/scripted.js"
import type { TempWorkspace } from "./helpers.js"

const workspaces: TempWorkspace[] = []

afterEach(async () => {
  while (workspaces.length > 0) await workspaces.pop()?.cleanup()
})

const SERVER_SCRIPT = String.raw`
const readline = require("node:readline")
const mode = process.env.MCP_MODE || "echo"
const tools = [
  {
    name: "echo",
    description: "Echo the provided text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  { name: "leak", description: "Report whether a parent-process secret is visible" },
]
if (mode === "long") tools.push({ name: "x".repeat(120), description: "too long" })
const rl = readline.createInterface({ input: process.stdin })
rl.on("line", (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (!message || typeof message.id !== "number") return
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n")
  const fail = (text) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } }) + "\n")
  if (message.method === "initialize") return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0" } })
  if (message.method === "tools/list") return reply({ tools })
  if (message.method === "tools/call") {
    const name = message.params && message.params.name
    const args = (message.params && message.params.arguments) || {}
    if (name === "leak") return reply({ content: [{ type: "text", text: "SECRET:" + String(process.env.MCP_TEST_SECRET || "none") }], isError: false })
    if (name !== "echo") return fail("unknown tool")
    return reply({ content: [{ type: "text", text: "ECHO:" + String(args.text) }], isError: false })
  }
  return fail("unsupported method")
})
`

async function setup(mode: "echo" | "long" = "echo") {
  const ws = await createTempWorkspace()
  workspaces.push(ws)
  await ws.write("mcp-server.js", SERVER_SCRIPT)
  const settings = settingsWith({
    permissionMode: "bypassPermissions",
    // 外部副作用要显式放行：这条规则就是"我知道这个 server 会往外做事"
    permissions: { allow: ["mcp.demo.echo", "mcp.demo.leak"], ask: [], deny: [] },
    mcpServers: {
      demo: {
        command: process.execPath,
        args: [ws.abs("mcp-server.js")],
        env: { MCP_MODE: mode },
        timeoutMs: 5_000,
      },
    },
  })
  return { ws, settings }
}

describe("MCP · stdio 客户端", () => {
  it("假 server 的 echo 工具能被模型调用，结果真的回灌", async () => {
    const { ws, settings } = await setup()
    const runtime = await createTestRuntime({
      workspace: ws,
      script: [
        toolUse("tool_search", { query: "echo" }),
        toolUse("mcp.demo.echo", { text: "hi" }),
        final("done"),
      ],
      settings,
    })
    const taskId = await runtime.createTask({
      title: "mcp",
      userRequest: "call echo",
      mode: "edit",
    })
    const result = await driveTask(runtime, taskId, {
      resolveApproval: async () => ({ decision: "allowed", by: "tester" }),
    })

    expect(result.outcome?.status).toBe("completed")
    expect(JSON.stringify(await runtime.store.getMessages(taskId))).toContain("ECHO:hi")
    await runtime.close()
  })

  it("外部工具在 bypassPermissions 下默认仍要审批（放行只认显式 allow 规则）", async () => {
    const engine = new PolicyEngine({
      settings: settingsWith({ permissionMode: "bypassPermissions" }),
      cwd: process.cwd(),
      hasTty: true,
    })
    const decision = await engine.evaluate({
      toolName: "mcp.demo.echo",
      risk: "external_side_effect",
      args: { text: "hi" },
      permissionMode: "bypassPermissions",
      taskMode: "edit",
    })
    expect(decision.effect).toBe("ask")
  })

  it("server 拿不到父进程的密钥，只有 mcpServers.env 里显式给的变量", async () => {
    const { ws, settings } = await setup()
    process.env.MCP_TEST_SECRET = "super-secret"
    try {
      const runtime = await createTestRuntime({
        workspace: ws,
        script: [
          toolUse("tool_search", { query: "leak" }),
          toolUse("mcp.demo.leak", {}),
          final("done"),
        ],
        settings,
      })
      const taskId = await runtime.createTask({
        title: "mcp env",
        userRequest: "check env",
        mode: "edit",
      })
      await driveTask(runtime, taskId, {
        resolveApproval: async () => ({ decision: "allowed", by: "tester" }),
      })
      const messages = JSON.stringify(await runtime.store.getMessages(taskId))
      expect(messages).toContain("SECRET:none")
      expect(messages).not.toContain("super-secret")
      await runtime.close()
    } finally {
      delete process.env.MCP_TEST_SECRET
    }
  })

  it("server 起不来时 doctor 仍能返回，并标出连接失败原因", async () => {
    const ws = await createTempWorkspace()
    workspaces.push(ws)
    const runtime = await createTestRuntime({
      workspace: ws,
      script: [],
      settings: settingsWith({
        mcpServers: {
          broken: {
            command: "definitely-not-a-real-mcp-command-xyz",
            args: [],
            timeoutMs: 1_000,
          },
        },
      }),
    })
    const report = await runtime.doctor()
    const status = report.mcpServers.find((server) => server.name === "broken")
    expect(status?.connected).toBe(false)
    expect(status?.error && status.error.length > 0).toBe(true)
    await runtime.close()
  })

  it("超长工具名被拒绝注册；doctor 仍能报告 server 已连接", async () => {
    const { ws, settings } = await setup("long")
    const runtime = await createTestRuntime({ workspace: ws, script: [], settings })
    const report = await runtime.doctor()
    const status = report.mcpServers.find((server) => server.name === "demo")
    expect(status?.connected).toBe(true)
    expect(status?.tools).toContain("mcp.demo.echo")
    expect(status?.tools?.some((name) => name.length > 80)).toBe(false)
    expect(report.tools.some((name) => name.length > 80)).toBe(false)
    await runtime.close()
  })
})
