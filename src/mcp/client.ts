/**
 * MCP stdio 客户端（roadmap E2）。
 *
 * 只实现必要子集：`initialize` → `notifications/initialized` → `tools/list` →
 * `tools/call`，传输用 stdio 的逐行 JSON-RPC。没有实现 SSE / WebSocket，
 * 因为本地 CLI 的第一需求是"能接一个本地 server"，把信任边界做对比铺协议更重要。
 *
 * 三个安全约束：
 * 1. 工具默认 `risk: "external_side_effect"`、`non_idempotent` —— server 没声明
 *    风险不代表它安全，契约按最坏情况兜底；
 * 2. 外部 JSON Schema 原样下发，并做一次**独立**校验（不依赖 server 自愿校验）；
 * 3. 连接失败 / 超时只记录诊断并跳过，不阻塞 agent 启动。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

import { z } from "zod"

import type { AgentTool } from "../shared/contracts.js"
import type { JsonSchemaObject } from "../shared/json-schema.js"

export interface McpStdioConfig {
  /** 省略时按 stdio，兼容已有配置。 */
  transport?: "stdio"
  command: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  timeoutMs?: number
}

export interface McpHttpConfig {
  transport: "http"
  url: string
  /** 额外请求头（例如 Authorization）；只从用户显式配置读取，不继承父进程环境。 */
  headers?: Readonly<Record<string, string>>
  timeoutMs?: number
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig

export interface McpConnection {
  readonly serverName: string
  readonly lastStderr: string
  connect(): Promise<McpToolDefinition[]>
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>
  close(): Promise<void>
}

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: JsonSchemaObject
}

export interface McpCallResult {
  text: string
  isError: boolean
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const MCP_ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SystemRoot",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
]

/** 只透传运行 server 必需的非敏感变量；API Key 等必须由用户在 mcpServers.env 里显式给。 */
function buildMcpEnv(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of MCP_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...(extra ?? {}) }
}

export class McpClient implements McpConnection {
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private stderrTail = ""
  private closed = false

  constructor(
    readonly serverName: string,
    private readonly config: McpStdioConfig,
    private readonly cwd: string,
  ) {}

  get lastStderr(): string {
    return this.stderrTail.trim()
  }

