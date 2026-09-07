/**
 * 沙箱后端抽象（security.md §3 / architecture.md「沙箱 / 运行时抽象」）。
 *
 * 单进程 CLI 也先把"执行内核"与"交互界面"用清晰边界隔开，将来加远程 agent
 * 或云端长任务时不用改内核。
 */

import type { CommandRequest, CommandResult, NetworkProfile } from "../shared/contracts.js"

/**
 * 后端**实际具备**的隔离能力。
 *
 * 存在的意义是让"能不能断网"变成一个可查询的事实，而不是靠后端的错误码去猜：
 * 受限子进程后端做不到网络隔离，任何"默认 none"都只能是意图拦截；
 * 调用方据此决定默认档位与是否允许 `none`。
 */
export interface SandboxCapabilities {
  /** 能否真正阻断网络出口（不是"看起来要联网就拒绝"的启发式）。 */
  networkIsolation: boolean
  /** 能否限制文件系统可见性（只有授权工作区可见/可写）。 */
  filesystemIsolation: boolean
}

export interface SandboxBackend {
  readonly id: string
  readonly capabilities: SandboxCapabilities
  /** 省略 `networkProfile` 时的默认档位，由能力决定。 */
  readonly defaultNetworkProfile: NetworkProfile
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
