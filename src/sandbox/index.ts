/**
 * 沙箱选择与 fail-closed（security.md §3.1）。
 *
 * 核心纪律只有一条：**沙箱起不来就拒绝执行，不降级裸跑**。
 * Devin 官方原文："If `--sandbox` is passed but sandbox resolution fails…
 * the CLI will refuse to start rather than running unsandboxed."
 * 静默回退之所以不可接受，是因为它把选择权交给用户，代价是绝大多数用户
 * 不知道自己从未被隔离。
 */

import path from "node:path"
import {
  normalizeCommandRequest,
  type CommandRequest,
  type CommandResult,
} from "../shared/contracts.js"
import { AppError } from "../shared/errors.js"
import type { Settings } from "../config/settings.js"
import { runProcess, OutputBudget, type RunProcessResult } from "./process-runner.js"
import type { SandboxBackend, SandboxProbeResult } from "./types.js"

export type { SandboxBackend, SandboxProbeResult }

/**
 * 受限子进程后端（默认档）。
 *
 * 它提供的是"生命周期与资源约束"，不是"内核级隔离"：
 * - 命令以 `executable + args[]` 启动，不经 shell；
 * - 超时 / 取消杀整棵进程树；
 * - 输出有字节上限与会话内总量上限。
 *
 * 受它约束不到的部分（文件系统可见性、网络出口）必须在文档与 CLI 里显式声明，
 * 不能让人把"跑了沙箱后端"读成"全都隔离了"。
 */
export class RestrictedSubprocessBackend implements SandboxBackend {
  readonly id = "restricted-subprocess"

  constructor(
    private readonly options: {
      workspaceRoot: string
      maxOutputChars: number
      maxTotalOutputBytes: number
      assertCwd: (cwd: string) => string
    },
  ) {}

  private readonly budget = new LazyBudget(() => this.options.maxTotalOutputBytes)

  async isAvailable(): Promise<boolean> {
    return true
  }

  async exec(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
    // 规则 ②：命令 cwd 必须落在授权工作区内，不允许 `cd ..` 逃逸
    const cwd = this.options.assertCwd(request.cwd)

    // 网络档位：none 时拒绝声明需要网络的请求（子进程后端无法真正断网）
    if (request.networkProfile === "none" && hasNetworkIntent(request)) {
      throw new AppError(
        "NETWORK_BLOCKED",
        "Command declares network access but the active sandbox backend cannot enforce network isolation",
        { details: { executable: request.executable, networkProfile: request.networkProfile } },
      )
    }

    const result: RunProcessResult = await runProcess(
      { ...request, cwd },
      {
        maxOutputChars: this.options.maxOutputChars,
        maxTotalOutputBytes: this.options.maxTotalOutputBytes,
        ...(signal ? { signal } : {}),
      },
      this.budget.get(),
    )

    if (result.spawnError) {
      throw new AppError("COMMAND_EXIT_NONZERO", result.spawnError, {
        details: { executable: request.executable, args: request.args },
      })
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      truncated: result.truncated,
      outputLimitExceeded: result.outputLimitExceeded,
    }
  }
}

/** 懒初始化，避免构造时就要求 limit 已知。 */
class LazyBudget {
  private instance: OutputBudget | undefined
  constructor(private readonly limitOf: () => number) {}

  get(): OutputBudget {
    this.instance ??= new OutputBudget(this.limitOf())
    return this.instance
  }
}

const NETWORK_INTENT =
  /\b(curl|wget|nc|netcat|ssh|scp|rsync|git\s+(clone|fetch|pull|push)|npm\s+(install|publish)|pip\s+install|apt-get|apk\s+add)\b/i

function hasNetworkIntent(request: CommandRequest): boolean {
  const line = `${request.executable} ${request.args.join(" ")}`
  return NETWORK_INTENT.test(line)
}

/**
 * Docker 后端（可选档）。
 *
 * 只有在 Docker 真的可用时才启用；不可用时按 `failIfUnavailable` 决定
 * 是拒绝执行还是回落到受限子进程，默认**拒绝**。
 */
export class DockerBackend implements SandboxBackend {
  readonly id = "docker"

  constructor(
    private readonly options: {
      workspaceRoot: string
      maxOutputChars: number
      maxTotalOutputBytes: number
      image?: string
    },
  ) {}

  async isAvailable(): Promise<boolean> {
    const probe = await runProcess(
      normalizeCommandRequest({
        executable: "docker",
        args: ["info"],
        cwd: this.options.workspaceRoot,
        timeoutMs: 10_000,
        networkProfile: "none",
        reason: "probe docker availability",
      }),
      { maxOutputChars: 4096, maxTotalOutputBytes: 4096 },
    )
    return !probe.spawnError && probe.exitCode === 0
  }

