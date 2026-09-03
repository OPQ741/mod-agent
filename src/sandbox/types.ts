/**
 * 沙箱后端抽象（security.md §3 / architecture.md「沙箱 / 运行时抽象」）。
 *
 * 单进程 CLI 也先把"执行内核"与"交互界面"用清晰边界隔开，将来加远程 agent
 * 或云端长任务时不用改内核。
 */

import type { CommandRequest, CommandResult } from "../shared/contracts.js"

export interface SandboxBackend {
  readonly id: string
  /** 后端是否真的可用（Docker 在不在、bubblewrap 装没装）。 */
  isAvailable(): Promise<boolean>
  /** 执行命令。后端不可用时必须抛 SANDBOX_UNAVAILABLE，由调用方决定是否 fail-closed。 */
  exec(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult>
}

export interface SandboxProbeResult {
  available: boolean
  backend: string
  reason?: string
}
