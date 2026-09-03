/**
 * 确定性哈希与稳定序列化。
 *
 * 两个用途：
 * 1. 参数 hash —— 审批绑定具体参数（批准 `npm test` 不等于批准 `npm install lodash`）；
 * 2. 内容 hash —— 编辑的基准校验（read-before-edit / patch 冲突检测）。
 *
 * 因此序列化必须是**确定的**：对象键排序、不依赖插入顺序、不依赖 `Date.now()`。
 */

import { createHash } from "node:crypto"

/**
 * 递归排序对象键后序列化。数组的顺序是有语义的（命令参数、补丁行），保留原序。
 * `undefined` 字段被丢弃，与 JSON.stringify 行为一致。
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    // 函数与 undefined 在 JSON 里本就会被丢弃，这里统一成 undefined
    return typeof value === "function" || value === undefined ? undefined : value
  }
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item))
  }
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    const v = sortValue(record[key])
    if (v !== undefined) out[key] = v
  }
  return out
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex")
}

/**
 * 参数 hash：审批与幂等键都用它。
 *
 * 对入参做归一化（键排序、去 undefined）之后再哈希，保证"语义相同但键序不同"的
 * 两次调用得到同一个 hash —— 否则模型换个键顺序写 JSON 就能绕过审批绑定。
 */
export function parameterHash(input: unknown): string {
  return sha256(stableStringify(input))
}

export function contentHash(input: string | Buffer): string {
  return sha256(input)
}

/** 取前 N 位十六进制，用于日志与 UI 展示。 */
export function shortHash(input: string | Buffer, length = 12): string {
  return sha256(input).slice(0, length)
}

/**
 * 从参数摘要生成幂等键：同一任务 + 同一工具 + 同一参数 = 同一键。
 * 用于「结果未知时不盲目重放」的判断依据。
 */
export function idempotencyKey(parts: { taskId: string; toolName: string; args: unknown }): string {
  return sha256(`${parts.taskId}|${parts.toolName}|${stableStringify(parts.args)}`)
}
