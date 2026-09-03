/**
 * 持久化契约（ADR-2 / data-and-events.md §2–§3）。
 *
 * 状态、检查点、事件三件事**各有职责，不能混成一个"唯一事实源"**：
 * - 状态告诉调度器任务现在在哪一步；
 * - 检查点保存可恢复的执行现场；
 * - 事件保留发生过什么，供回放与审计。
 *
 * 一致性规则：
 * - 每次状态转换带 `state_version` 乐观锁（"我基于版本 5 改的，改之前它变成 6 就作废"）；
 * - `append` 与 `transition` 在同一事务里跑，避免内存与数据库各留一份不一致的账本；
 * - 事件按 seq 追加，`(task_id, seq)` 唯一约束；
 * - 审批只生效一次并与 `parameter_hash` 绑定。
 */

import type {
  Budget,
  BudgetUsage,
  ExecutionPlan,
  TaskEvent,
  TaskMode,
  TaskStatus,
} from "../shared/contracts.js"
import type { ModelMessage } from "../model/types.js"

export interface TaskState {
  id: string
  title: string
  userRequest: string
  mode: TaskMode
  status: TaskStatus
  /** 乐观锁版本号。 */
  stateVersion: number
  workspaceRoot: string
  baseCommit?: string
  worktreeRef?: string
  budget: Budget
  usage: BudgetUsage
  createdAt: string
  updatedAt: string
  currentCheckpointId?: string
  lastErrorCode?: string
  cancelRequestedAt?: string
  /** 计划的引用：正文存在检查点里，状态里只留版本号。 */
  planVersion?: number
  /** 会话历史（session 层统一管理，恢复时原地读回同一份）。 */
  messages: ModelMessage[]
}

export interface Checkpoint {
  id: string
  taskId: string
  version: number
  status: TaskStatus
  /** 存引用与摘要，不存整段 diff —— 把 diff 塞进来会让这张表变成第二个事实源。 */
  plan?: ExecutionPlan
  completedStepIds: string[]
  /**
   * 截至该检查点已改动的文件。
   *
   * 单独成列，不要塞进 `completedStepIds`：那是**计划步骤**的完成清单，
   * 混在一起会让恢复方把"改过的文件"当成"做完的步骤"，诊断全错。
   */
  changedFiles: string[]
  contextSummary?: string
  workspaceSnapshotRef?: string
  /** 截至该检查点的消息条数，用于 replay 快进。 */
  messageCount: number
  createdAt: string
}

export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired"

export interface ApprovalRecord {
  id: string
  taskId: string
  toolCallId?: string
  toolName: string
  requestSummary: string
  parameterHash: string
  policyVersion: string
  status: ApprovalStatus
  requestedAt: string
  expiresAt: string
  decidedBy?: string
  decidedAt?: string
  decisionReason?: string
}

export type ToolCallStatus =
  "started" | "succeeded" | "failed" | "timed_out" | "cancelled" | "outcome_unknown"

export interface ToolCallRecord {
  id: string
  taskId: string
  toolName: string
  inputHash: string
  idempotencyKey: string
  idempotency: "safe" | "keyed" | "non_idempotent"
  status: ToolCallStatus
  startedAt: string
  finishedAt?: string
  durationMs?: number
  errorCode?: string
  retryCount: number
  resultRef?: string
}

export interface ArtifactRecord {
  id: string
  taskId: string
  kind: string
  uri: string
  sha256: string
  sizeBytes: number
  metadata?: Record<string, unknown>
  createdAt: string
}

export interface AppendResult {
  /** 本次追加后的最大 seq。 */
  seq: number
}

export interface Store {
  readonly kind: "memory" | "sqlite"

  /* 任务 */
  createTask(
    input: Omit<TaskState, "stateVersion" | "createdAt" | "updatedAt" | "messages">,
  ): Promise<TaskState>
  getTask(taskId: string): Promise<TaskState | undefined>
  /** 乐观锁更新：版本不匹配抛错，本次转换作废。 */
  updateTask(taskId: string, patch: Partial<TaskState>, expectedVersion: number): Promise<TaskState>
  listTasks(): Promise<TaskState[]>

  /* 事件（只追加） */
  appendEvents(taskId: string, events: readonly TaskEvent[]): Promise<AppendResult>
  readEventsSince(taskId: string, seq: number): Promise<TaskEvent[]>
  readAllEvents(taskId: string): Promise<TaskEvent[]>
  /** 同一事务内"更新状态 + 追加事件"。 */
  transition(
    taskId: string,
    to: TaskStatus,
    event: TaskEvent,
    expectedVersion: number,
  ): Promise<TaskState>

  /* 会话历史 */
  appendMessages(taskId: string, messages: readonly ModelMessage[]): Promise<void>
  getMessages(taskId: string): Promise<ModelMessage[]>
  replaceMessages(taskId: string, messages: readonly ModelMessage[]): Promise<void>

  /* 检查点 */
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>
  latestCheckpoint(taskId: string): Promise<Checkpoint | undefined>

  /* 审批 */
  createApproval(approval: ApprovalRecord): Promise<void>
  getApproval(id: string): Promise<ApprovalRecord | undefined>
  findPendingApproval(taskId: string, parameterHash: string): Promise<ApprovalRecord | undefined>
  decideApproval(
    id: string,
    decision: "allowed" | "denied",
    by: string,
    reason?: string,
  ): Promise<ApprovalRecord>
  expireApprovals(now: Date): Promise<number>

  /* 工具调用 */
  startToolCall(record: ToolCallRecord): Promise<void>
  finishToolCall(
    id: string,
    patch: Partial<
      Pick<ToolCallRecord, "status" | "finishedAt" | "durationMs" | "errorCode" | "resultRef">
    >,
  ): Promise<void>
  bumpToolCallRetry(id: string): Promise<void>
  /** 未闭合的工具调用，用于崩溃恢复时决定重跑 / 查证 / 标记未知。 */
  openToolCalls(taskId: string): Promise<ToolCallRecord[]>

  /* 产物 */
  createArtifact(artifact: ArtifactRecord): Promise<void>
  listArtifacts(taskId: string): Promise<ArtifactRecord[]>

  close(): Promise<void>
}

/** 乐观锁冲突：另一个执行方已经动过这个任务。 */
export class VersionConflictError extends Error {
  constructor(taskId: string, expected: number, actual: number) {
    super(
      `Task ${taskId} version conflict: expected ${expected}, found ${actual}. ` +
        "Another executor advanced this task; this transition is void.",
    )
    this.name = "VersionConflictError"
  }
}
