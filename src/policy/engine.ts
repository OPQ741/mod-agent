/**
 * 权限判定引擎（security.md §4.2）。
 *
 * 这是一个**纯函数式**模块：输入是配置规则 + 已展开的结构化入参，输出三态。
 * 它不读模型说了什么，也不读仓库文件里写了什么 —— IssueTrojanBench 实测 66.5% 的
 * 恶意 issue 能穿透全部 agent 与模型层防护，靠提示词叮嘱等于一条没有约束力的建议。
 *
 * 判定序固定（三段独立检查，**deny 永远第一**，命中即返回，任何模式都不翻案）：
 *   ① deny（含 bypass-immune 危险路径）→ ② allow → ③ 按权限档位裁决
 *
 * 因此这里刻意**不用** switch 的 fallthrough 表达三态，而是三段独立函数。
 */

import type { CommandRequest, PermissionMode, TaskMode, ToolRisk } from "../shared/contracts.js"
import type { Settings } from "../config/settings.js"
import { parameterHash } from "../shared/hash.js"
import {
  matchesBypassImmuneCommand,
  matchesBypassImmunePath,
  matchCommand,
  matchDomain,
  matchParam,
  matchPath,
  parseRule,
  type PathMatchContext,
  type PermissionRule,
  type RuleEffect,
} from "./rules.js"
import { isUnresolvableShape, parseCommandSegments, usesSudo } from "./command.js"

export interface PolicyRequest {
  toolName: string
  risk: ToolRisk
  args: Record<string, unknown>
  /** 命令类工具的结构化请求（executable + args[]，不是一整段字符串）。 */
  command?: CommandRequest
  /** 文件类工具涉及的路径（未解析，引擎内部做 realpath 判断前的字符串预筛）。 */
  paths?: readonly string[]
  domains?: readonly string[]
  permissionMode: PermissionMode
  taskMode: TaskMode
}

export interface PolicyDecision {
  effect: RuleEffect
  reason: string
  matchedRule?: string
  bypassImmune: boolean
  timeoutMs: number
  networkProfile: CommandRequest["networkProfile"]
  parameterHash: string
  /**
   * 累计拒绝已达上限（`maxCumulativeDenials`）。
   *
   * 这个标志是**判定结果的一部分**，不是异常：判定引擎是纯函数式的，
   * 它没有能力"中止任务"，只能把"该停了"这件事如实写进返回值。
   * 由调用方（执行器 → 主循环）决定怎么收场。
   *
   * 之前这里是 `recordDenial()` 直接 `throw DenialLimitExceeded`，
   * 而 `executor.execute` 与主循环都没有捕获它 —— 生成器一路抛穿，
   * 任务死在 `executing` 状态、库里的状态永远不再更新，
   * 同时绕开了"工具错误是数据不是异常"这条整个设计赖以成立的前提。
   */
  denialLimitReached?: boolean
}

/** 判定的核心三要素：档位裁决函数只产出这些字段，超时/网络/hash 由调用方补齐。 */
export interface DecisionCore {
  effect: RuleEffect
  reason: string
  matchedRule?: string
}

/** auto 档的独立裁决器。不可用时必须回落到 default，而不是直接放行。 */
export interface AutoClassifier {
  classify(request: PolicyRequest): Promise<"allow" | "deny" | "ask">
}

export interface PolicyEngineOptions {
  settings: Settings
  cwd: string
  homeDir?: string
  /** 是否有可交互终端。无 TTY 时确认类动作一律拒绝（不静默放行）。 */
  hasTty?: boolean
  classifier?: AutoClassifier
  /** 连续被拒多少次后回落到交互式确认（security.md §4.2 拒绝追踪）。 */
  consecutiveDenyFallback?: number
  /** 累计拒绝上限，达到即在判定结果里打 `denialLimitReached`，由调用方中止任务。 */
  maxCumulativeDenials?: number
}

export class PolicyEngine {
  private readonly settings: Settings
  private readonly pathCtx: PathMatchContext
  private readonly hasTty: boolean
  private readonly classifier?: AutoClassifier
  private readonly allowRules: Map<string, PermissionRule[]>
  private readonly denyRules: Map<string, PermissionRule[]>
  private readonly askRules: Map<string, PermissionRule[]>
  private readonly consecutiveDenyFallback: number
  private readonly maxCumulativeDenials: number

