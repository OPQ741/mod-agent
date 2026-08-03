# Data & Events · 事件流与持久化

> 任务状态不能只存在内存的对话历史里。这篇讲 append-only 事件模型、SQLite 持久化与一致性规则。

## 1. EventStream 事件模型

所有状态 = 按时间排序的不可变事件序列（action + observation），可 replay / condense / audit。

```mermaid
flowchart LR
    E["Event 不可变<br/>id / 时间戳 / source"]
    E --> L["LLMConvertibleEvent 可转 LLM 消息"]
    L --> A["ActionEvent 读文件 / 改代码 / 跑命令"]
    L --> O["ObservationEvent 工具返回 / 测试结果"]
    E --> U["UserEvent 澄清回答 / 审批决定"]
    E --> S["SystemEvent 压缩 / 检查点 / 指标"]
    A --> Store[("EventStream 追加日志")]
    O --> Store
    U --> Store
    S --> Store
    Store --> R["Replay / Condense / Audit"]
```

事件包络：

```ts
interface TaskEvent<T = unknown> {
  eventId: string;        // task_id + sequence 的稳定标识
  taskId: string;
  seq: number;
  type: string;
  timestamp: string;
  payload: T;
}
```

事件类型：`task.status_changed`、`task.plan_ready`、`agent.message_delta`、`tool.started`、`tool.progress`、`tool.completed`、`approval.required`、`approval.decided`、`file.changed`、`validation.started`、`validation.completed`、`checkpoint.created`、`task.warning`、`task.completed`、`task.failed`、`task.cancelled`。

> 不把每个 token 都永久写库：流式发送文本增量，但只持久化重要生命周期事件、完成消息与必要审计内容。

## 2. 持久化表（SQLite）

PostgreSQL 是团队阶段的权威库；MVP 用 SQLite 落地同一套逻辑模型。

**`coding_tasks`**
`id`、`title`、`user_request`、`mode`、`status`、`risk_level`、`base_commit`、`worktree_ref`、`current_checkpoint_id`、`state_version`、`budget_json`、`usage_json`、`deadline_at`、`cancel_requested_at`、`last_error_code`、时间戳。

**`task_events`（追加式）**
`id`、`task_id`、`seq`、`event_type`、`payload_json`、`created_at`；唯一约束 `(task_id, seq)`，避免可变 JSON 覆盖历史审计。

**`task_checkpoints`**
`id`、`task_id`、`version`、`status`、`plan_json`、`completed_steps_json`、`context_summary_json`、`workspace_snapshot_ref`、`created_at`。存储可恢复状态及引用；Git commit / worktree 承担代码快照，不存整仓镜像。

**`tool_calls`**
`id`、`task_id`、`step_id`、`tool_name`、`input_json_redacted`、`input_hash`、`status`、`idempotency_key`、`started_at`、`finished_at`、`duration_ms`、`result_ref`、`error_code`、`retry_count`。

**`approvals`**
`id`、`task_id`、`tool_call_id`、`action_type`、`request_summary`、`parameter_hash`、`policy_version`、`status`、`requested_at`、`expires_at`、`decided_by`、`decided_at`、`decision_reason`。

**`task_artifacts`**
`id`、`task_id`、`kind`、`uri`、`sha256`、`size_bytes`、`metadata_json`、`created_at`（日志、截图、报告等）。

**`repo_index_snapshots`**
`id`、`workspace_id`、`commit_sha`、`index_version`、`status`、`artifact_uri`、`created_at`。

## 3. 数据一致性规则

- 每次状态转换带 `state_version` 乐观锁，防两个执行方同时推进任务；
- 每任务任一时刻只有一个有效执行租约，租约可续期、过期回收；
- 工具调用开始与结果分别持久化；结果未知的非幂等调用进入 `outcome_unknown`，而非自动标失败后重试；
- 事件按 `seq` 发送，断线后可从序号补拉；
- 审批只生效一次并与 `parameter_hash` 绑定，防审批后模型偷偷改操作参数；
- 每次状态转换在同一事务里「更新状态 + 追加事件」；
- 保存期限、源码 / 日志脱敏、租户隔离与删除策略在部署前定稿。

## 4. 长期记忆

会话结束后异步整理记忆：去重、压缩、带锁防并发。项目级记忆写入 `AGENTS.md`（分层：全局 / 项目 / 子目录随访问路径注入）；NOTES/TODO 由 Agent 在任务中持续维护，压缩后读回。详见 [context-engineering.md](./context-engineering.md)。
