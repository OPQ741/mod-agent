/**
 * 交互式会话（REPL）。
 *
 * 交互模式与 `--print` 跑的是同一条 `session.runOnce()`，区别只在谁回答审批：
 * 这里把人接进来，`--print` 里是"一律拒绝"。两条路径共用同一个驱动器，
 * 所以"交互下能做的事"和"headless 下能做的事"不会长成两套语义。
 */

import { EXIT_BLOCKED, EXIT_OK, type DriveResult } from "../runtime/driver.js"
import { TaskModeSchema, type TaskMode } from "../shared/contracts.js"
import { createInteractivePrompter } from "./approval.js"
import type { CliIo } from "./io.js"
import type { CliSession } from "./session.js"

export interface ReplOptions {
  session: CliSession
  io: CliIo
  mode: TaskMode
  signal?: AbortSignal
}

export const SLASH_HELP = [
  "/help              本帮助",
  "/mode <模式>       切换 ask | plan | edit | autopilot",
  "/diff              看当前工作区 diff（--stat）",
  "/files             上一次任务改动的文件",
  "/cost              上一次任务的用量与花费",
  "/status            上一次任务的状态",
  "/doctor            环境与配置诊断",
  "/resume <任务 id>  从检查点继续跑",
  "/exit              退出（Ctrl-D 同效）",
].join("\n")

export async function runRepl(options: ReplOptions): Promise<number> {
  const { io, session } = options
  const prompter = createInteractivePrompter(io)
  let mode: TaskMode = options.mode
  let last: { taskId: string; result: DriveResult } | undefined

  const handleSlash = async (input: string): Promise<"continue" | "exit"> => {
    const [command, ...rest] = input.slice(1).split(/\s+/)
    const argument = rest.join(" ").trim()
    switch (command) {
      case "help":
        io.out(`${SLASH_HELP}\n`)
        return "continue"
      case "exit":
      case "quit":
        return "exit"
      case "mode": {
        const parsed = TaskModeSchema.safeParse(argument)
        if (!parsed.success) {
          io.err(`用法：/mode ${["ask", "plan", "edit", "autopilot"].join(" | ")}\n`)
          return "continue"
        }
        mode = parsed.data
        io.out(`模式已切换为 ${mode}\n`)
        return "continue"
      }
      case "diff": {
        const text = await session.diff(true)
        io.out(`${text.trimEnd() || "(工作区没有改动)"}\n`)
        return "continue"
      }
      case "files": {
        const files = last?.result.outcome?.changedFiles ?? []
        io.out(files.length > 0 ? `${files.join("\n")}\n` : "(本次会话还没有改动文件)\n")
        return "continue"
      }
      case "cost": {
        if (!last) {
          io.out("(还没有跑过任务)\n")
          return "continue"
        }
        const usage = last.result.usage
        const counters = last.result.metrics.counters
        io.out(
          usage
            ? `轮次 ${usage.rounds} · 工具调用 ${usage.toolCalls} · tokens ${usage.inputTokens}/${usage.outputTokens} · $${usage.costUsd.toFixed(4)}\n`
            : "(无用量记录)\n",
        )
        const policyCounters = Object.entries(counters).filter(([key]) =>
          key.startsWith("policy.decision."),
        )
        if (policyCounters.length > 0) {
          io.out(`${policyCounters.map(([key, value]) => `${key}=${value}`).join(" · ")}\n`)
        }
        return "continue"
      }
      case "status": {
        if (!last) {
          io.out("(还没有跑过任务)\n")
          return "continue"
        }
        const state = await session.runtime.store.getTask(last.taskId)
        io.out(`${last.taskId} · ${state?.status ?? "unknown"}\n`)
        return "continue"
      }
      case "doctor": {
        const report = await session.doctor()
        io.out(`${JSON.stringify(report, null, 2)}\n`)
        return "continue"
      }
      case "resume": {
        if (!argument) {
          io.err("用法：/resume <任务 id>\n")
          return "continue"
        }
        const result = await session.resumeTask(argument, {
          resolveApproval: prompter,
          ...(options.signal ? { signal: options.signal } : {}),
        })
        last = { taskId: argument, result }
        return "continue"
      }
      default:
        io.err(`未知命令：/${command}（/help 看全部）\n`)
        return "continue"
    }
  }

  io.out(`mod-agent · 工作区 ${session.runtime.workspaceRoot} · 模式 ${mode}\n`)
  io.out("输入需求即开始，/help 看命令，Ctrl-D 退出。\n")

  for (;;) {
    const line = await io.ask("\n> ")
    if (line === null) return EXIT_OK
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    if (trimmed.startsWith("/")) {
      if ((await handleSlash(trimmed)) === "exit") return EXIT_OK
      continue
    }

    const result = await session.runOnce({
      prompt: trimmed,
      mode,
      ...(options.signal ? { signal: options.signal } : {}),
      resolveApproval: prompter,
    })
    last = { taskId: result.taskId, result }
    if (result.exitCode === EXIT_BLOCKED) {
      io.err("任务被中断或卡在审批上；改完配置可用 /resume 继续。\n")
    } else if (result.exitCode !== EXIT_OK) {
      io.err(`任务未成功完成（退出码 ${result.exitCode}）。\n`)
    }
  }
}