  private consecutiveDenials = 0
  private cumulativeDenials = 0
  /** 会话级放行记录：只在本会话有效、不写回配置（security.md §4.2）。 */
  private readonly sessionAllow = new Map<string, string>()

  constructor(options: PolicyEngineOptions) {
    this.settings = options.settings
    this.pathCtx = {
      cwd: options.cwd,
      homeDir: options.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? options.cwd,
    }
    this.hasTty = options.hasTty ?? false
    this.classifier = options.classifier
    this.consecutiveDenyFallback = options.consecutiveDenyFallback ?? 3
    this.maxCumulativeDenials = options.maxCumulativeDenials ?? 20

    this.allowRules = indexRules(options.settings.permissions.allow)
    this.denyRules = indexRules(options.settings.permissions.deny)
    this.askRules = indexRules(options.settings.permissions.ask)
  }

  /* ---------------- 审批记录 ---------------- */

  /**
   * 记录一次"本会话对相同参数放行"（key = tool + 参数 hash）。
   *
   * 表按工具名存**一个** hash：批准 `npm test` 后紧接着调 `npm install lodash`，
   * hash 不同就会重新问 —— 这正是"审批绑定参数"想要的行为。
   */
  grantSessionAllow(toolName: string, args: Record<string, unknown>): void {
    this.sessionAllow.set(toolName, parameterHash(args))
  }

  /**
   * 直接用 hash 授权（审批落点专用）。
   *
   * 审批记录里只保存 `parameterHash` 而不保存完整参数（少存一份可能含密钥的入参），
   * 所以批准时无法也不该反解出原参数。这里按 hash 原样记账，
   * 与 `hasSessionAllow` 计算的 `parameterHash(args)` 天然对得上；
   * 若改成 `grantSessionAllow(tool, { _approval: hash })` 则是给合成对象算 hash，
   * 两边永远不会相等，表现为"明明批过了还在反复问"。
   */
  grantSessionAllowHash(toolName: string, hash: string): void {
    this.sessionAllow.set(toolName, hash)
  }

  hasSessionAllow(toolName: string, args: Record<string, unknown>): boolean {
    const recorded = this.sessionAllow.get(toolName)
    return recorded !== undefined && recorded === parameterHash(args)
  }

  resetSessionAllow(): void {
    this.sessionAllow.clear()
  }

  get denialStats(): { consecutive: number; cumulative: number } {
    return { consecutive: this.consecutiveDenials, cumulative: this.cumulativeDenials }
  }

  /* ---------------- 主入口 ---------------- */

  async evaluate(request: PolicyRequest): Promise<PolicyDecision> {
    const base = {
      timeoutMs: this.settings.limits.commandTimeoutMs,
      networkProfile: (request.command?.networkProfile ??
        "none") as CommandRequest["networkProfile"],
      parameterHash: parameterHash(request.args),
    }

    // ① deny —— 最高优先级，任何模式（含 bypassPermissions）都不能翻案
    const denied = this.evaluateDeny(request)
    if (denied) {
      return this.asDenial(base, denied, denied.bypassImmune ?? false)
    }

    // ② allow —— 显式放行（含会话级放行）
    const allowed = this.evaluateAllow(request)
    if (allowed) {
      this.consecutiveDenials = 0
      return { ...base, ...allowed, bypassImmune: false }
    }

    // ③ 按权限档位裁决
    const decided = await this.decideByMode(request)
    if (decided.effect === "deny") {
      return this.asDenial(base, decided, false)
    }
    this.consecutiveDenials = 0
    return { ...base, ...decided, bypassImmune: false }
  }