  async connect(): Promise<McpToolDefinition[]> {
    const timeoutMs = this.config.timeoutMs ?? 10_000
    const child = spawn(this.config.command, [...(this.config.args ?? [])], {
      cwd: this.cwd,
      env: buildMcpEnv(this.config.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    })
    this.child = child
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2_000)
    })
    child.on("error", (err) => this.failAll(err instanceof Error ? err : new Error(String(err))))
    // server 中途死掉时写 stdin 会抛 EPIPE；不接住它会让整个进程崩掉
    child.stdin.on("error", (err: Error) => this.failAll(err))
    child.on("exit", () => this.failAll(new Error("MCP server exited")))

    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line))

    await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mod-agent", version: "0.0.0" },
      },
      timeoutMs,
    )
    this.notify("notifications/initialized", {})
    const listed = await this.request("tools/list", {}, timeoutMs)
    return parseToolList(listed)
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const timeoutMs = this.config.timeoutMs ?? 10_000
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs)
    return parseCallResult(result)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.failAll(new Error("MCP client closed"))
    const child = this.child
    this.child = undefined
    if (!child || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill()
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error("MCP server is not running"))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`))
        // 超时的 server 不能继续留在连接池里：下一次请求可能永远等不到响应
        this.failAll(new Error(`MCP ${method} timed out`))
        this.child?.kill()
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return
    }
    const record = parsed as {
      id?: unknown
      result?: unknown
      error?: { message?: string }
    }
    if (typeof record.id !== "number") return
    const pending = this.pending.get(record.id)
    if (!pending) return
    this.pending.delete(record.id)
    clearTimeout(pending.timer)
    if (record.error) pending.reject(new Error(record.error.message ?? "MCP request failed"))
    else pending.resolve(record.result)
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }
}

const MCP_PROTOCOL_VERSION = "2024-11-05"

/**
 * MCP Streamable HTTP 客户端（非 stdio 传输）。
 *
 * 只实现无状态请求/响应子集：POST JSON-RPC，响应可以是 `application/json`，
 * 也可以是 `text/event-stream`（单条 message 事件）。不维护长期 GET 流，
 * 也不实现旧版 HTTP+SSE endpoint 协议。
 *
 * 信任边界与 stdio 客户端一致：外部工具默认 `external_side_effect`，
 * 返回值按不可信数据处理；header 只从用户显式配置读取。
 */
export class McpHttpClient implements McpConnection {
  readonly lastStderr = ""
  private sessionId: string | undefined
  private nextId = 1
  private closed = false

  constructor(
    readonly serverName: string,
    private readonly config: McpHttpConfig,
  ) {}

  async connect(): Promise<McpToolDefinition[]> {
    await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "mod-agent", version: "0.0.0" },
      },
      true,
    )
    await this.notify("notifications/initialized", {})
    const listed = await this.request("tools/list", {}, false)
    return parseToolList(listed)
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request("tools/call", { name, arguments: args }, false)
    return parseCallResult(result)
  }

  async close(): Promise<void> {
    this.closed = true
    this.sessionId = undefined
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    allowBeforeInit: boolean,
  ): Promise<unknown> {
    if (this.closed) throw new Error("MCP HTTP client is closed")
    const id = this.nextId++
    const text = await this.sendRpc({ jsonrpc: "2.0", id, method, params }, allowBeforeInit)
    if (text === undefined) throw new Error(`MCP ${method} returned an empty response`)
    const payload = parseHttpPayload(text, id)
    const record = payload as { result?: unknown; error?: { message?: string } }
    if (record.error) throw new Error(record.error.message ?? `MCP ${method} failed`)
    if (!("result" in record)) throw new Error(`MCP ${method} response has no result`)
    return record.result
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.closed) return
    // 202 Accepted 是通知的正常回应；有 body 也不解析
    await this.sendRpc({ jsonrpc: "2.0", method, params }, false)
  }

  /** 发一条 JSON-RPC，读完整响应体；超时覆盖到 body 读完，而不是只覆盖响应头。 */
  private async sendRpc(
    payload: Record<string, unknown>,
    allowBeforeInit: boolean,
  ): Promise<string | undefined> {
    const timeoutMs = this.config.timeoutMs ?? 10_000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.config.headers ?? {}),
      }
      if (this.sessionId) headers["mcp-session-id"] = this.sessionId
      if (!allowBeforeInit) headers["mcp-protocol-version"] = MCP_PROTOCOL_VERSION
      const response = await fetch(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const sessionId = response.headers.get("mcp-session-id")
      if (sessionId) this.sessionId = sessionId
      const text = await response.text()
      if (!response.ok) throw new Error(httpError(response, text))
      return text.trim().length > 0 ? text : undefined
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`MCP HTTP request timed out after ${timeoutMs}ms`, { cause: err })
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
}

function httpError(response: Response, text: string): string {
  const body = text.slice(0, 300)
  return `MCP HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}${body ? `: ${body}` : ""}`
}

/**
 * `application/json` 直接解析；`text/event-stream` 从 `data:` 事件里找匹配 id 的消息。
 * 不匹配 id 的通知（例如进度）直接忽略。
 */
export function parseHttpPayload(text: string, id: number): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith("{")) return JSON.parse(trimmed)
  const messages: unknown[] = []
  let data: string[] = []
  const flush = (): void => {
    if (data.length === 0) return
    const raw = data.join("\n")
    data = []
    if (raw.trim().length === 0) return
    try {
      messages.push(JSON.parse(raw))
    } catch {
      // 非 JSON 的 SSE 事件不是 MCP 消息，跳过
    }
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart())
    } else if (line.trim().length === 0) {
      flush()
    }
  }
  flush()
  const matched = messages.find((message) => {
    const record = message as { id?: unknown }
    return record.id === id
  })
  if (!matched) throw new Error(`MCP HTTP SSE response did not contain a message for id ${id}`)
  return matched
}

export function createMcpConnection(
  serverName: string,
  config: McpServerConfig,
  cwd: string,
): McpConnection {
  return "command" in config
    ? new McpClient(serverName, config, cwd)
    : new McpHttpClient(serverName, config)
}

const EmptyObject = z.record(z.string(), z.unknown())

export function createMcpTool(input: {
  serverName: string
  definition: McpToolDefinition
  client: McpConnection
}): AgentTool<Record<string, unknown>> {
  const toolName = `mcp.${slug(input.serverName)}.${slug(input.definition.name)}`
  return {
    name: toolName,
    description:
      `[external MCP server "${input.serverName}"] ` +
      (input.definition.description?.trim() ||
        `Calls the "${input.definition.name}" tool exposed by this MCP server.`),
    inputSchema: EmptyObject,
    ...(input.definition.inputSchema ? { externalInputSchema: input.definition.inputSchema } : {}),
    risk: "external_side_effect",
    idempotency: "non_idempotent",
    timeoutMs: 30_000,
    deferred: true,
    isReadOnly: false,
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>) {
      const problem = input.definition.inputSchema
        ? validateAgainstSchema(args, input.definition.inputSchema)
        : undefined
      if (problem) throw new Error(`Invalid arguments for ${toolName}: ${problem}`)
      const result = await input.client.callTool(input.definition.name, args)
      /**
       * 外部 server 的文本是**不可信内容**，不是本地工具输出。
       * 不标记的话，模型会把它当成同等可信的项目事实照做；标记后它知道
       * 这段文字只描述 server 返回的数据，不能改写权限或安全规则。
       */
      return {
        server: input.serverName,
        tool: input.definition.name,
        trust: "untrusted_external",
        text: `[UNTRUSTED EXTERNAL CONTENT from MCP server "${input.serverName}"]\n${result.text}`,
        isError: result.isError,
      }
    },
  }
}

/** 最小 JSON Schema 校验：object/required/properties/array/string/number/boolean + enum。 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchemaObject,
): string | undefined {
  const type = schema.type
  if (typeof type === "string") {
    if (
      type === "object" &&
      (typeof value !== "object" || value === null || Array.isArray(value))
    ) {
      return `expected object, got ${describeType(value)}`
    }
    if (type === "array" && !Array.isArray(value))
      return `expected array, got ${describeType(value)}`
    if (type === "string" && typeof value !== "string") {
      return `expected string, got ${describeType(value)}`
    }
    if (type === "number" && typeof value !== "number") {
      return `expected number, got ${describeType(value)}`
    }
    if (type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
      return `expected integer, got ${describeType(value)}`
    }
    if (type === "boolean" && typeof value !== "boolean") {
      return `expected boolean, got ${describeType(value)}`
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === value)) {
    return `value is not one of the allowed enum values`
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in record)) return `missing required property "${key}"`
      }
    }
    const properties = schema.properties
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [key, child] of Object.entries(properties)) {
        if (!(key in record)) continue
        const childSchema = child as JsonSchemaObject
        const problem = validateAgainstSchema(record[key], childSchema)
        if (problem) return `${key}: ${problem}`
      }
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
    for (let i = 0; i < value.length; i += 1) {
      const problem = validateAgainstSchema(value[i], schema.items as JsonSchemaObject)
      if (problem) return `[${i}]: ${problem}`
    }
  }
  return undefined
}

function parseToolList(result: unknown): McpToolDefinition[] {
  const record = result as { tools?: unknown } | undefined
  if (!Array.isArray(record?.tools)) return []
  const tools: McpToolDefinition[] = []
  for (const item of record.tools) {
    if (typeof item !== "object" || item === null) continue
    const tool = item as { name?: unknown; description?: unknown; inputSchema?: unknown }
    if (typeof tool.name !== "string" || tool.name.length === 0) continue
    tools.push({
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(typeof tool.inputSchema === "object" && tool.inputSchema !== null
        ? { inputSchema: tool.inputSchema as JsonSchemaObject }
        : {}),
    })
  }
  return tools
}

function parseCallResult(result: unknown): McpCallResult {
  const record = result as { content?: unknown; isError?: unknown } | undefined
  const parts: string[] = []
  if (Array.isArray(record?.content)) {
    for (const item of record.content) {
      const block = item as { type?: unknown; text?: unknown }
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text)
    }
  }
  return { text: parts.join("\n"), isError: record?.isError === true }
}

function slug(value: string): string {
  const out = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  return out.length > 0 ? out : "tool"
}

function describeType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}
