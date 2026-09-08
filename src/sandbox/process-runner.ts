/**
 * 受控子进程执行器（security.md §4）。
 *
 * 三条硬约束：
 * 1. **绝不 `shell: true`** —— 不把模型生成的一整段文本交给宿主机 shell。
 *    接口是 `executable + args[]`，引号转义问题从根上不存在。
 * 2. **超时杀的是整个进程组**，不只杀父进程。`npm` 拉起的那一堆子进程如果活下来，
 *    是这一层最阴的资源泄漏（development-guide.md §6 第 3 条）。
 * 3. 输出有硬上限；总量超过阈值直接 kill，防 `yes > /dev/null` 之类把机器与磁盘同时打死。
 */

import { spawn, type ChildProcess } from "node:child_process"
import type { CommandOutputChunk, CommandRequest, CommandResult } from "../shared/contracts.js"
import { AppError } from "../shared/errors.js"
import { filterEnv, isSensitiveEnvName, stripAnsi } from "../shared/sanitize.js"
import { resolveExecutable } from "./executable-resolver.js"

export interface RunProcessOptions {
  /** 单条命令的字节硬顶，超过即截断并标 truncated。 */
  maxOutputChars: number
  /** 会话内累计输出字节上限，超过即 kill。 */
  maxTotalOutputBytes: number
  signal?: AbortSignal
  /**
   * 增量输出回调（每个 `data` chunk 一次，未节流）。
   *
   * 这里**只转发**、不做合并：调用方（主循环）才知道事件要落库、多大的批量合适。
   * 也不在这里 `stripAnsi` —— 片段的 ANSI 可能是半个转义序列，逐片清洗会把
   * 半个序列当正文发出去；终态结果仍然统一清洗一次。
   */
  onOutput?: (chunk: CommandOutputChunk) => void
}

export interface RunProcessResult extends CommandResult {
  killed: boolean
  /** spawn 本身失败（可执行文件不存在 / 权限不足）。与"跑了但退出码非零"是两回事。 */
  spawnError?: string
}

/** 累计输出统计，用于跨命令的 5GB 总量守卫。 */
export class OutputBudget {
  private total = 0
  constructor(private readonly limit: number) {}

  get used(): number {
    return this.total
  }

  /** 返回 false 表示已超阈值，调用方应 kill 进程。 */
  add(bytes: number): boolean {
    this.total += bytes
    return this.total <= this.limit
  }

  reset(): void {
    this.total = 0
  }
}

/**
 * 执行一条命令。
 *
 * 注意：`request.executable` 不走 PATH 查找以外的任何解析，也不允许 shell 元字符。
 * 命令是否允许执行由 Policy 层决定，这里只负责"收到通过策略的结构化请求后正确执行"。
 */