  /**
   * 验证命令的判定入口（verification-and-multiagent.md §1）。
   *
   * 与 `evaluate` 的差别只有一条：**来源决定默认值**。
   *
   * - `bypass-immune` 与配置里的 deny 规则**永远生效**，与来源无关 ——
   *   这正是之前那个洞：验证流水线直接调沙箱，`rm -rf` 明明被判定为
   *   bypass-immune deny，却照样执行并报 `passed`。
   * - `无法静态解析的形状` 只拒"从仓库内容里发现的"命令：那条启发式是为
   *   模型生成的命令设计的，用户自己写进 `--check` 的命令不适用。
   * - 兜底：用户显式给的命令视为已授权；仓库内容发现的命令**不能自我授权**，
   *   必须命中显式 allow 规则或本会话审批记录才放行。
   *
   * 最后这条是这套判定的核心：`package.json` 的 `scripts.test` 是仓库内容，
   * 仓库内容不该有能力让 agent 去执行它自己写的命令。
   */
  async evaluateValidation(
    request: PolicyRequest,
    options: { userProvided: boolean },
  ): Promise<PolicyDecision> {
    const base = {
      timeoutMs: this.settings.limits.commandTimeoutMs,
      networkProfile: (request.command?.networkProfile ??
        "none") as CommandRequest["networkProfile"],
      parameterHash: parameterHash(request.args),
    }

    const immune = this.checkBypassImmune(request)
    if (immune) {
      return this.asDenial(base, { effect: "deny", reason: immune }, true)
    }

    if (!options.userProvided && request.command) {
      for (const segment of parseCommandSegments(request.command)) {
        const shape = isUnresolvableShape(segment)
        if (shape.unresolvable) {
          return this.asDenial(
            base,
            {
              effect: "deny",
              reason: `Refusing a discovered command that cannot be statically analyzed: ${shape.reason ?? "unknown"}`,
            },
            true,
          )
        }
      }
    }

    const denyRule = this.matchAgainst(this.denyRules, request, "deny")
    if (denyRule) {
      return this.asDenial(
        base,
        {
          effect: "deny",
          reason: `Denied by policy rule: ${denyRule.raw}`,
          matchedRule: denyRule.raw,
        },
        false,
      )
    }

    const allowed = this.evaluateAllow(request)
    if (allowed) {
      this.consecutiveDenials = 0
      return { ...base, ...allowed, bypassImmune: false }
    }

    if (options.userProvided) {
      this.consecutiveDenials = 0
      return {
        ...base,
        effect: "allow",
        reason: "Validation command was explicitly provided by the caller",
        bypassImmune: false,
      }
    }

    return this.asDenial(
      base,
      {
        effect: "deny",
        reason:
          "Discovered from repository content and not covered by an allow rule; " +
          "add an explicit permissions.allow entry (or approve the same command once) to authorize it",
      },
      false,
    )
  }

  /**
   * 收口一次拒绝：记账、判断是否到累计上限，并保证**不抛异常**。
   *
   * 判定引擎不中止任务，只报告"该停了"。抛异常会让拒绝从"数据"变成"控制流"，
   * 执行器与主循环的容错设计就全部失效。
   */
  private asDenial(
    base: Pick<PolicyDecision, "timeoutMs" | "networkProfile" | "parameterHash">,
    core: DecisionCore,
    bypassImmune: boolean,
  ): PolicyDecision {
    const limitReached = this.recordDenial()
    return {
      ...base,
      ...core,
      bypassImmune,
      ...(limitReached
        ? {
            denialLimitReached: true,
            reason: `${core.reason} (cumulative denial limit ${this.maxCumulativeDenials} reached; stop retrying and report)`,
          }
        : {}),
    }
  }

  /** 返回是否已到累计上限。**不抛异常**，见 `asDenial`。 */
  private recordDenial(): boolean {
    this.consecutiveDenials += 1
    this.cumulativeDenials += 1
    return this.cumulativeDenials >= this.maxCumulativeDenials
  }

  /* ---------------- ① deny ---------------- */

  private evaluateDeny(
    request: PolicyRequest,
  ): (DecisionCore & { bypassImmune?: boolean }) | undefined {
    // bypass-immune：即使 --dangerously-skip-permissions 也拦
    const immune = this.checkBypassImmune(request)
    if (immune) return { effect: "deny", reason: immune, bypassImmune: true }

    // 无法静态解析的命令形状（code-editing.md §3.3 规则 ④）
    if (request.command) {
      for (const segment of parseCommandSegments(request.command)) {
        const shape = isUnresolvableShape(segment)
        if (shape.unresolvable) {
          return {
            effect: "deny",
            reason: `Refusing a command that cannot be statically analyzed: ${shape.reason ?? "unknown"}`,
            bypassImmune: true,
          }
        }
      }
    }

    // 只读档（taskMode=ask）：任何写 / 命令都不注册，这里再兜一层
    if (request.taskMode === "ask" && request.risk !== "read") {
      return {
        effect: "deny",
        reason: `Task mode "ask" is read-only; ${request.toolName} has risk "${request.risk}"`,
      }
    }

    // plan 档：写 / 命令 / 外部副作用一律拒绝（agent-loop.md §3.2 只读契约）
    if (
      (request.permissionMode === "plan" || request.taskMode === "plan") &&
      request.risk !== "read"
    ) {
      return {
        effect: "deny",
        reason: `Plan mode is read-only; ${request.toolName} has risk "${request.risk}"`,
      }
    }

    // 配置里的 deny 规则
    const rule = this.matchAgainst(this.denyRules, request, "deny")
    if (rule) {
      return {
        effect: "deny",
        reason: `Denied by policy rule: ${rule.raw}`,
        matchedRule: rule.raw,
      }
    }
    return undefined
  }

