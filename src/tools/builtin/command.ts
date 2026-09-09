/**
 * 命令与测试工具（security.md §4 / tools-and-extensions.md §2.5）。
 *
 * 接口是结构化 `executable + args[]`，**绝不接受一整段 shell 字符串** ——
 * 不把模型生成的一整段文本交给有宿主机权限的 shell。
 *
 * 超时处置分两档（tools-and-extensions.md §2.5）：
 * - `kill`：一次性快速命令，超时即杀；
 * - `move-to-background`：默认对 `test.*` / `build.*` 前缀走这条，避免"以为是 30s
 *   结果这条测试跑了 12 分钟"把整个 turn 阻塞住。
 */

import { z } from "zod"
import { NetworkProfileSchema } from "../../shared/contracts.js"
import type {
  AgentTool,
  CommandRequestInput,
  ToolExecutionContext,
} from "../../shared/contracts.js"
import { AppError } from "../../shared/errors.js"
import { EMPTY_OUTPUT_NOTICE, renderCommandResult, withEmptyNotice } from "../executor.js"
import type { PathGuard } from "../../policy/pathguard.js"

const AbsolutePath = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value),
    {
      message: "cwd must be an absolute path",
    },
  )

const CommandRunInput = z.object({
  /** 要执行的程序名或绝对路径。不接受 shell 字符串。 */
  executable: z.string().min(1),
  /** 参数数组。每个元素是一个独立参数，不做 shell 解析。 */
  args: z.array(z.string()).default([]),
  cwd: AbsolutePath,
  /**
   * 超时由运行时按 `settings.limits.commandTimeoutMs / commandMaxTimeoutMs`
   * 补齐与封顶；schema 里写死默认值和上限会让配置完全失效。
   */
  timeoutMs: z.number().int().positive().optional(),
  reason: z.string().min(1, "reason is required: explain why this command is needed"),
  /**
   * 网络档位。**不在这里写默认值**：省略时由运行时按沙箱后端能力补齐
   * （Docker → `none`，受限子进程 → `inherit`），见 `normalizeCommandRequest`。
   * 在工具 schema 里写死 `none` 会让"默认断网"变成一句与后端无关的空话。
   */
  networkProfile: NetworkProfileSchema.optional(),
  onTimeout: z.enum(["kill", "move-to-background"]).default("kill"),
})
export type CommandRunInput = z.infer<typeof CommandRunInput>

export interface CommandLimits {
  defaultTimeoutMs: number
  maxTimeoutMs: number
}

const DEFAULT_COMMAND_LIMITS: CommandLimits = {
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 600_000,
}

/** 补齐默认值并封顶：策略层与执行层必须用同一个值，否则批准的超时会被悄悄换掉。 */
export function resolvedCommandTimeout(
  requested: number | undefined,
  limits: CommandLimits = DEFAULT_COMMAND_LIMITS,
): number {
  const timeout = requested ?? limits.defaultTimeoutMs
  return Math.min(Math.max(timeout, 1), limits.maxTimeoutMs)
}