  async exec(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
    const image = this.options.image ?? "node:22-alpine"
    const args = [
      "run",
      "--rm",
      "-i",
      "--network",
      request.networkProfile === "none" ? "none" : "bridge",
      "--pids-limit",
      "256",
      "--memory",
      "2g",
      "--cpus",
      "1",
      "-v",
      `${this.options.workspaceRoot}:/workspace:rw`,
      "-w",
      `/workspace/${toPosixRelative(this.options.workspaceRoot, request.cwd)}`,
      image,
      request.executable,
      ...request.args,
    ]
    const result = await runProcess(
      normalizeCommandRequest({
        executable: "docker",
        args,
        cwd: this.options.workspaceRoot,
        timeoutMs: request.timeoutMs,
        networkProfile: request.networkProfile,
        reason: request.reason,
      }),
      {
        maxOutputChars: this.options.maxOutputChars,
        maxTotalOutputBytes: this.options.maxTotalOutputBytes,
        ...(signal ? { signal } : {}),
      },
    )
    if (result.spawnError) {
      throw new AppError("SANDBOX_FAILURE", `Docker sandbox failed to start: ${result.spawnError}`)
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      truncated: result.truncated,
      outputLimitExceeded: result.outputLimitExceeded,
    }
  }
}

function toPosixRelative(root: string, target: string): string {
  const rel = path.relative(root, target)
  if (rel === "") return "."
  return rel.split(path.sep).join("/")
}

/* ------------------------------------------------------------------ *
 * 选择后端
 * ------------------------------------------------------------------ */

export interface SandboxSelection {
  backend: SandboxBackend
  /** 声明"沙箱覆盖了什么"，供 CLI 显式展示（security.md §3.3 覆盖率声明）。 */
  coverage: string[]
  degraded: boolean
}

/**
 * 按配置选择沙箱后端。
 *
 * `sandbox.enabled = true` 而 Docker 不可用时：
 * - `failIfUnavailable = true`（默认）→ 抛 SANDBOX_UNAVAILABLE，任务拒绝执行高风险动作；
 * - `failIfUnavailable = false` → 回落到受限子进程，并标记 `degraded`，由调用方显式提示。
 */
export async function selectSandbox(options: {
  settings: Settings
  workspaceRoot: string
  assertCwd: (cwd: string) => string
  /**
   * 可注入的 Docker 可用性探针。默认探测真实 `docker info`；
   * 测试里用它把 Docker 固定为"不可用"，避免结果依赖宿主是否装了 Docker。
   */
  probeDocker?: () => Promise<boolean>
}): Promise<SandboxSelection> {
  const { settings, workspaceRoot, assertCwd } = options
  const restricted = new RestrictedSubprocessBackend({
    workspaceRoot,
    maxOutputChars: settings.limits.commandMaxOutputChars,
    maxTotalOutputBytes: settings.limits.commandMaxTotalOutputBytes,
    assertCwd,
  })

  if (!settings.sandbox.enabled) {
    return {
      backend: restricted,
      coverage: [
        "process lifecycle (timeout / cancel kills the whole process tree)",
        "output size limits (per-command and session total)",
        "cwd confined to the authorized workspace",
        "NOT covered: filesystem visibility, network egress",
      ],
      degraded: false,
    }
  }

  const docker = new DockerBackend({
    workspaceRoot,
    maxOutputChars: settings.limits.commandMaxOutputChars,
    maxTotalOutputBytes: settings.limits.commandMaxTotalOutputBytes,
  })
  const available = options.probeDocker ? await options.probeDocker() : await docker.isAvailable()
  if (available) {
    return {
      backend: docker,
      coverage: [
        "container isolation (non-root, network off by default)",
        "mount: only the authorized workspace",
        "pids / memory / cpu limits",
        "process lifecycle and output limits",
      ],
      degraded: false,
    }
  }

  if (settings.sandbox.failIfUnavailable) {
    throw new AppError(
      "SANDBOX_UNAVAILABLE",
      "Sandbox is enabled but Docker is not available; refusing to run unsandboxed (fail-closed). " +
        "Set sandbox.enabled=false explicitly if you accept restricted-subprocess execution.",
    )
  }
  return {
    backend: restricted,
    coverage: ["DEGRADED: Docker unavailable, fell back to restricted subprocess"],
    degraded: true,
  }
}

export { OutputBudget, runProcess, killTree } from "./process-runner.js"