  private checkBypassImmune(request: PolicyRequest): string | undefined {
    if (request.paths) {
      for (const p of request.paths) {
        if (matchesBypassImmunePath(p)) {
          return `Bypass-immune credential/system path: ${p}`
        }
      }
    }
    if (request.command) {
      for (const segment of parseCommandSegments(request.command)) {
        if (usesSudo(segment)) {
          return `Bypass-immune command: sudo is never auto-approved`
        }
        if (matchesBypassImmuneCommand(segment.executable)) {
          return `Bypass-immune command: "${segment.executable}" is never auto-approved`
        }
      }
    }
    return undefined
  }

  /* ---------------- ② allow ---------------- */

  private evaluateAllow(request: PolicyRequest): DecisionCore | undefined {
    if (this.hasSessionAllow(request.toolName, request.args)) {
      return {
        effect: "allow",
        reason: "Allowed by a session-scoped approval for these exact parameters",
      }
    }
    const rule = this.matchAgainst(this.allowRules, request, "allow")
    if (!rule) return undefined
    return {
      effect: "allow",
      reason: `Allowed by policy rule: ${rule.raw}`,
      matchedRule: rule.raw,
    }
  }

  /* ---------------- ③ 权限档位 ---------------- */

  private async decideByMode(request: PolicyRequest): Promise<DecisionCore> {
    // 命中显式 ask 规则 —— 任何模式都不会自动批准
    const askRule = this.matchAgainst(this.askRules, request, "ask")
    if (askRule) {
      return {
        effect: "ask",
        reason: `Explicit ask rule: ${askRule.raw}`,
        matchedRule: askRule.raw,
      }
    }

    const readOnly = request.risk === "read"

    switch (request.permissionMode) {
      case "bypassPermissions":
        return {
          effect: "allow",
          reason: "bypassPermissions mode (bypass-immune checks still applied above)",
        }

      case "dontAsk":
        // 无人值守档：本该弹框的动作一律自动拒绝，而不是全放行
        if (readOnly) {
          return { effect: "allow", reason: "Read inside the workspace is allowed in dontAsk mode" }
        }
        return {
          effect: "deny",
          reason: "dontAsk mode: actions that would prompt are automatically denied",
        }

      case "acceptEdits":
        if (readOnly || request.risk === "workspace_write") {
          return { effect: "allow", reason: "acceptEdits mode allows reads and file edits" }
        }
        return {
          effect: "ask",
          reason: "acceptEdits mode still asks for commands and external effects",
        }

      case "auto": {
        const verdict = await this.classifyWithFallback(request)
        if (verdict === "allow")
          return { effect: "allow", reason: "Auto-mode classifier allowed this action" }
        if (verdict === "deny")
          return { effect: "deny", reason: "Auto-mode classifier denied this action" }
        return {
          effect: "ask",
          reason: "Auto-mode classifier is unsure; falling back to confirmation",
        }
      }

      case "plan":
        // 上面 evaluateDeny 已拦掉非只读；这里剩下的都是只读
        return { effect: "allow", reason: "Plan mode allows read-only tools" }

      case "default":
      default:
        if (readOnly) {
          return { effect: "allow", reason: "Read-only tools are allowed in default mode" }
        }
        // 需要交互确认；无 TTY 时拒绝而不是静默放行
        if (!this.hasTty) {
          return {
            effect: "deny",
            reason: "No interactive TTY available; refusing instead of silently allowing",
          }
        }
        return { effect: "ask", reason: "Default mode requires interactive confirmation" }
    }
  }

  /**
   * auto 档分类器：与主模型解耦（独立模型、独立限流）。
   * 分类器不可用 / 抛错 / 拿不准，一律回落 `ask`（fail-closed），绝不直接放行。
   */
  private async classifyWithFallback(request: PolicyRequest): Promise<"allow" | "deny" | "ask"> {
    if (!this.classifier) return "ask"
    try {
      return await this.classifier.classify(request)
    } catch {
      return "ask"
    }
  }