export function createCommandRunTool(deps: {
  pathGuard: PathGuard
  limits?: Partial<CommandLimits>
}): AgentTool<CommandRunInput> {
  const limits: CommandLimits = { ...DEFAULT_COMMAND_LIMITS, ...deps.limits }
  return {
    name: "command.run",
    description:
      "Run a single command inside the authorized workspace. Pass the executable and an args array (never a shell string). The command is subject to policy review, runs in the sandbox, and is killed as a whole process group on timeout.",
    inputSchema: CommandRunInput,
    risk: "command",
    idempotency: "non_idempotent",
    timeoutMs: 600_000,
    isReadOnly: false,
    isConcurrencySafe: () => false,
    policyCommand: (input): CommandRequestInput => ({
      executable: input.executable,
      args: input.args,
      cwd: input.cwd,
      timeoutMs: resolvedCommandTimeout(input.timeoutMs, limits),
      networkProfile: input.networkProfile,
      reason: input.reason,
      onTimeout: input.onTimeout,
    }),
    policyPaths: (input) => [input.cwd],
    // 长命令值得边跑边看输出（构建、测试），主循环据此开进度 flush
    streamsOutput: true,
    async execute(input, ctx: ToolExecutionContext) {
      const cwd = deps.pathGuard.assertCwd(input.cwd)
      const result = await ctx.runCommand(
        {
          executable: input.executable,
          args: input.args,
          cwd,
          timeoutMs: Math.min(
            resolvedCommandTimeout(input.timeoutMs, limits),
            ctx.timeoutMs || resolvedCommandTimeout(input.timeoutMs, limits),
          ),
          networkProfile: input.networkProfile,
          reason: input.reason,
          onTimeout: input.onTimeout,
        },
        // 增量输出只做转发：节流与事件形状由主循环决定（见 ToolExecutionContext.onOutput）
        ctx.onOutput ? { onOutput: ctx.onOutput } : undefined,
      )

      const rendered = renderCommandResult(result)
      return {
        executable: input.executable,
        args: input.args,
        cwd,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        truncated: rendered.truncated,
        output: rendered.text,
        ...(result.stderr.trim().length > 0 && result.exitCode !== 0
          ? { stderr: result.stderr.slice(0, 4_000) }
          : {}),
        ...(result.exitCode !== 0
          ? {
              hint: `Exit code ${result.exitCode}. Read the failure output, form a hypothesis, then fix and re-run.`,
            }
          : {}),
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 * test.run
 * ------------------------------------------------------------------ */

const TestRunInput = z.object({
  cwd: AbsolutePath,
  /**
   * 要跑的检查命令（数组形式）。省略时自动从 package.json scripts 里发现
   * test / typecheck / lint 候选。
   */
  command: z.array(z.string()).min(1).optional(),
  /** 只跑匹配这些关键词的目标（透传给测试框架）。 */
  filter: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
})
export type TestRunInput = z.infer<typeof TestRunInput>

export interface DiscoveredCheck {
  id: string
  command: string[]
  confidence: number
  source: string
}

/**
 * 从 package.json 推断检查命令（verification-and-multiagent.md §2）。
 *
 * 自动发现的命令只是**候选**：执行前必须过 Policy，不直接执行 README 里复制来的
 * 任意命令。上下文工程文档 §2 明确：路径与命令过滤由可信代码执行，不靠模型决定。
 */
export function discoverChecks(packageJson: unknown): DiscoveredCheck[] {
  const scripts = readScripts(packageJson)
  const checks: DiscoveredCheck[] = []
  const candidates: Array<{ id: string; script: string; confidence: number }> = [
    { id: "typecheck", script: "typecheck", confidence: 0.95 },
    { id: "lint", script: "lint", confidence: 0.9 },
    { id: "test", script: "test", confidence: 0.95 },
    { id: "build", script: "build", confidence: 0.8 },
  ]
  const runner = detectRunner(packageJson)
  for (const candidate of candidates) {
    const value = scripts[candidate.script]
    if (typeof value !== "string") continue
    checks.push({
      id: candidate.id,
      command: toArgs(runner, candidate.script),
      confidence: candidate.confidence,
      source: `package.json scripts.${candidate.script}`,
    })
  }
  return checks
}

function readScripts(packageJson: unknown): Record<string, string> {
  if (typeof packageJson !== "object" || packageJson === null) return {}
  const scripts = (packageJson as { scripts?: unknown }).scripts
  if (typeof scripts !== "object" || scripts === null) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value
  }
  return out
}

/**
 * 识别包管理器。
 *
 * 两个来源缺一不可：脚本里直接写了 `pnpm xxx` 的仓库，以及只在
 * `packageManager` 字段声明（脚本本身仍是 `tsc --noEmit`）的仓库。
 * 只看脚本文案会在后者上错选 npm —— 装了 pnpm 的项目里多跑一层 npm 未必错，
 * 但会绕过 ci/setup 阶段锁定的那个包管理器版本。
 */
function detectRunner(packageJson: unknown): "npm" | "pnpm" | "yarn" | "bun" {
  const declared =
    typeof packageJson === "object" && packageJson !== null
      ? (packageJson as { packageManager?: unknown }).packageManager
      : undefined
  if (typeof declared === "string") {
    const name = declared.split("@", 1)[0]?.toLowerCase()
    if (name === "pnpm" || name === "yarn" || name === "bun") return name
  }

  const scripts = readScripts(packageJson)
  const all = Object.values(scripts).join(" ")
  if (/\bpnpm\b/.test(all)) return "pnpm"
  if (/\byarn\b/.test(all)) return "yarn"
  if (/\bbun\b/.test(all)) return "bun"
  return "npm"
}

function toArgs(runner: "npm" | "pnpm" | "yarn" | "bun", script: string): string[] {
  if (runner === "yarn") return ["yarn", script]
  return [runner, "run", script]
}

export function createTestRunTool(deps: {
  pathGuard: PathGuard
  /** 读取 package.json 的注入函数（避免工具直接依赖 fs 之外的环境假设）。 */
  readPackageJson: (cwd: string) => Promise<unknown>
  limits?: Partial<CommandLimits>
}): AgentTool<TestRunInput> {
  const limits: CommandLimits = {
    defaultTimeoutMs: 300_000,
    maxTimeoutMs: DEFAULT_COMMAND_LIMITS.maxTimeoutMs,
    ...deps.limits,
  }
  return {
    name: "test.run",
    description:
      "Run the project's verification command (typecheck / lint / test / build) inside the authorized workspace. Omit `command` to auto-discover from package.json scripts. Returns exit code, duration and a trimmed failure summary.",
    inputSchema: TestRunInput,
    risk: "command",
    idempotency: "keyed",
    timeoutMs: 600_000,
    isReadOnly: false,
    isConcurrencySafe: () => false,
    policyPaths: (input) => [input.cwd],
    // 验证命令通常最慢，增量输出最有价值
    streamsOutput: true,
    policyCommand: (input) => ({
      executable: input.command?.[0] ?? "npm",
      // filter 会被拼进真实 argv，判定时必须一起算上，否则"批准的命令"和
      // "执行的命令"差一个参数，审批绑定就形同虚设。
      args: [...(input.command?.slice(1) ?? ["test"]), ...(input.filter ? [input.filter] : [])],
      cwd: input.cwd,
      timeoutMs: resolvedCommandTimeout(input.timeoutMs, limits),
      networkProfile: "none",
      reason: "Run project verification",
      onTimeout: "move-to-background",
    }),
    /**
     * 把"自动发现的命令"提前到校验阶段落定。
     *
     * `policyCommand` 是在校验之后求值的（见 runtime/loop.ts 的 decide），所以在这里
     * 补全 `input.command`，策略层批准的就是**真正要执行的那条命令**。
     * 若留在 execute 里才发现，无人值守模式下会出现"批准 npm test、实际跑 pnpm run test"。
     */
    async validate(input) {
      if (input.command && input.command.length > 0) return
      const packageJson = await deps.readPackageJson(input.cwd)
      const checks = discoverChecks(packageJson).sort((a, b) => b.confidence - a.confidence)
      const chosen = checks.find((c) => c.id === "test") ?? checks[0]
      if (!chosen) {
        throw new AppError(
          "INVALID_INPUT",
          "No test command could be discovered in package.json. " +
            'Pass `command` explicitly, e.g. ["npm", "run", "test"].',
        )
      }
      input.command = chosen.command
    },
    async execute(input, ctx: ToolExecutionContext) {
      const cwd = deps.pathGuard.assertCwd(input.cwd)

      let command = input.command
      let source = "explicit"
      if (!command) {
        const packageJson = await deps.readPackageJson(cwd)
        const checks = discoverChecks(packageJson).sort((a, b) => b.confidence - a.confidence)
        const chosen = checks.find((c) => c.id === "test") ?? checks[0]
        if (!chosen) {
          throw new AppError(
            "COMMAND_EXIT_NONZERO",
            'No test command could be discovered. Pass `command` explicitly, e.g. ["npm", "run", "test"].',
          )
        }
        command = chosen.command
        source = chosen.source
      }

      const executable = command[0]
      const args = command.slice(1)
      if (executable === undefined) {
        throw new AppError("INVALID_INPUT", "command must not be empty")
      }
      if (input.filter) args.push(input.filter)

      const result = await ctx.runCommand(
        {
          executable,
          args,
          cwd,
          timeoutMs: Math.min(
            resolvedCommandTimeout(input.timeoutMs, limits),
            ctx.timeoutMs || resolvedCommandTimeout(input.timeoutMs, limits),
          ),
          networkProfile: "none",
          reason: "Run project verification",
          onTimeout: "move-to-background",
        },
        ctx.onOutput ? { onOutput: ctx.onOutput } : undefined,
      )

      const rendered = renderCommandResult(result)
      return {
        command: [executable, ...args],
        source,
        cwd,
        exitCode: result.exitCode,
        passed: result.exitCode === 0,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        truncated: rendered.truncated,
        output: rendered.text,
        ...(result.exitCode !== 0
          ? {
              failureSummary: extractFailureSummary(result.stdout, result.stderr),
              hint:
                "Tests failed. Identify the failing assertion, form a hypothesis about the cause, " +
                "make the minimal fix, then re-run. Do not edit tests to make them pass.",
            }
          : {}),
      }
    },
  }
}

/**
 * 从测试输出里提取可定位的失败摘要（verification-and-multiagent.md §4 第 2 步）。
 * 不把超长日志无过滤塞进上下文 —— 那只会挤掉推理所需的空间。
 */
export function extractFailureSummary(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`
  const lines = combined.split("\n")
  const interesting = lines.filter((line) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return false
    return /(✕|×|✗|FAILED|FAIL|Error:|error TS\d+|AssertionError|Expected|Received|at .+\.(ts|tsx|js|jsx):\d+)/i.test(
      trimmed,
    )
  })
  const head = interesting.slice(0, 30).join("\n")
  if (head.trim().length === 0) {
    return withEmptyNotice(
      stdout.trim().length === 0 && stderr.trim().length === 0
        ? EMPTY_OUTPUT_NOTICE
        : combined.slice(0, 2_000),
    )
  }
  return head.length > 8_000 ? `${head.slice(0, 4_000)}\n…\n${head.slice(-4_000)}` : head
}
