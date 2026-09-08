/**
 * SQLite 持久化（data-and-events.md §2）。
 *
 * MVP 用 SQLite 落地与 PostgreSQL 相同的逻辑模型：先跑起来，逻辑不变，
 * 以后换库只换驱动。表结构与字段沿用文档里已定义的名字。
 *
 * 运行时用 Node 内置的 `node:sqlite`（Node 22.5+），不引三方原生模块 ——
 * 原生模块在 CI 与多平台下会引入预编译二进制的额外失败面。不可用时由
 * `createStore()` 回落到内存实现，并显式告知调用方。
 */

import path from "node:path"
import { promises as fs } from "node:fs"
import type {
  Budget,
  BudgetUsage,
  ExecutionPlan,
  TaskEvent,
  TaskStatus,
} from "../shared/contracts.js"
import { DEFAULT_BUDGET, createUsage } from "../shared/contracts.js"
import type { ModelMessage } from "../model/types.js"
import { MemoryStore } from "./memory.js"
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS coding_tasks (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL,
  user_request         TEXT NOT NULL,
  mode                 TEXT NOT NULL,
  status               TEXT NOT NULL,
  state_version        INTEGER NOT NULL,
  workspace_root       TEXT NOT NULL,
  base_commit          TEXT,
  worktree_ref         TEXT,
  budget_json          TEXT NOT NULL DEFAULT '{}',
  usage_json           TEXT NOT NULL DEFAULT '{}',
  plan_version         INTEGER,
  current_checkpoint_id TEXT,
  last_error_code      TEXT,
  cancel_requested_at  TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  event_type   TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  parent_call_id TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (task_id, seq)
);

CREATE TABLE IF NOT EXISTS task_checkpoints (
  id                     TEXT PRIMARY KEY,
  task_id                TEXT NOT NULL,
  version                INTEGER NOT NULL,
  status                 TEXT NOT NULL,
  plan_json              TEXT,
  completed_steps_json   TEXT NOT NULL DEFAULT '[]',
  changed_files_json     TEXT NOT NULL DEFAULT '[]',
  context_summary_json   TEXT,
  workspace_snapshot_ref TEXT,
  message_count          INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  UNIQUE (task_id, version)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  input_hash      TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  idempotency     TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  duration_ms     INTEGER,
  error_code      TEXT,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  result_ref      TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  tool_call_id    TEXT,
  tool_name       TEXT NOT NULL,
  request_summary TEXT NOT NULL,
  parameter_hash  TEXT NOT NULL,
  policy_version  TEXT NOT NULL,
  status          TEXT NOT NULL,
  requested_at    TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  decided_by      TEXT,
  decided_at      TEXT,
  decision_reason TEXT
);

