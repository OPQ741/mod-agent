/**
 * 工具注册表与三层装配流水线（tools-and-extensions.md §2.1）。
 *
 * 模型这一轮能看到哪些工具不是静态清单，而是每轮装配的结果：
 *   ① 基础集：内置工具 + 按功能开关条件加载；
 *   ② 运行时过滤：任务模式 / deny 规则 / isEnabled / 权限档位；
 *   ③ 组装工具池：内置在前（字母序，保证前缀缓存稳定）、MCP 追加在后。
 *
 * 元数据默认值必须 **fail-closed**（tools-and-extensions.md §2.1）：
 * 标记出错时后果要落在"多打扰用户"这一边，而不是"静默放行"那一边。
 */

import type { AgentTool, PermissionMode, TaskMode } from "../shared/contracts.js"
import { assertConvertible } from "../shared/json-schema.js"
import type { ToolSpec } from "../model/types.js"

export interface RegisteredTool {
  tool: AgentTool
  /** 来源：builtin / mcp:<server> / plugin:<name> */
  origin: string
  /** 是否被 deny 规则整体摘除（注册表层收口，模型请求不到才真的请求不到）。 */
  disabledByPolicy: boolean
}

export interface AssembleOptions {
  taskMode: TaskMode
  permissionMode: PermissionMode
  /** 已被 tool_search 激活的延迟加载工具名。 */
  activatedDeferred?: ReadonlySet<string>
  /** 被策略整体摘除的工具名（deny 规则命中整个工具）。 */
  deniedTools?: ReadonlySet<string>
  /** 额外的工具白名单（子代理的四层过滤用）。 */
  allowTools?: ReadonlySet<string>
  /** 额外的工具黑名单。 */
  disallowTools?: ReadonlySet<string>
  /** 是否包含延迟加载工具的完整 schema（false 时只给名字）。 */
  includeDeferredSchemas?: boolean
}

export interface AssembledToolset {
  /** 下发给模型的完整工具规格。 */
  specs: ToolSpec[]
  /** 本轮可被执行的工具名。 */
  executable: string[]
  /** 延迟加载工具名（只给名字，不给 schema）。 */
  deferredNames: string[]
  /** 被过滤掉的工具名及原因，供审计。 */
  filtered: Array<{ name: string; reason: string }>
  /**
   * 缓存断点位置：内置工具之后的索引。
   * 动态挂接的 MCP 工具不能影响内置工具部分的前缀缓存命中（tools-and-extensions.md §1.1）。
   */
  cacheBreakpoint: number
}

