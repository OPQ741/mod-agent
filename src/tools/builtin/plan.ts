/**
 * 规划模式工具与延迟加载检索（agent-loop.md §3.2 / tools-and-extensions.md §2.3）。
 *
 * `enter_plan_mode` / `exit_plan_mode` 的典型特征是**不常用**，所以打 `deferred`
 * 标记：平时不占 schema，需要时由 `tool_search` 激活。工具越多，下发的 schema 越占
 * token，模型挑错工具的概率也越大。
 */

import { z } from "zod"
import type { AgentTool, ToolExecutionContext } from "../../shared/contracts.js"
import { AppError } from "../../shared/errors.js"
import { ExecutionPlanSchema, type ExecutionPlan } from "../../shared/contracts.js"

/** 规划模式控制器：由 runtime 提供，工具本身不持有状态。 */
export interface PlanController {
  enter(): { planFilePath: string }
  exit(plan: ExecutionPlan): { status: "submitted"; planFilePath: string }
  isActive(): boolean
  planFilePath(): string
}

/* ------------------------------------------------------------------ *
 * plan.enter
 * ------------------------------------------------------------------ */

const EnterPlanModeInput = z.object({
  reason: z.string().min(1, "explain why planning is needed"),
})
export type EnterPlanModeInput = z.infer<typeof EnterPlanModeInput>

export function createEnterPlanModeTool(controller: PlanController): AgentTool<EnterPlanModeInput> {
  return {
    name: "plan.enter_plan_mode",
    description:
      "Enter plan mode: all write and command tools become unavailable (not merely discouraged), and you may only read, search, and write the plan file. Use this before a multi-file change.",
    inputSchema: EnterPlanModeInput,
    risk: "read",
    idempotency: "safe",
    timeoutMs: 5_000,
    deferred: true,
    isReadOnly: true,
    isConcurrencySafe: () => true,
    async execute(input, _ctx: ToolExecutionContext) {
      const { planFilePath } = controller.enter()
      return {
        active: true,
        planFilePath,
        reason: input.reason,
        note:
          `Plan mode is active. Write tools are no longer registered (you cannot request them). ` +
          `Write your plan to ${planFilePath}, then call plan.exit_plan_mode.`,
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 * plan.exit_plan_mode
 * ------------------------------------------------------------------ */

const ExitPlanModeInput = z.object({
  plan: ExecutionPlanSchema,
})
export type ExitPlanModeInput = z.infer<typeof ExitPlanModeInput>

export function createExitPlanModeTool(controller: PlanController): AgentTool<ExitPlanModeInput> {
  return {
    name: "plan.exit_plan_mode",
    description:
      "Submit the plan for human review and leave plan mode. The user picks one of four outcomes: clear the plan and execute directly, execute as planned, handle it manually, or keep planning.",
    inputSchema: ExitPlanModeInput,
    risk: "read",
    idempotency: "keyed",
    timeoutMs: 10_000,
    deferred: true,
    isReadOnly: true,
    isConcurrencySafe: () => false,
    validate(input) {
      if (!controller.isActive()) {
        throw new AppError("INVALID_INPUT", "Not in plan mode. Nothing to submit.")
      }
      const ids = new Set<string>()
      for (const step of input.plan.steps) {
        if (ids.has(step.id)) {
          throw new AppError("INVALID_INPUT", `Duplicate step id: ${step.id}`)
        }
        ids.add(step.id)
      }
      for (const step of input.plan.steps) {
        for (const dependency of step.dependencies) {
          if (!ids.has(dependency)) {
            throw new AppError(
              "INVALID_INPUT",
              `Step "${step.id}" depends on unknown step "${dependency}"`,
            )
          }
        }
      }
    },
    async execute(input, _ctx: ToolExecutionContext) {
      const { status, planFilePath } = controller.exit(input.plan)
      return {
        status,
        planFilePath,
        steps: input.plan.steps.length,
        note: "Plan submitted. Awaiting the user's decision before any files are modified.",
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 * tool_search（延迟加载激活）
 * ------------------------------------------------------------------ */

const ToolSearchInput = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(20).default(5),
})
export type ToolSearchInput = z.infer<typeof ToolSearchInput>

export interface DeferredToolEntry {
  name: string
  description: string
  keywords: string[]
}

export function createToolSearchTool(options: {
  /** 列出所有延迟加载工具。 */
  listDeferred: () => DeferredToolEntry[]
  /** 激活命中的工具名，下一轮请求才带上完整 schema。 */
  activate: (names: string[]) => void
}): AgentTool<ToolSearchInput> {
  return {
    name: "tool_search",
    description:
      "Find and activate deferred tools by keyword. Deferred tools are not in your tool list yet; matched tools become available in your NEXT turn with their full input schema.",
    inputSchema: ToolSearchInput,
    risk: "read",
    idempotency: "safe",
    timeoutMs: 5_000,
    isReadOnly: true,
    isConcurrencySafe: () => true,
    async execute(input, _ctx: ToolExecutionContext) {
      const query = input.query.toLowerCase()
      const scored = options
        .listDeferred()
        .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit)

      if (scored.length === 0) {
        return {
          query: input.query,
          activated: [],
          note: "No deferred tool matched. Try different keywords.",
        }
      }

      const names = scored.map((item) => item.entry.name)
      options.activate(names)
      return {
        query: input.query,
        activated: names,
        tools: scored.map((item) => ({
          name: item.entry.name,
          description: item.entry.description,
        })),
        note: `Activated ${names.length} tool(s). Their schemas will be included in your next request.`,
      }
    },
  }
}

function scoreEntry(entry: DeferredToolEntry, query: string): number {
  const terms = query.split(/\s+/).filter((t) => t.length > 0)
  let score = 0
  for (const term of terms) {
    if (entry.name.toLowerCase().includes(term)) score += 5
    if (entry.keywords.some((k) => k.toLowerCase().includes(term))) score += 3
    if (entry.description.toLowerCase().includes(term)) score += 1
  }
  return score
}