CREATE TABLE IF NOT EXISTS task_artifacts (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  uri         TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  content_json TEXT NOT NULL,
  UNIQUE (task_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_events_task_seq ON task_events (task_id, seq);
CREATE INDEX IF NOT EXISTS idx_toolcalls_task ON tool_calls (task_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_task_hash ON approvals (task_id, parameter_hash);
CREATE INDEX IF NOT EXISTS idx_messages_task ON session_messages (task_id, seq);
`

interface StatementSyncLike {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

/**
 * 一条版本化迁移。
 *
 * 为什么不再用"散落的 `ensureColumn`"：Agent 持续增加 MCP / Skills / Worktree /
 * Session / Plugin 之后，表结构变更会越来越多；没有版本记录时，
 * 既无法判断"这个库到底升级到哪一步"，也无法保证"一次迁移要么全成、要么全不成"。
 */
interface Migration {
  version: number
  name: string
  apply: (db: DatabaseSyncLike) => void
}

/** 迁移记录表。启动时先建它，再按版本号顺序补。 */
const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial-schema",
    /**
     * 全部 `CREATE ... IF NOT EXISTS`，因此对"已经在用但没有迁移记录"的旧库也安全：
     * 它只会补上缺失的表/索引，不会覆盖已有数据。
     */
    apply: (db) => db.exec(SCHEMA),
  },
  {
    version: 2,
    name: "task-checkpoints-changed-files",
    /** 旧库的 `task_checkpoints` 没有 `changed_files_json`，少了它 saveCheckpoint 直接报错。 */
    apply: (db) =>
      ensureColumnOn(db, "task_checkpoints", "changed_files_json", "TEXT NOT NULL DEFAULT '[]'"),
  },
]

/**
 * 幂等补列：列已存在就跳过，可重复执行。
 *
 * 只允许在**迁移脚本内部**使用：`table` / `column` 必须取自本文件的字面量，
 * 不能接受外部输入（PRAGMA / ALTER TABLE 的标识符拼接没有参数化路径）。
 */
function ensureColumnOn(db: DatabaseSyncLike, table: string, column: string, ddl: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>
  if (rows.some((row) => String(row.name) === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}

/** 打开结果：成功给 store，失败给一句人能看懂的原因。 */
export interface OpenResult {
  store?: SqliteStore
  reason?: string
}

interface DatabaseSyncLike {
  exec(sql: string): void
  prepare(sql: string): StatementSyncLike
  close(): void
}

export class SqliteStore implements Store {
  readonly kind = "sqlite" as const

  private readonly db: DatabaseSyncLike
  private closed = false

  private constructor(db: DatabaseSyncLike) {
    this.db = db
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.migrate()
  }

  /**
   * 按版本顺序执行未应用的迁移。
   *
   * 每条迁移在**单独事务**里执行：迁移中途失败就整体回滚，库停在上一版本，
   * 不会出现"表改了一半、版本号也没记上"的中间态。失败直接抛出，
   * 由 `open()` 转成可读原因 —— 迁移失败时拒绝进入正常运行状态，
   * 比带着半升级的库继续跑安全得多。
   */
  private migrate(): void {
    this.db.exec(MIGRATIONS_TABLE)
    const rows = this.db.prepare("SELECT version FROM schema_migrations").all() as Array<{
      version?: unknown
    }>
    const applied = new Set(rows.map((row) => Number(row.version)))

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      this.db.exec("BEGIN IMMEDIATE")
      try {
        migration.apply(this.db)
        this.db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, new Date().toISOString())
        this.db.exec("COMMIT")
      } catch (err) {
        try {
          this.db.exec("ROLLBACK")
        } catch {
          // 回滚失败不该掩盖原始迁移错误
        }
        throw new Error(
          `Schema migration ${migration.version} (${migration.name}) failed: ${messageOf(err)}`,
          { cause: err },
        )
      }
    }
  }

  /** 当前已应用的最高版本号（`doctor` 与测试用）。 */
  schemaVersion(): number {
    this.assertOpen()
    const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
      { v?: unknown } | undefined
    return Number(row?.v ?? 0)
  }

  /**
   * 动态加载 node:sqlite。**失败时把原因带回来**：调用方据此给出可读的降级说明，
   * 否则用户只会看到"莫名变成了内存模式"，分不清是该升级 Node 还是目录没权限。
   */
  static async open(file: string): Promise<OpenResult> {
    let ctor: (new (file: string) => DatabaseSyncLike) | undefined
    try {
      const mod: unknown = await import("node:sqlite")
      ctor = (mod as { DatabaseSync?: new (file: string) => DatabaseSyncLike }).DatabaseSync
    } catch (err) {
      return { reason: `node:sqlite 不可用（${messageOf(err)}）；需要 Node >= 22.5` }
    }
    if (!ctor) return { reason: "node:sqlite 没有导出 DatabaseSync" }
    try {
      // 目录不存在时 SQLite 会直接打不开文件（它不会自己建目录），先建出来
      await fs.mkdir(path.dirname(file), { recursive: true })
      return { store: new SqliteStore(new ctor(file)) }
    } catch (err) {
      return { reason: `无法打开 ${file}（${messageOf(err)}）` }
    }
  }

  async createTask(
    input: Omit<TaskState, "stateVersion" | "createdAt" | "updatedAt" | "messages">,
  ): Promise<TaskState> {
    const now = new Date().toISOString()
    this.assertOpen()
    this.db
      .prepare(
        `INSERT INTO coding_tasks
         (id, title, user_request, mode, status, state_version, workspace_root, base_commit,
          worktree_ref, budget_json, usage_json, plan_version, current_checkpoint_id,
          last_error_code, cancel_requested_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.title,
        input.userRequest,
        input.mode,
        input.status,
        input.workspaceRoot,
        input.baseCommit ?? null,
        input.worktreeRef ?? null,
        JSON.stringify(input.budget),
        JSON.stringify(input.usage),
        input.planVersion ?? null,
        input.currentCheckpointId ?? null,
        input.lastErrorCode ?? null,
        input.cancelRequestedAt ?? null,
        now,
        now,
      )
    return (await this.getTask(input.id)) as TaskState
  }

  async getTask(taskId: string): Promise<TaskState | undefined> {
    this.assertOpen()
    const row = this.db.prepare(`SELECT * FROM coding_tasks WHERE id = ?`).get(taskId) as
      Record<string, unknown> | undefined
    if (!row) return undefined
    return {
      id: String(row.id),
      title: String(row.title),
      userRequest: String(row.user_request),
      mode: row.mode as TaskState["mode"],
      status: row.status as TaskStatus,
      stateVersion: Number(row.state_version),
      workspaceRoot: String(row.workspace_root),
      ...(row.base_commit ? { baseCommit: String(row.base_commit) } : {}),
      ...(row.worktree_ref ? { worktreeRef: String(row.worktree_ref) } : {}),
      // 列由本模块自己写入，正常不会解析失败；真失败说明行已损坏，
      // 此时按"新建任务"对齐（默认预算 + 零用量），不会悄悄放大限额。
      budget: parseJson<Budget>(String(row.budget_json), DEFAULT_BUDGET),
      usage: parseJson<BudgetUsage>(String(row.usage_json), createUsage()),
      ...(row.plan_version !== null && row.plan_version !== undefined
        ? { planVersion: Number(row.plan_version) }
        : {}),
      ...(row.current_checkpoint_id
        ? { currentCheckpointId: String(row.current_checkpoint_id) }
        : {}),
      ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
      ...(row.cancel_requested_at ? { cancelRequestedAt: String(row.cancel_requested_at) } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      messages: await this.getMessages(taskId),
    }
  }

  async updateTask(
    taskId: string,
    patch: Partial<TaskState>,
    expectedVersion: number,
  ): Promise<TaskState> {
    this.assertOpen()
    const current = await this.getTask(taskId)
    if (!current) throw new Error(`Task not found: ${taskId}`)
    if (current.stateVersion !== expectedVersion) {
      throw new VersionConflictError(taskId, expectedVersion, current.stateVersion)
    }
    const now = new Date().toISOString()
    const result = this.db
      .prepare(
        `UPDATE coding_tasks SET
           title = ?, user_request = ?, mode = ?, status = ?, state_version = state_version + 1,
           workspace_root = ?, base_commit = ?, worktree_ref = ?, budget_json = ?, usage_json = ?,
           plan_version = ?, current_checkpoint_id = ?, last_error_code = ?, cancel_requested_at = ?,
           updated_at = ?
         WHERE id = ? AND state_version = ?`,
      )
      .run(
        patch.title ?? current.title,
        patch.userRequest ?? current.userRequest,
        patch.mode ?? current.mode,
        patch.status ?? current.status,
        patch.workspaceRoot ?? current.workspaceRoot,
        patch.baseCommit ?? current.baseCommit ?? null,
        patch.worktreeRef ?? current.worktreeRef ?? null,
        JSON.stringify(patch.budget ?? current.budget),
        JSON.stringify(patch.usage ?? current.usage),
        patch.planVersion ?? current.planVersion ?? null,
        patch.currentCheckpointId ?? current.currentCheckpointId ?? null,
        patch.lastErrorCode ?? current.lastErrorCode ?? null,
        patch.cancelRequestedAt ?? current.cancelRequestedAt ?? null,
        now,
        taskId,
        expectedVersion,
      )
    if (changesOf(result) === 0) {
      throw new VersionConflictError(
        taskId,
        expectedVersion,
        (await this.getTask(taskId))?.stateVersion ?? -1,
      )
    }
    return (await this.getTask(taskId)) as TaskState
  }

  async listTasks(): Promise<TaskState[]> {
    this.assertOpen()
    const rows = this.db.prepare(`SELECT id FROM coding_tasks ORDER BY created_at`).all() as Array<{
      id: string
    }>
    const out: TaskState[] = []
    for (const row of rows) {
      const task = await this.getTask(row.id)
      if (task) out.push(task)
    }
    return out
  }

  async appendEvents(taskId: string, events: readonly TaskEvent[]): Promise<AppendResult> {
    this.assertOpen()
    let maxSeq = 0
    this.db.exec("BEGIN IMMEDIATE")
    try {
      for (const event of events) {
        this.db
          .prepare(
            `INSERT INTO task_events (task_id, seq, event_type, payload_json, parent_call_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            taskId,
            event.seq,
            event.type,
            JSON.stringify(event.payload ?? {}),
            event.parentCallId ?? null,
            event.timestamp,
          )
        maxSeq = Math.max(maxSeq, event.seq)
      }
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
    return { seq: maxSeq }
  }

  async readEventsSince(taskId: string, seq: number): Promise<TaskEvent[]> {
    this.assertOpen()
    const rows = this.db
      .prepare(`SELECT * FROM task_events WHERE task_id = ? AND seq > ? ORDER BY seq`)
      .all(taskId, seq) as Array<Record<string, unknown>>
    return rows.map(toEvent)
  }

  async readAllEvents(taskId: string): Promise<TaskEvent[]> {
    this.assertOpen()
    const rows = this.db
      .prepare(`SELECT * FROM task_events WHERE task_id = ? ORDER BY seq`)
      .all(taskId) as Array<Record<string, unknown>>
    return rows.map(toEvent)
  }

  /** 状态转换与事件追加在同一事务里，避免"界面显示已完成、库里仍在执行中"。 */
  async transition(
    taskId: string,
    to: TaskStatus,
    event: TaskEvent,
    expectedVersion: number,
  ): Promise<TaskState> {
    this.assertOpen()
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = this.db
        .prepare(
          `UPDATE coding_tasks SET status = ?, state_version = state_version + 1, updated_at = ? WHERE id = ? AND state_version = ?`,
        )
        .run(to, new Date().toISOString(), taskId, expectedVersion)
      if (changesOf(result) === 0) {
        const current = this.db
          .prepare(`SELECT state_version FROM coding_tasks WHERE id = ?`)
          .get(taskId) as { state_version: number } | undefined
        throw new VersionConflictError(taskId, expectedVersion, current?.state_version ?? -1)
      }
      this.db
        .prepare(
          `INSERT INTO task_events (task_id, seq, event_type, payload_json, parent_call_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          event.seq,
          event.type,
          JSON.stringify(event.payload ?? {}),
          event.parentCallId ?? null,
          event.timestamp,
        )
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
    return (await this.getTask(taskId)) as TaskState
  }

  async appendMessages(taskId: string, messages: readonly ModelMessage[]): Promise<void> {
    this.assertOpen()
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM session_messages WHERE task_id = ?`)
      .get(taskId) as { max_seq: number }
    let seq = Number(row.max_seq ?? 0)
    for (const message of messages) {
      seq += 1
      this.db
        .prepare(
          `INSERT INTO session_messages (task_id, seq, role, content_json) VALUES (?, ?, ?, ?)`,
        )
        .run(taskId, seq, message.role, JSON.stringify(message))
    }
  }

  async getMessages(taskId: string): Promise<ModelMessage[]> {
    this.assertOpen()
    const rows = this.db
      .prepare(`SELECT role, content_json FROM session_messages WHERE task_id = ? ORDER BY seq`)
      .all(taskId) as Array<{ role: string; content_json: string }>
    return rows.map((row) => {
      const parsed = parseJson(row.content_json, {})
      return parsed as ModelMessage
    })
  }

  async replaceMessages(taskId: string, messages: readonly ModelMessage[]): Promise<void> {
    this.assertOpen()
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.prepare(`DELETE FROM session_messages WHERE task_id = ?`).run(taskId)
      let seq = 0
      for (const message of messages) {
        seq += 1
        this.db
          .prepare(
            `INSERT INTO session_messages (task_id, seq, role, content_json) VALUES (?, ?, ?, ?)`,
          )
          .run(taskId, seq, message.role, JSON.stringify(message))
      }
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    this.assertOpen()
    this.db
      .prepare(
        `INSERT OR REPLACE INTO task_checkpoints
         (id, task_id, version, status, plan_json, completed_steps_json, changed_files_json,
          context_summary_json, workspace_snapshot_ref, message_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkpoint.id,
        checkpoint.taskId,
        checkpoint.version,
        checkpoint.status,
        checkpoint.plan ? JSON.stringify(checkpoint.plan) : null,
        JSON.stringify(checkpoint.completedStepIds),
        JSON.stringify(checkpoint.changedFiles),
        checkpoint.contextSummary ?? null,
        checkpoint.workspaceSnapshotRef ?? null,
        checkpoint.messageCount,
        checkpoint.createdAt,
      )
  }

  async latestCheckpoint(taskId: string): Promise<Checkpoint | undefined> {
    this.assertOpen()
    const row = this.db
      .prepare(`SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY version DESC LIMIT 1`)
      .get(taskId) as Record<string, unknown> | undefined
    return row ? toCheckpoint(row) : undefined
  }

  async createApproval(approval: ApprovalRecord): Promise<void> {
    this.assertOpen()
    this.db
      .prepare(
        `INSERT INTO approvals
         (id, task_id, tool_call_id, tool_name, request_summary, parameter_hash, policy_version,
          status, requested_at, expires_at, decided_by, decided_at, decision_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.taskId,
        approval.toolCallId ?? null,
        approval.toolName,
        approval.requestSummary,
        approval.parameterHash,
        approval.policyVersion,
        approval.status,
        approval.requestedAt,
        approval.expiresAt,
        approval.decidedBy ?? null,
        approval.decidedAt ?? null,
        approval.decisionReason ?? null,
      )
  }

  async getApproval(id: string): Promise<ApprovalRecord | undefined> {
    this.assertOpen()
    const row = this.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as
      Record<string, unknown> | undefined
    return row ? toApproval(row) : undefined
  }

  async findPendingApproval(
    taskId: string,
    parameterHash: string,
  ): Promise<ApprovalRecord | undefined> {
    this.assertOpen()
    const row = this.db
      .prepare(
        `SELECT * FROM approvals WHERE task_id = ? AND parameter_hash = ? AND status = 'pending' LIMIT 1`,
      )
      .get(taskId, parameterHash) as Record<string, unknown> | undefined
    return row ? toApproval(row) : undefined
  }

  async decideApproval(
    id: string,
    decision: "allowed" | "denied",
    by: string,
    reason?: string,
  ): Promise<ApprovalRecord> {
    this.assertOpen()
    const now = new Date().toISOString()
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_reason = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(decision, by, now, reason ?? null, id)
    if (changesOf(result) === 0) {
      const existing = await this.getApproval(id)
      if (!existing) throw new Error(`Approval not found: ${id}`)
      throw new Error(
        `Approval ${id} already decided (${existing.status}); approvals are single-use`,
      )
    }
    return (await this.getApproval(id)) as ApprovalRecord
  }

  async expireApprovals(now: Date): Promise<number> {
    this.assertOpen()
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`,
      )
      .run(now.toISOString())
    return changesOf(result)
  }

  async startToolCall(record: ToolCallRecord): Promise<void> {
    this.assertOpen()
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tool_calls
         (id, task_id, tool_name, input_hash, idempotency_key, idempotency, status, started_at,
          finished_at, duration_ms, error_code, retry_count, result_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.taskId,
        record.toolName,
        record.inputHash,
        record.idempotencyKey,
        record.idempotency,
        record.status,
        record.startedAt,
        record.finishedAt ?? null,
        record.durationMs ?? null,
        record.errorCode ?? null,
        record.retryCount,
        record.resultRef ?? null,
      )
  }

  async finishToolCall(
    id: string,
    patch: Partial<
      Pick<ToolCallRecord, "status" | "finishedAt" | "durationMs" | "errorCode" | "resultRef">
    >,
  ): Promise<void> {
    this.assertOpen()
    this.db
      .prepare(
        `UPDATE tool_calls SET
           status = COALESCE(?, status),
           finished_at = COALESCE(?, finished_at),
           duration_ms = COALESCE(?, duration_ms),
           error_code = COALESCE(?, error_code),
           result_ref = COALESCE(?, result_ref)
         WHERE id = ?`,
      )
      .run(
        patch.status ?? null,
        patch.finishedAt ?? null,
        patch.durationMs ?? null,
        patch.errorCode ?? null,
        patch.resultRef ?? null,
        id,
      )
  }

  async bumpToolCallRetry(id: string): Promise<void> {
    this.assertOpen()
    this.db.prepare(`UPDATE tool_calls SET retry_count = retry_count + 1 WHERE id = ?`).run(id)
  }

  async openToolCalls(taskId: string): Promise<ToolCallRecord[]> {
    this.assertOpen()
    const rows = this.db
      .prepare(`SELECT * FROM tool_calls WHERE task_id = ? AND status = 'started'`)
      .all(taskId) as Array<Record<string, unknown>>
    return rows.map(toToolCall)
  }

  async createArtifact(artifact: ArtifactRecord): Promise<void> {
    this.assertOpen()
    this.db
      .prepare(
        `INSERT OR REPLACE INTO task_artifacts (id, task_id, kind, uri, sha256, size_bytes, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.taskId,
        artifact.kind,
        artifact.uri,
        artifact.sha256,
        artifact.sizeBytes,
        artifact.metadata ? JSON.stringify(artifact.metadata) : null,
        artifact.createdAt,
      )
  }

  async listArtifacts(taskId: string): Promise<ArtifactRecord[]> {
    this.assertOpen()
    const rows = this.db
      .prepare(`SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at`)
      .all(taskId) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      kind: String(row.kind),
      uri: String(row.uri),
      sha256: String(row.sha256),
      sizeBytes: Number(row.size_bytes ?? 0),
      ...(row.metadata_json ? { metadata: parseJson(String(row.metadata_json), {}) } : {}),
      createdAt: String(row.created_at),
    }))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SqliteStore is closed")
  }
}

/* ------------------------------------------------------------------ *
 * 工厂与行映射
 * ------------------------------------------------------------------ */

export interface CreateStoreResult {
  store: Store
  /** SQLite 不可用时的降级说明（不为 undefined 时表示已回落）。 */
  degradedReason?: string
}

/**
 * 创建 store。SQLite 不可用时回落到内存实现并显式说明 ——
 * 静默降级会让"以为持久化了、其实没有"变成一次数据丢失事故。
 */
export async function createStore(options?: { sqliteFile?: string }): Promise<CreateStoreResult> {
  if (!options?.sqliteFile) return { store: new MemoryStore() }
  const opened = await SqliteStore.open(options.sqliteFile)
  if (opened.store) return { store: opened.store }
  return {
    store: new MemoryStore(),
    degradedReason: `已回落内存 store（本次会话不持久化）：${opened.reason ?? "未知原因"}`,
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function changesOf(result: unknown): number {
  if (typeof result === "object" && result !== null && "changes" in result) {
    return Number((result as { changes: unknown }).changes ?? 1)
  }
  // 老版本 StatementSync.run() 返回 undefined，视为成功
  return 1
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/** 解析失败返回 undefined（用于"这一列可空"的字段，避免用空对象冒充合法值）。 */
function parseJsonOpt<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

function toEvent(row: Record<string, unknown>): TaskEvent {
  return {
    eventId: String(row.id ?? `${row.task_id}:${row.seq}`),
    taskId: String(row.task_id),
    seq: Number(row.seq),
    type: String(row.event_type),
    timestamp: String(row.created_at),
    payload: parseJson(String(row.payload_json ?? "{}"), {}),
    parentCallId:
      row.parent_call_id === null || row.parent_call_id === undefined
        ? null
        : String(row.parent_call_id),
  }
}

function toCheckpoint(row: Record<string, unknown>): Checkpoint {
  // 计划解析不出来就当作"没存计划"，而不是塞一个空对象冒充合法计划 ——
  // 空对象会让下游以为计划存在却没有步骤，诊断信息反而更差。
  const plan = row.plan_json ? parseJsonOpt<ExecutionPlan>(String(row.plan_json)) : undefined
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    version: Number(row.version),
    status: row.status as TaskStatus,
    ...(plan ? { plan } : {}),
    completedStepIds: parseJson(String(row.completed_steps_json ?? "[]"), [] as string[]),
    changedFiles: parseJson(String(row.changed_files_json ?? "[]"), [] as string[]),
    ...(row.context_summary_json ? { contextSummary: String(row.context_summary_json) } : {}),
    ...(row.workspace_snapshot_ref
      ? { workspaceSnapshotRef: String(row.workspace_snapshot_ref) }
      : {}),
    messageCount: Number(row.message_count ?? 0),
    createdAt: String(row.created_at),
  }
}

function toApproval(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    ...(row.tool_call_id ? { toolCallId: String(row.tool_call_id) } : {}),
    toolName: String(row.tool_name),
    requestSummary: String(row.request_summary),
    parameterHash: String(row.parameter_hash),
    policyVersion: String(row.policy_version),
    status: row.status as ApprovalRecord["status"],
    requestedAt: String(row.requested_at),
    expiresAt: String(row.expires_at),
    ...(row.decided_by ? { decidedBy: String(row.decided_by) } : {}),
    ...(row.decided_at ? { decidedAt: String(row.decided_at) } : {}),
    ...(row.decision_reason ? { decisionReason: String(row.decision_reason) } : {}),
  }
}

function toToolCall(row: Record<string, unknown>): ToolCallRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    toolName: String(row.tool_name),
    inputHash: String(row.input_hash),
    idempotencyKey: String(row.idempotency_key),
    idempotency: row.idempotency as ToolCallRecord["idempotency"],
    status: row.status as ToolCallRecord["status"],
    startedAt: String(row.started_at),
    ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}),
    ...(row.duration_ms !== null && row.duration_ms !== undefined
      ? { durationMs: Number(row.duration_ms) }
      : {}),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    retryCount: Number(row.retry_count ?? 0),
    ...(row.result_ref ? { resultRef: String(row.result_ref) } : {}),
  }
}