export async function runProcess(
  request: CommandRequest,
  options: RunProcessOptions,
  budget?: OutputBudget,
): Promise<RunProcessResult> {
  const startedAt = Date.now()

  // 拒绝把敏感环境变量透传进子进程
  for (const key of Object.keys(request.env ?? {})) {
    if (isSensitiveEnvName(key)) {
      throw new AppError(
        "COMMAND_DENIED",
        `Refusing to pass sensitive environment variable "${key}" to a subprocess`,
        { details: { executable: request.executable } },
      )
    }
  }

  const env = filterEnv(process.env, undefined, request.env)
  /**
   * Windows 上 `npm` / `npx` / `yarn` 是 `.cmd` shim，`shell: false` 既做不了 PATHEXT 解析、
   * 又不允许直接 spawn 批处理（Node 对 CVE-2024-27980 的修复会抛 EINVAL）。
   * 这里统一交给解析器决定：要么原样 spawn，要么显式经 `cmd.exe` 包装。
   * **仍然不用 `shell: true`** —— 参数边界必须保住。
   */
  const resolved = await resolveExecutable(request.executable, request.args, {
    env,
    cwd: request.cwd,
  })
  const child = spawn(resolved.command, resolved.args, {
    cwd: request.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    // `.cmd` 包装时命令行已由 resolver 逐参引号化，不能让 Node 再拼一遍
    windowsVerbatimArguments: resolved.viaCmdHost,
    // POSIX 下独立进程组，便于超时时整组 kill
    detached: process.platform !== "win32",
  })

  let stdout = ""
  let stderr = ""
  let truncated = false
  let timedOut = false
  let cancelled = false
  let outputLimitExceeded = false
  let settled = false
  let spawnError: string | undefined

  const append = (current: string, chunk: string): string => {
    if (current.length + chunk.length > options.maxOutputChars) {
      truncated = true
      const room = Math.max(0, options.maxOutputChars - current.length)
      return current + chunk.slice(0, room)
    }
    return current + chunk
  }

  child.stdout?.on("data", (buf: Buffer) => {
    const text = buf.toString("utf8")
    if (budget && !budget.add(buf.byteLength)) {
      outputLimitExceeded = true
      killTree(child, "output-limit")
      return
    }
    stdout = append(stdout, text)
    options.onOutput?.({ stream: "stdout", text })
  })
  child.stderr?.on("data", (buf: Buffer) => {
    const text = buf.toString("utf8")
    if (budget && !budget.add(buf.byteLength)) {
      outputLimitExceeded = true
      killTree(child, "output-limit")
      return
    }
    stderr = append(stderr, text)
    options.onOutput?.({ stream: "stderr", text })
  })

  const timer = setTimeout(() => {
    timedOut = true
    killTree(child, "timeout")
  }, request.timeoutMs)

  const onAbort = () => {
    cancelled = true
    killTree(child, "abort")
  }
  options.signal?.addEventListener("abort", onAbort, { once: true })

  const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return
        settled = true
        resolve({ code, signal })
      }
      child.on("error", (err: NodeJS.ErrnoException) => {
        spawnError = err.code === "ENOENT" ? describeSpawnFailure(request.executable) : err.message
        finish(null, null)
      })
      child.on("close", finish)
      child.on("exit", finish)
    },
  )

  clearTimeout(timer)
  options.signal?.removeEventListener("abort", onAbort)

  const durationMs = Date.now() - startedAt
  const exitCode = exitInfo.code ?? (exitInfo.signal ? 128 : 1)

  return {
    exitCode,
    stdout: stripAnsi(stdout),
    stderr: stripAnsi(stderr),
    durationMs,
    timedOut,
    cancelled,
    truncated,
    outputLimitExceeded,
    killed: timedOut || cancelled || outputLimitExceeded,
    ...(spawnError ? { spawnError } : {}),
  }
}

/**
 * 终止整个进程树。
 *
 * POSIX：`process.kill(-pid)` 发信号给进程组（spawn 时已 detached）。
 * Windows：没有进程组概念，用 `taskkill /T` 递归结束子进程树。
 */
export function killTree(child: ChildProcess, reason: string): void {
  const pid = child.pid
  if (!pid || child.killed) return
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        shell: false,
        windowsHide: true,
      })
      killer.on("error", () => {
        /* taskkill 不可用时退回直接 kill */
      })
      killer.unref()
      // 兜底：taskkill 失败时至少杀掉直接子进程
      setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          /* 进程可能已退出 */
        }
      }, 500).unref()
      return
    }
    // 先温和、后强杀，给子进程清理的机会
    try {
      process.kill(-pid, "SIGTERM")
    } catch {
      /* 进程组可能已退出 */
    }
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        /* 已退出则忽略 */
      }
    }, 2000).unref()
  } catch {
    /* 忽略：进程已退出 */
  }
  void reason
}

/** 可执行文件不存在时给出可操作提示，而不是让模型猜。 */
export function describeSpawnFailure(executable: string): string {
  return `Failed to start "${executable}". Check that it is installed and on PATH; commands are executed without a shell (executable + args[]).`
}