export class DuplicateToolError extends Error {
  constructor(name: string) {
    super(`duplicate tool: ${name}`)
    this.name = "DuplicateToolError"
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()

  /**
   * 注册工具。重名直接抛错 —— 重名会让模型分不清该调哪一个。
   *
   * 形参写成泛型 `AgentTool<I>` 而不是 `AgentTool<unknown>`：`I` 只出现在
   * `isConcurrencySafe` / `execute` 等函数的**参数位**上，按逆变规则
   * `AgentTool<具体输入>` 无法赋给 `AgentTool<unknown>`，会让每个具体工具都编译不过。
   * 注册之后一律按 `AgentTool<unknown>` 使用（入参由 Zod 在运行期解析，
   * 类型层面的收窄到此为止），所以这里的转换只发生一次且被限制在本方法内。
   */
  register<I>(tool: AgentTool<I>, origin = "builtin"): void {
    if (this.tools.has(tool.name)) throw new DuplicateToolError(tool.name)
    // 注册时就确认 schema 能转成 JSON Schema，避免下发阶段才炸
    assertConvertible(tool.inputSchema, tool.name)
    this.tools.set(tool.name, {
      tool: tool as unknown as AgentTool,
      origin,
      disabledByPolicy: false,
    })
  }

  /** MCP 工具名长度显式校验：超 128 字符必须报错，不能静默丢弃。 */
  registerWithLengthCheck<I>(tool: AgentTool<I>, origin: string, maxLength = 128): void {
    if (tool.name.length > maxLength) {
      throw new Error(
        `MCP tool name too long: ${tool.name} (${tool.name.length} > ${maxLength}). ` +
          "Rename it on the server side; silently dropping it would hide the tool from the model.",
      )
    }
    this.register(tool, origin)
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name)?.tool
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  get originOf(): (name: string) => string | undefined {
    return (name: string) => this.tools.get(name)?.origin
  }

  names(): string[] {
    return [...this.tools.keys()]
  }

  size(): number {
    return this.tools.size
  }

  entries(): Array<{ name: string; tool: AgentTool; origin: string }> {
    return [...this.tools.entries()].map(([name, entry]) => ({
      name,
      tool: entry.tool,
      origin: entry.origin,
    }))
  }

  /** 摘除某个工具（plan 模式收走写工具用）。 */
  disable(name: string): void {
    const entry = this.tools.get(name)
    if (entry) entry.disabledByPolicy = true
  }

  enable(name: string): void {
    const entry = this.tools.get(name)
    if (entry) entry.disabledByPolicy = false
  }

  /**
   * 三层装配。
   *
   * 第 ② 层的关键：**只读档在注册层收口**（development-guide.md §7 第 5 步）。
   * plan / ask 模式不把写工具放进注册表，而不是放进去再在 policy 里拒 ——
   * 模型请求不到的工具，才真的请求不到。
   */
  assemble(options: AssembleOptions): AssembledToolset {
    const filtered: Array<{ name: string; reason: string }> = []
    const activated = options.activatedDeferred ?? new Set<string>()

    const all = this.entries()

    // ② 运行时过滤
    const kept: Array<{ name: string; tool: AgentTool; origin: string }> = []
    for (const entry of all) {
      if (options.deniedTools?.has(entry.name)) {
        filtered.push({ name: entry.name, reason: "denied by policy rule" })
        continue
      }
      if (options.disallowTools?.has(entry.name)) {
        filtered.push({ name: entry.name, reason: "disallowed for this agent" })
        continue
      }
      if (
        options.allowTools &&
        options.allowTools.size > 0 &&
        !options.allowTools.has(entry.name)
      ) {
        filtered.push({ name: entry.name, reason: "not in the allowed tool set" })
        continue
      }
      if (this.tools.get(entry.name)?.disabledByPolicy) {
        filtered.push({ name: entry.name, reason: "disabled by policy at registration" })
        continue
      }
      // 只读档：写 / 命令 / 外部副作用工具不进注册表
      const writeBlocked =
        (options.permissionMode === "plan" ||
          options.taskMode === "plan" ||
          options.taskMode === "ask") &&
        entry.tool.risk !== "read"
      if (writeBlocked) {
        filtered.push({
          name: entry.name,
          reason: "read-only mode: write/command tools are not registered",
        })
        continue
      }
      if (entry.tool.isEnabled) {
        let enabled: boolean
        try {
          enabled = entry.tool.isEnabled({
            mode: options.taskMode,
            permissionMode: options.permissionMode,
          })
        } catch {
          enabled = false
        }
        if (!enabled) {
          filtered.push({ name: entry.name, reason: "isEnabled() returned false" })
          continue
        }
      }
      kept.push(entry)
    }

    // ③ 分区排序：内置字母序在前，MCP 追加在后
    const builtin = kept
      .filter((e) => e.origin === "builtin")
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const external = kept
      .filter((e) => e.origin !== "builtin")
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    const ordered = [...builtin, ...external]
    const includeDeferred = options.includeDeferredSchemas ?? false

    const specs: ToolSpec[] = []
    const deferredNames: string[] = []
    for (const entry of ordered) {
      // 未激活的延迟加载工具只登记名字（模型会看到"缺这个能力，去 tool_search"）；
      // **已激活的必须给完整 schema** —— 否则 `tool_search` 激活了也调不进去，
      // 这正是"延迟加载"这条链路最容易被写坏的一环。
      if (entry.tool.deferred && !activated.has(entry.name) && !includeDeferred) {
        deferredNames.push(entry.name)
        continue
      }
      specs.push({
        name: entry.name,
        description: entry.tool.description,
        inputSchema: assertConvertible(entry.tool.inputSchema, entry.name),
      })
    }

    // 未激活的延迟工具不可执行 —— 模型请求不到 ≠ 执行时报 unknown tool。
    const executable = ordered
      .filter((e) => !e.tool.deferred || activated.has(e.name))
      .map((e) => e.name)

    return {
      specs,
      executable,
      deferredNames,
      filtered,
      cacheBreakpoint: builtin.length,
    }
  }

  /** fail-closed 元数据读取：未声明即按最保守值。 */
  static isConcurrencySafe(tool: AgentTool, input: unknown): boolean {
    if (!tool.isConcurrencySafe) return false
    try {
      return tool.isConcurrencySafe(input)
    } catch {
      return false
    }
  }

  static isReadOnly(tool: AgentTool): boolean {
    return tool.isReadOnly ?? false
  }

  static isDestructive(tool: AgentTool): boolean {
    return tool.isDestructive ?? false
  }
}