  /* ---------------- 规则匹配 ---------------- */

  private matchAgainst(
    index: Map<string, PermissionRule[]>,
    request: PolicyRequest,
    effect: RuleEffect,
  ): PermissionRule | undefined {
    const candidates = collectCandidates(index, request.toolName)
    for (const rule of candidates) {
      if (this.ruleMatches(rule, request, effect)) return rule
    }
    return undefined
  }

  private ruleMatches(rule: PermissionRule, request: PolicyRequest, effect: RuleEffect): boolean {
    // 工具名不匹配直接跳过
    if (!toolNameMatches(rule.tool, request.toolName)) return false

    if (rule.kind === "all") return true

    if (rule.kind === "param") {
      return matchParam(rule, request.args)
    }

    if (rule.kind === "domain") {
      return (request.domains ?? []).some((host) => matchDomain(rule, host))
    }

    // 命令类：`Bash(npm run *)` 按子命令逐段匹配，全部通过才放行
    if (request.command) {
      const segments = parseCommandSegments(request.command)
      if (segments.length === 0) return false
      return segments.every((segment) => {
        // 只能精确匹配的形状：前缀规则永远放不倒
        if (segment.requiresExact && rule.kind !== "exact") return false
        return matchCommand(rule, segment.raw)
      })
    }

    // 路径类
    if (request.paths && request.paths.length > 0) {
      /**
       * 多路径的量化方向**随效应而变**，不能一律 `.some()`：
       * - deny / ask：任一路径命中就成立（`some`）；
       * - allow：**每一条**路径都要命中（`every`）。用 `some` 的话，
       *   `allow: ["Edit(src/**)"]` 会让 `[src/a.ts, ../../etc/passwd]`
       *   整体放行 —— 一条规则把没被规则覆盖的路径也一起批了。
       *
       * 今天只有只读工具会一次给出多个路径，所以这是潜伏缺陷；
       * 但等第一个多路径写工具出现，它就变成 P0。
       */
      const matches = (candidate: string): boolean =>
        matchPath(rule, candidate, effect, this.pathCtx)
      return effect === "allow" ? request.paths.every(matches) : request.paths.some(matches)
    }

    // 兜底：把参数序列化成文本做前缀/精确匹配
    return matchCommand(rule, JSON.stringify(request.args))
  }
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

/**
 * 按工具名索引规则。
 * 单条非法规则会导致整个索引不可用，因此这里**收集错误而不是抛错**，
 * 由调用方决定是拒绝启动还是退化为全 deny。
 */
export function indexRules(raws: readonly string[]): Map<string, PermissionRule[]> {
  const index = new Map<string, PermissionRule[]>()
  for (const raw of raws) {
    let rule: PermissionRule
    try {
      rule = parseRule(raw)
    } catch {
      // 非法规则不能静默丢弃 —— 但也不能因为一条坏规则让整个引擎起不来。
      // 这里抛错，由配置加载阶段（fail-closed）捕获。
      throw new Error(`Invalid permission rule: ${JSON.stringify(raw)}`)
    }
    const list = index.get(rule.tool) ?? []
    list.push(rule)
    index.set(rule.tool, list)
  }
  return index
}

/** 收集可能命中该工具名的规则（含 `*` 通配与 MCP server 级通配）。 */
function collectCandidates(
  index: Map<string, PermissionRule[]>,
  toolName: string,
): PermissionRule[] {
  const out: PermissionRule[] = []
  const direct = index.get(toolName)
  if (direct) out.push(...direct)

  for (const [key, rules] of index) {
    if (key === toolName) continue
    if (!key.includes("*")) continue
    const regex = new RegExp(`^${key.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)
    if (regex.test(toolName)) out.push(...rules)
  }
  return out
}

function toolNameMatches(ruleTool: string, actualTool: string): boolean {
  if (ruleTool === actualTool) return true
  if (!ruleTool.includes("*")) return false
  const regex = new RegExp(
    `^${ruleTool.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
  )
  return regex.test(actualTool)
}

/** 便捷函数：无状态的一次性判定（供测试与只读场景）。 */
export async function evaluateOnce(
  options: PolicyEngineOptions,
  request: PolicyRequest,
): Promise<PolicyDecision> {
  return new PolicyEngine(options).evaluate(request)
}
