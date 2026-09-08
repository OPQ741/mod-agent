/**
 * Hook 生命周期（tools-and-extensions.md §2.2 第 3 / 7 步）。
 *
 * 执行器只认一个扁平的 `ToolHooks`，而真正的扩展点是**一组**钩子：
 * 观察型（日志、埋点）、入参改写型（补默认值、规范化路径）、
 * 安全型（拦截危险动作）、审计型。它们的失败语义完全不同：
 *
 * - 观察型 / 审计型出错：不该因为"没记上日志"就让用户的命令跑不起来 → fail-open；
 * - 入参改写型出错：拿不到确定的入参就执行，等于让策略审 A、实际跑 B → fail-closed；
 * - 安全型出错：拦截没生效就是放行 → fail-closed。
 *
 * 所以这里不是简单地把多个钩子拼起来，而是**按类型决定异常处置**：
 * fail-closed 的钩子异常会被转成 `block`，由执行器回一条
 * `TOOL_PERMISSION_DENIED` 的工具结果，而不是抛出异常掀翻主循环
 * （工具错误是数据不是异常，模型看到"被拦截"还能换做法）。
 *
 * 注意 Hook **不能**成为绕过策略的通道：它改过的入参回到执行器后仍会
 * 重新过 Zod、业务校验与 Policy —— 这一段顺序在 `executor.ts` 里已经钉死。
 */

import type { ToolExecutionResult } from "../shared/contracts.js"
import type { Logger } from "../observability/logger.js"
import type { ToolHooks } from "./executor.js"

/** 钩子类型：决定它能做什么、失败后怎么处置。 */
export type HookKind =
  /** 只观察，不改变执行；异常 fail-open。 */
  | "observer"
  /** 改写入参；异常 fail-closed（拿不到确定入参就不能执行）。 */
  | "input"
  /** 安全拦截；异常 fail-closed。 */
  | "security"
  /** 审计记录；异常 fail-open（记录失败不应阻断业务）。 */
  | "audit"

export interface PreToolHookContext {
  toolName: string
  args: Record<string, unknown>
}

export interface PostToolHookContext {
  toolName: string
  args: Record<string, unknown>
  result: ToolExecutionResult
}

export interface PreToolHookResult {
  block?: boolean
  reason?: string
  updatedInput?: Record<string, unknown>
}

export interface PostToolHookResult {
  additionalContext?: string
  replaceOutput?: unknown
}

export interface HookDefinition {
  /** 稳定名字：出现在拦截原因与日志里，便于事后定位是哪个钩子。 */
  name: string
  kind: HookKind
  /** 只作用于匹配的工具；省略表示全部。匹配函数本身出错按"匹配"处理（fail-closed）。 */
  matches?: (toolName: string) => boolean
  /** 覆盖该类型的默认失败语义。 */
  onError?: "open" | "closed"
  preToolUse?: (
    ctx: PreToolHookContext,
  ) => Promise<PreToolHookResult | void> | PreToolHookResult | void
  postToolUse?: (
    ctx: PostToolHookContext,
  ) => Promise<PostToolHookResult | void> | PostToolHookResult | void
}

export interface HookManagerOptions {
  hooks: readonly HookDefinition[]
  logger?: Logger
}

/**
 * 把一组钩子组合成执行器认识的 `ToolHooks`。
 *
 * 执行顺序就是注册顺序：后面的入参型钩子看到的是前面改过的参数
 * （与 shell 管道一致，便于组合出"先规范化、再校验"的链路）。
 */
export class HookManager {
  private readonly hooks: readonly HookDefinition[]
  private readonly logger?: Logger

  constructor(options: HookManagerOptions) {
    this.hooks = options.hooks
    this.logger = options.logger
  }

  /** 某个钩子运行失败时是否必须阻断执行。 */
  static failsClosed(hook: HookDefinition): boolean {
    if (hook.onError) return hook.onError === "closed"
    return hook.kind === "security" || hook.kind === "input"
  }

  toToolHooks(): ToolHooks {
    return {
      preToolUse: async ({ toolName, args }) => {
        let currentArgs = args
        let changed = false

        for (const hook of this.hooks) {
          if (!hook.preToolUse || !this.matches(hook, toolName)) continue
          try {
            const result = await hook.preToolUse({ toolName, args: currentArgs })
            if (result?.block) {
              return {
                block: true,
                reason: `${hook.name}: ${result.reason ?? "blocked by hook"}`,
              }
            }
            if (result?.updatedInput) {
              currentArgs = result.updatedInput
              changed = true
            }
          } catch (err) {
            const message = messageOf(err)
            if (HookManager.failsClosed(hook)) {
              this.logger?.warn("hook.pre_tool_use_failed", {
                hook: hook.name,
                kind: hook.kind,
                toolName,
                action: "fail-closed",
                error: message,
              })
              /**
               * 转成 block 而不是 throw：执行器会把 block 变成
               * `TOOL_PERMISSION_DENIED` 的工具结果回喂模型；throw 会被执行器的
               * fail-open 兜底吞掉，等于安全钩子失效。
               */
              return {
                block: true,
                reason: `Hook "${hook.name}" (${hook.kind}) failed: ${message}. Failing closed — the action was not executed.`,
              }
            }
            this.logger?.warn("hook.pre_tool_use_failed", {
              hook: hook.name,
              kind: hook.kind,
              toolName,
              action: "fail-open",
              error: message,
            })
          }
        }

        return changed ? { updatedInput: currentArgs } : undefined
      },
      postToolUse: async ({ toolName, args, result }) => {
        let replaceOutput: unknown
        let replaceSet = false
        const contexts: string[] = []

        for (const hook of this.hooks) {
          if (!hook.postToolUse || !this.matches(hook, toolName)) continue
          try {
            const hookResult = await hook.postToolUse({ toolName, args, result })
            if (hookResult?.replaceOutput !== undefined) {
              replaceOutput = hookResult.replaceOutput
              replaceSet = true
            }
            if (hookResult?.additionalContext) contexts.push(hookResult.additionalContext)
          } catch (err) {
            /**
             * 后置钩子跑在**执行之后**：这时阻断已经没有意义（副作用已经发生），
             * 只能记录并继续。要拦必须在 PreToolUse 拦。
             */
            this.logger?.warn("hook.post_tool_use_failed", {
              hook: hook.name,
              kind: hook.kind,
              toolName,
              action: "fail-open",
              error: messageOf(err),
            })
          }
        }

        if (!replaceSet && contexts.length === 0) return undefined
        return {
          ...(replaceSet ? { replaceOutput } : {}),
          ...(contexts.length > 0 ? { additionalContext: contexts.join("\n\n") } : {}),
        }
      },
    }
  }

  private matches(hook: HookDefinition, toolName: string): boolean {
    if (!hook.matches) return true
    try {
      return hook.matches(toolName)
    } catch (err) {
      // 匹配器坏了不能静默跳过安全钩子：按命中处理，让钩子自己去决定
      this.logger?.warn("hook.matcher_failed", {
        hook: hook.name,
        toolName,
        error: messageOf(err),
      })
      return true
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
