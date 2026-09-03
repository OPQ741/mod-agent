/**
 * 统一错误码。
 *
 * 设计约束（verification-and-multiagent.md §3）：错误必须**可分类**，因为不同分类的
 * 恢复策略完全不同 —— 测试失败进 Repair Loop；网络被挡不该让模型反复重写代码；
 * 权限被拒更不能让模型换一条命令绕过策略。
 *
 * 因此任何地方都禁止靠匹配报错的自然语言文案来判断分支。
 */

export const ERROR_CODES = [
  // 模型层
  "MODEL_TIMEOUT",
  "MODEL_RATE_LIMIT",
  "MODEL_INVALID_OUTPUT",
  "MODEL_AUTH_FAILED",
  "MODEL_NETWORK",
  "MODEL_BAD_REQUEST",
  "MODEL_EXHAUSTED",
  // 工具层
  "TOOL_TIMEOUT",
  "TOOL_PERMISSION_DENIED",
  "TOOL_SCHEMA_INVALID",
  "TOOL_NOT_FOUND",
  "TOOL_CANCELLED",
  "TOOL_FAILED",
  // 补丁 / 编辑
  "PATCH_CONFLICT",
  "PATCH_PARSE_ERROR",
  "PATH_POLICY_VIOLATION",
  "EDIT_NOT_UNIQUE",
  "EDIT_NOT_FOUND",
  "READ_BEFORE_EDIT",
  "MTIME_CHANGED",
  "FILE_TOO_LARGE",
  // 命令与网络
  "COMMAND_EXIT_NONZERO",
  "COMMAND_DENIED",
  "DEPENDENCY_INSTALL_FAILED",
  "NETWORK_BLOCKED",
  "SANDBOX_FAILURE",
  "SANDBOX_UNAVAILABLE",
  "WORKSPACE_CONFLICT",
  // 验证
  "TYPECHECK_FAILED",
  "LINT_FAILED",
  "TEST_FAILED",
  "BUILD_FAILED",
  // 流程
  "BUDGET_EXCEEDED",
  "NO_PROGRESS",
  "CANCELLED",
  "TASK_EXPIRED",
  "APPROVAL_REQUIRED",
  "APPROVAL_EXPIRED",
  "APPROVAL_DENIED",
  // MCP
  "MCP_NAME_TOO_LONG",
  "MCP_CONNECT_FAILED",
  "MCP_TIMEOUT",
  // 通用
  "INVALID_INPUT",
  "INTERNAL_ERROR",
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** 可自动重试的错误：网络抖动、限流、过载。其余一律不自动重试。 */
export const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "MODEL_TIMEOUT",
  "MODEL_RATE_LIMIT",
  "MODEL_NETWORK",
  "TOOL_TIMEOUT",
  "MCP_TIMEOUT",
  "MCP_CONNECT_FAILED",
])

export function isRetryableCode(code: ErrorCode): boolean {
  return RETRYABLE.has(code)
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value)
}

/**
 * 应用错误。携带 code / retryable / 结构化 details，便于：
 * - 工具层把它转成 `is_error: true` 的 tool_result 回喂模型（agent-loop.md §2.3）；
 * - 事件流记录稳定 error_code 供审计与分类统计。
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(
    code: ErrorCode,
    message: string,
    options?: { details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = "AppError"
    this.code = code
    this.retryable = isRetryableCode(code)
    this.details = options?.details
  }

  toJSON(): {
    code: ErrorCode
    message: string
    retryable: boolean
    details?: Record<string, unknown>
  } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    }
  }
}

export function toAppError(err: unknown, fallback: ErrorCode = "INTERNAL_ERROR"): AppError {
  if (err instanceof AppError) return err
  const message = err instanceof Error ? err.message : String(err)
  return new AppError(fallback, message, { cause: err })
}

/** 断言辅助：抛 INVALID_INPUT。 */
export function invalidInput(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("INVALID_INPUT", message, { details })
}
