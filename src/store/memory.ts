/**
 * 内存实现（development-guide.md §3：第一个循环可以用内存数组假扮事件流，
 * 但它必须走**同一个接口**，否则换库等于重写循环）。
 *
 * 这个实现不是"假的简化版"：乐观锁、seq 唯一约束、审批一次性与过期、
 * 未闭合工具调用查询，全部按 SQLite 版同样的语义实现，因此两套实现可以互换着跑测试。
 */

import type { TaskEvent, TaskStatus } from "../shared/contracts.js"
import type { ModelMessage } from "../model/types.js"
import {
  VersionConflictError,
  type AppendResult,
  type ApprovalRecord,
  type ArtifactRecord,
  type Checkpoint,
  type Store,
  type TaskState,
  type ToolCallRecord,
} from "./types.js"

export class MemoryStore implements Store {
  readonly kind = "memory" as const

  private readonly tasks = new Map<string, TaskState>()
  private readonly events = new Map<string, TaskEvent[]>()
  private readonly seqs = new Map<string, number>()
  private readonly messages = new Map<string, ModelMessage[]>()
  private readonly checkpoints = new Map<string, Checkpoint[]>()
  private readonly approvals = new Map<string, ApprovalRecord>()
  private readonly toolCalls = new Map<string, ToolCallRecord>()
  private readonly artifacts = new Map<string, ArtifactRecord[]>()

  async createTask(
    input: Omit<TaskState, "stateVersion" | "createdAt" | "updatedAt" | "messages">,
  ): Promise<TaskState> {
    const now = new Date().toISOString()
    const state: TaskState = {
      ...input,
      stateVersion: 1,
      createdAt: now,
      updatedAt: now,
      messages: [],
    }
    this.tasks.set(state.id, state)
    this.events.set(state.id, [])
    this.seqs.set(state.id, 0)
    this.messages.set(state.id, [])
    this.checkpoints.set(state.id, [])
    this.artifacts.set(state.id, [])
    return structuredClone(state)
  }

  async getTask(taskId: string): Promise<TaskState | undefined> {
    const state = this.tasks.get(taskId)
    if (!state) return undefined
    return { ...structuredClone(state), messages: [...(this.messages.get(taskId) ?? [])] }
  }

  async updateTask(
    taskId: string,
    patch: Partial<TaskState>,
    expectedVersion: number,
  ): Promise<TaskState> {
    const current = this.tasks.get(taskId)
    if (!current) throw new Error(`Task not found: ${taskId}`)
    if (current.stateVersion !== expectedVersion) {
      throw new VersionConflictError(taskId, expectedVersion, current.stateVersion)
    }
    const next: TaskState = {
      ...current,
      ...patch,
      id: current.id,
      stateVersion: current.stateVersion + 1,
      updatedAt: new Date().toISOString(),
      messages: current.messages,
    }
    this.tasks.set(taskId, next)
    return this.getTask(taskId) as Promise<TaskState>
  }

  async listTasks(): Promise<TaskState[]> {
    return [...this.tasks.values()].map((t) => structuredClone(t))
  }

  async appendEvents(taskId: string, events: readonly TaskEvent[]): Promise<AppendResult> {
    const list = this.events.get(taskId)
    if (!list) throw new Error(`Task not found: ${taskId}`)
    let maxSeq = this.seqs.get(taskId) ?? 0
    for (const event of events) {
      if (event.seq <= maxSeq && list.some((existing) => existing.seq === event.seq)) {
        // 重复投递撞 (task_id, seq) 唯一约束
        throw new Error(`Duplicate event seq ${event.seq} for task ${taskId}`)
      }
      list.push({ ...event })
      maxSeq = Math.max(maxSeq, event.seq)
    }
    this.seqs.set(taskId, maxSeq)
    return { seq: maxSeq }
  }

  async readEventsSince(taskId: string, seq: number): Promise<TaskEvent[]> {
    const list = this.events.get(taskId) ?? []
    return list.filter((event) => event.seq > seq).map((e) => ({ ...e }))
  }

  async readAllEvents(taskId: string): Promise<TaskEvent[]> {
    return (this.events.get(taskId) ?? []).map((e) => ({ ...e }))
  }

  /** 同一事务里"更新状态 + 追加事件"。内存实现里这两步之间不会被打断。 */
  async transition(
    taskId: string,
    to: TaskStatus,
    event: TaskEvent,
    expectedVersion: number,
  ): Promise<TaskState> {
    const current = this.tasks.get(taskId)
    if (!current) throw new Error(`Task not found: ${taskId}`)
    if (current.stateVersion !== expectedVersion) {
      throw new VersionConflictError(taskId, expectedVersion, current.stateVersion)
    }
    await this.appendEvents(taskId, [event])
    return this.updateTask(taskId, { status: to }, expectedVersion)
  }

