/**
 * 稳定标识生成。
 *
 * 所有 id 都带语义前缀，便于在日志与事件流里一眼区分主体类型。
 */

import { randomBytes } from "node:crypto"

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

/** 用 crypto 随机字节生成定长小写字母数字串（不做取模，避免偏置）。 */
function randomToken(length: number): string {
  const bytes = randomBytes(length)
  let out = ""
  for (let i = 0; i < length; i += 1) {
    const b = bytes[i] ?? 0
    out += ALPHABET[b % ALPHABET.length]
  }
  return out
}

export function newTaskId(): string {
  return `task_${randomToken(12)}`
}

export function newCallId(): string {
  return `call_${randomToken(12)}`
}

export function newEventId(taskId: string, seq: number): string {
  return `${taskId}:${seq}`
}

export function newSessionId(): string {
  return `sess_${randomToken(16)}`
}

export function newApprovalId(): string {
  return `apr_${randomToken(12)}`
}

export function newArtifactId(): string {
  return `art_${randomToken(12)}`
}

export function newCheckpointId(): string {
  return `ckpt_${randomToken(12)}`
}

/** 短随机串，用于 worktree 分支名等需要人类可读且低碰撞的场景。 */
export function shortId(length = 8): string {
  return randomToken(length)
}
