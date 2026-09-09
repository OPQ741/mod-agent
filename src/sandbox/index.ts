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
  type CommandOutputChunk,
  type CommandRequest,
  type CommandResult,
  type NetworkProfile,
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

  /**
   * 诚实的自我描述：**没有**网络隔离，也**没有**文件系统隔离。
   * 这个后端提供的是生命周期与资源约束（超时/取消杀进程树、输出上限、cwd 限制）。
   */
  readonly capabilities = { networkIsolation: false, filesystemIsolation: false } as const

  /**
   * 默认档位是 `inherit` 而不是 `none`。
   *
   * 默认 `none` 会制造一个持续存在的假象：每条命令都"要求断网"，而实际阻断完全不存在，
   * 只剩一个正则在做意图拦截。默认值应当描述事实 —— 这里的事实是"没有隔离"。
   */
  readonly defaultNetworkProfile = "inherit" as const

  constructor(
    private readonly options: {
      workspaceRoot: string
      maxOutputChars: number
      maxTotalOutputBytes: number
      assertCwd: (cwd: string) => string
      envAllowlist?: readonly string[]
    },
  ) {}

  private readonly budget = new LazyBudget(() => this.options.maxTotalOutputBytes)

  async isAvailable(): Promise<boolean> {
    return true
  }

  async exec(
    request: CommandRequest,
    signal?: AbortSignal,
    options?: { onOutput?: (chunk: CommandOutputChunk) => void },
  ): Promise<CommandResult> {
    // 规则 ②：命令 cwd 必须落在授权工作区内，不允许 `cd ..` 逃逸
    const cwd = this.options.assertCwd(request.cwd)

    /**
     * 网络档位：这里**只能做意图拦截**，不是强制隔离。
     *
     * `networkProfile === "none"` 但本后端没有网络隔离能力时，用命令文本正则识别
     * "看起来要联网"的请求并拒绝。它挡不住 `node build.js`、`make`、`npm run anything`
     * 这类间接联网 —— 所以错误码叫 `NETWORK_INTENT_BLOCKED` 而不是 `NETWORK_BLOCKED`，
     * 文案也写明"启发式"。要真断网请用 Docker 后端（`--network none`）。
     */
    if (request.networkProfile === "none" && this.capabilities.networkIsolation === false) {
      if (networkIntentGuard(request)) {
        throw new AppError(
          "NETWORK_INTENT_BLOCKED",
          "Command looks like it needs network access, and the active sandbox backend cannot enforce network isolation " +
            "(heuristic intent guard, not a hard block). Use the Docker sandbox backend for real network isolation.",
          { details: { executable: request.executable, networkProfile: request.networkProfile } },
        )
      }
    }

    const result: RunProcessResult = await runProcess(
      { ...request, cwd },
      {
        maxOutputChars: this.options.maxOutputChars,
        maxTotalOutputBytes: this.options.maxTotalOutputBytes,
        ...(signal ? { signal } : {}),
        ...(options?.onOutput ? { onOutput: options.onOutput } : {}),
        ...(this.options.envAllowlist ? { envAllowlist: this.options.envAllowlist } : {}),
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

/**
 * 网络**意图**拦截（启发式）。
 *
 * 只看命令文本里的常见联网工具名。它**不是**隔离：
 * `node build.js`、`python gen.py`、`npm run anything`、`make` 都能自由联网。
 * 保留它的理由只有一个 —— 在 `none` 档下挡掉最明显的错误，并给出可操作的提示。
 */
const NETWORK_INTENT_PATTERN =
  /\b(curl|wget|nc|netcat|ssh|scp|rsync|git\s+(clone|fetch|pull|push)|npm\s+(install|publish)|pip\s+install|apt-get|apk\s+add)\b/i

function networkIntentGuard(request: CommandRequest): boolean {
  const line = `${request.executable} ${request.args.join(" ")}`
  return NETWORK_INTENT_PATTERN.test(line)
}

/**
 * Docker 后端（可选档）。
 *
 * 只有在 Docker 真的可用时才启用；不可用时按 `failIfUnavailable` 决定
 * 是拒绝执行还是回落到受限子进程，默认**拒绝**。
 */
export class DockerBackend implements SandboxBackend {
  readonly id = "docker"

  /** 容器是真的隔离：`--network none` 断出口，只挂载授权工作区。 */
  readonly capabilities = { networkIsolation: true, filesystemIsolation: true } as const

  /** 有真隔离才能把 `none` 作为默认 —— 这时默认值描述的是事实。 */
  readonly defaultNetworkProfile = "none" as const

  constructor(
    private readonly options: {
      workspaceRoot: string
      maxOutputChars: number
      maxTotalOutputBytes: number
      image?: string
      envAllowlist?: readonly string[]
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

  async exec(
    request: CommandRequest,
    signal?: AbortSignal,
    options?: { onOutput?: (chunk: CommandOutputChunk) => void },
  ): Promise<CommandResult> {
    const image = this.options.image ?? "node:22-alpine"
    const args = buildDockerRunArgs({
      workspaceRoot: this.options.workspaceRoot,
      cwd: request.cwd,
      image,
      networkProfile: request.networkProfile,
      executable: request.executable,
      args: request.args,
    })
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
        ...(options?.onOutput ? { onOutput: options.onOutput } : {}),
        ...(this.options.envAllowlist ? { envAllowlist: this.options.envAllowlist } : {}),
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

/**
 * 构造 `docker run` 参数（纯函数，便于逐项审计与单测）。
 *
 * 加固基线**不能依赖镜像的隐式默认值**：
 * - `--cap-drop=ALL`：不放任镜像自带 capabilities（`chown`/`setuid`/`mknod` 等）；
 * - `--security-opt=no-new-privileges`：禁止 setuid 程序提权；
 * - 网络按档位映射：`none` 真的断出口，其他档位给 `bridge`。
 *
 * 仍有两项**刻意不做**，因为会改变用户命令的可行性、且无法在本仓库离线验证：
 * - 不写 `--user`：uid/gid 必须与挂载目录属主一致，写死会让 `<workspace>` 变成只读；
 * - 不写 `--read-only`：`npm` / `pip` 等会在 `$HOME` 落缓存，只读根文件系统需要
 *   额外规划 tmpfs 与 HOME。这两项应在真实 Docker 环境验证后再加，而不是先猜。
 */
export function buildDockerRunArgs(spec: {
  workspaceRoot: string
  cwd: string
  image: string
  networkProfile: NetworkProfile
  executable: string
  args: readonly string[]
}): string[] {
  return [
    "run",
    "--rm",
    "-i",
    "--network",
    spec.networkProfile === "none" ? "none" : "bridge",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    "2g",
    "--cpus",
    "1",
    "-v",
    `${spec.workspaceRoot}:/workspace:rw`,
    "-w",
    `/workspace/${toPosixRelative(spec.workspaceRoot, spec.cwd)}`,
    spec.image,
    spec.executable,
    ...spec.args,
  ]
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
    envAllowlist: settings.envAllowlist,
  })

  if (!settings.sandbox.enabled) {
    return {
      backend: restricted,
      coverage: [
        "process lifecycle (timeout / cancel kills the whole process tree)",
        "output size limits (per-command and session total)",
        "cwd confined to the authorized workspace",
        "NOT covered: filesystem visibility, network egress",
        "default network profile: inherit (no egress blocking; `none` only triggers a heuristic intent guard)",
      ],
      degraded: false,
    }
  }

  const docker = new DockerBackend({
    workspaceRoot,
    maxOutputChars: settings.limits.commandMaxOutputChars,
    maxTotalOutputBytes: settings.limits.commandMaxTotalOutputBytes,
    envAllowlist: settings.envAllowlist,
  })
  const available = options.probeDocker ? await options.probeDocker() : await docker.isAvailable()
  if (available) {
    return {
      backend: docker,
      coverage: [
        "container isolation: network off by default, all Linux capabilities dropped, no-new-privileges",
        "mount: only the authorized workspace",
        "pids / memory / cpu limits",
        "process lifecycle and output limits",
        "NOT covered: container runs as the image's default user; root filesystem stays writable",
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
    coverage: [
      "DEGRADED: Docker unavailable, fell back to restricted subprocess",
      "NOT covered: filesystem visibility, network egress",
      "default network profile: inherit (no egress blocking)",
    ],
    degraded: true,
  }
}

export { OutputBudget, runProcess, killTree } from "./process-runner.js"