  async appendMessages(taskId: string, messages: readonly ModelMessage[]): Promise<void> {
    const list = this.messages.get(taskId)
    if (!list) throw new Error(`Task not found: ${taskId}`)
    list.push(...structuredClone(messages as ModelMessage[]))
  }

  async getMessages(taskId: string): Promise<ModelMessage[]> {
    return structuredClone(this.messages.get(taskId) ?? [])
  }

  async replaceMessages(taskId: string, messages: readonly ModelMessage[]): Promise<void> {
    this.messages.set(taskId, structuredClone(messages as ModelMessage[]))
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    const list = this.checkpoints.get(checkpoint.taskId)
    if (!list) throw new Error(`Task not found: ${checkpoint.taskId}`)
    list.push({ ...checkpoint })
  }

  async latestCheckpoint(taskId: string): Promise<Checkpoint | undefined> {
    const list = this.checkpoints.get(taskId) ?? []
    const last = list[list.length - 1]
    if (!last) return undefined
    return { ...last }
  }

  async createApproval(approval: ApprovalRecord): Promise<void> {
    this.approvals.set(approval.id, { ...approval })
  }

  async getApproval(id: string): Promise<ApprovalRecord | undefined> {
    const record = this.approvals.get(id)
    return record ? { ...record } : undefined
  }

  async findPendingApproval(
    taskId: string,
    parameterHash: string,
  ): Promise<ApprovalRecord | undefined> {
    for (const approval of this.approvals.values()) {
      if (
        approval.taskId === taskId &&
        approval.parameterHash === parameterHash &&
        approval.status === "pending"
      ) {
        return { ...approval }
      }
    }
    return undefined
  }

  /** 审批只生效一次：已决的审批再次 decide 直接报错，防重复放行。 */
  async decideApproval(
    id: string,
    decision: "allowed" | "denied",
    by: string,
    reason?: string,
  ): Promise<ApprovalRecord> {
    const record = this.approvals.get(id)
    if (!record) throw new Error(`Approval not found: ${id}`)
    if (record.status !== "pending") {
      throw new Error(`Approval ${id} already decided (${record.status}); approvals are single-use`)
    }
    const updated: ApprovalRecord = {
      ...record,
      status: decision,
      decidedBy: by,
      decidedAt: new Date().toISOString(),
      ...(reason ? { decisionReason: reason } : {}),
    }
    this.approvals.set(id, updated)
    return { ...updated }
  }

  async expireApprovals(now: Date): Promise<number> {
    let count = 0
    for (const [id, record] of this.approvals) {
      if (record.status !== "pending") continue
      if (Date.parse(record.expiresAt) > now.getTime()) continue
      this.approvals.set(id, { ...record, status: "expired" })
      count += 1
    }
    return count
  }

  async startToolCall(record: ToolCallRecord): Promise<void> {
    this.toolCalls.set(record.id, { ...record })
  }

  async finishToolCall(
    id: string,
    patch: Partial<
      Pick<ToolCallRecord, "status" | "finishedAt" | "durationMs" | "errorCode" | "resultRef">
    >,
  ): Promise<void> {
    const record = this.toolCalls.get(id)
    if (!record) throw new Error(`Tool call not found: ${id}`)
    this.toolCalls.set(id, { ...record, ...patch })
  }

  async bumpToolCallRetry(id: string): Promise<void> {
    const record = this.toolCalls.get(id)
    if (!record) throw new Error(`Tool call not found: ${id}`)
    this.toolCalls.set(id, { ...record, retryCount: record.retryCount + 1 })
  }

  async openToolCalls(taskId: string): Promise<ToolCallRecord[]> {
    return [...this.toolCalls.values()]
      .filter((record) => record.taskId === taskId && record.status === "started")
      .map((record) => ({ ...record }))
  }

  async createArtifact(artifact: ArtifactRecord): Promise<void> {
    const list = this.artifacts.get(artifact.taskId)
    if (!list) throw new Error(`Task not found: ${artifact.taskId}`)
    list.push({ ...artifact })
  }

  async listArtifacts(taskId: string): Promise<ArtifactRecord[]> {
    return (this.artifacts.get(taskId) ?? []).map((a) => ({ ...a }))
  }

  async close(): Promise<void> {
    /* 内存实现无资源可释放 */
  }
}
