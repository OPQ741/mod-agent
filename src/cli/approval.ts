/**
 * 审批交互（security.md §4.4）。
 *
 * 三档选择，语义必须稳定：
 *   1) 允许一次 —— 只放行**这个参数**这一回；
 *   2) 本会话放行 —— 同一工具 + 同一参数在本进程内不再问；
 *   3) 拒绝 —— 把错误回喂给模型，让它换条路走。
 *
 * 两处 fail-closed：
 * - 默认值是 **3) 拒绝**，回车或超时都按拒绝算；
 * - 非 TTY（headless / CI）**一律拒绝**，因为"无人值守"不等于"自动同意"。
 *   想无人值守地放行，唯一的途径是在配置里写 allow 规则，让它走策略而不是交互。
 */

import type { CliIo } from "./io.js"
import type { ApprovalResolution, ApprovalResolver, PendingApproval } from "../runtime/driver.js"

export function createInteractivePrompter(io: CliIo): ApprovalResolver {
  return async (request: PendingApproval): Promise<ApprovalResolution> => {
    if (!io.isTty) return denyWithNotice(io, request, "非交互环境")
    io.err("")
    io.err(`[审批] 动作需要批准：${request.tool}`)
    io.err(`       原因：${request.reason || "(未给出)"}`)
    io.err(`       参数指纹：${request.parameterHash}（参数变了会重新问）`)
    io.err("")
    io.err("  1) 允许一次   2) 本会话放行   3) 拒绝")
    // 输入结束（Ctrl-D）与直接回车一样按拒绝处理 —— 拿不到明确同意就不动
    const answer = (await io.ask("选择 [默认 3]："))?.trim() ?? ""
    switch (answer) {
      case "1":
        return { decision: "allowed", sessionScope: false, by: "user" }
      case "2":
        return { decision: "allowed", sessionScope: true, by: "user" }
      case "3":
      case "":
        return { decision: "denied", by: "user" }
      default:
        io.err(`无法识别 "${answer}"，按拒绝处理。`)
        return { decision: "denied", by: "user" }
    }
  }
}

/** headless 默认：拒绝并说明怎么改成配置放行。 */
export function createDenyResolver(io: CliIo): ApprovalResolver {
  return async (request: PendingApproval) => denyWithNotice(io, request, "--print / 非交互模式")
}

function denyWithNotice(io: CliIo, request: PendingApproval, reason: string): ApprovalResolution {
  io.err(
    `[审批] ${reason}：拒绝执行 ${request.tool}（${request.approvalId}）。\n` +
      `       若确认安全，在 settings 的 permissions.allow 里加规则，或改用交互模式运行。`,
  )
  return { decision: "denied", by: "system:no-tty" }
}
