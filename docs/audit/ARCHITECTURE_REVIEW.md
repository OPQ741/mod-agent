# ARCHITECTURE_REVIEW · 架构评审

> 对照物：`docs/architecture.md` 的 ADR 集合、`docs/agent-loop.md` 的循环形状、`docs/security.md` 的判定序
> 评审立场：先确认设计是否成立，再判断实现是否忠于设计

## 1. 整体形状

```text
cli/ (commander)  ─┐
                   ├─→ runtime/driver.ts ─→ runtime/loop.ts  ← 唯一动力源
sdk/ (query)      ─┘          │                  │
                              │                  ├─→ model/gateway → provider
                              │                  ├─→ tools/executor → registry → builtin
                              │                  ├─→ policy/engine → rules / command / pathguard
                              │                  ├─→ patch/edit
                              │                  ├─→ validation/runner
                              │                  └─→ context/*（提示词 / 规则 / 压缩）
                              └─→ store（sqlite | memory）  ← 事件、检查点、审批、工具调用
```

依赖方向单一、无环，`shared` 是唯一的叶子层。`runtime` 与 `store` 之间是接口而非具体实现，
`ModelProvider` 抽象让厂商差异完全关在适配层内。**这套分层是站得住的**，不需要重画。

## 2. ADR 落地核对

| ADR                          | 声明                                               | 实现                                                                                                       | 判定                                       |
| ---------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| ADR-1 单一主循环             | 只有一条循环，第二个循环会让暂停/取消/预算半边失效 | `loop.ts:169` 是唯一执行体；CLI 与 SDK 都经 `driver.ts` 消费它                                             | ✅ 成立                                    |
| ADR-2 工具调用先落 `started` | 崩溃恢复的唯一判据                                 | `loop.ts:575-585` 调用前落库；`runtime.ts:431-441` 据此判 `outcome_unknown`                                | ✅ 成立                                    |
| ADR-3 命令拆结构化字段       | 不把整段文本交给策略做正则                         | `CommandRequestSchema` 为 `executable + args[]`；`parseCommandSegments` 会再拼回去拆段以防 args 内藏连接符 | ✅ 成立                                    |
| ADR-6 可靠性关在网关一处     | 超时/重试/记账只在这里做                           | `gateway.ts` 是唯一实现；provider 只管协议                                                                 | ⚠️ 基本成立，`Retry-After` 未接（AUD-014） |
| ADR-7 CLI-first              | 命令行优先，可脚本化                               | 三种输出格式 + 明确退出码 0/1/2                                                                            | ✅ 成立                                    |
| ADR-8 判定只认结构化请求     | 不读模型自然语言                                   | `policyPaths`/`policyCommand`/`policyDomains`；且在 `validate` 之后求值                                    | ✅ 成立（设计亮点）                        |
| ADR-9 分层配置               | 数组并集、标量取最 specific                        | `mergeSettings` 按 `LAYER_PRIORITY` 排序后合并                                                             | ✅ 成立                                    |
| ADR-10 CLI 与 SDK 共内核     | 同一 runtime 与同一 driver                         | `sdk/index.ts` 直接调 `driveTask`；测试 `sdk.test.ts` 断言"同一脚本产出同样终态与退出码"                   | ✅ 成立（有测试守护）                      |

## 3. 主循环的形状评审

**形状选择正确。** 异步生成器带来的背压是真实的：消费端不 `next()` 就不会继续跑，
这让"暂停"不需要在工具内部检查信号也能生效一半。`runWithTimeout` 用 `Promise.race`
而不是依赖工具自觉读 `signal`（`executor.ts:321-328`），这个决定救了三个开关。

**结构上有一个反复出现的问题：状态机的权威性被架空。**

`state-machine.ts` 顶部写着"状态只能由这里的显式转换函数修改，其他模块不得直接赋值"，
但实际有 4 处直接 `updateTask({ status })` 绕过转换表：

| 位置                               | 转换                 | 转换表是否允许                                                      |
| ---------------------------------- | -------------------- | ------------------------------------------------------------------- |
| `runtime.ts:270-273`（进入执行态） | `queued → executing` | ❌ 不在表中（queued 只允许 initializing/cancelling/failed/expired） |
| `runtime.ts:402`（`pause`）        | 任意 → `paused`      | 部分允许                                                            |
| `runtime.ts:410-414`（`cancel`）   | 任意 → `cancelled`   | ❌ 应经 `cancelling`                                                |
| `runtime.ts:443`（`resume`）       | 任意 → `queued`      | 部分允许                                                            |

后果不是"跑不起来"，而是**状态机给出的保证是假的**：它看起来在兜底，实际上每次
都可能被绕过。更具体的连锁反应见 AUD-008（并发取消撞乐观锁）。

**建议方向**：把 `Store.transition()`（已实现、已测试、无人调用，AUD-017）真正接到
`moveTo` / `pause` / `cancel` / `resume` 上，让"状态 + 事件"在一个事务里落库。
这不需要新设计，只需要把已有的东西接上。

## 4. 工具执行生命周期的评审

`executor.ts` 注释写的是八阶段，实际顺序是：

```text
① 查找 → ② Zod 校验 → ③ 业务 validate → ④ 策略判定 → ⑤ PreToolUse Hook
       → ⑥ 执行 → ⑦ 结果裁剪/落盘 → ⑧ PostToolUse Hook → 返回
```

与注释的两处偏差：

- 注释说"③ 并行启动 —— Pre-Tool Hook 与命令安全判定同时起"，**实际是串行的**，
  且 Hook 排在策略之后。串行本身没问题（延迟可接受），但顺序错误带来 AUD-007：
  策略审的是原始入参，Hook 改后的入参直接被执行。
- `AgentTool.checkPermissions` 在契约里声明了（`contracts.ts:250`），执行器从不调用。
  这是一个"看起来有、实际没有"的扩展点，比不声明更糟。

**执行器最值得肯定的一点**：它真的做到了"不向上抛业务异常"——
除了 AUD-002 那一条 `DenialLimitExceeded` 从 `decide` 回调里漏出来。
补一个 `try/catch` 把策略异常也转成 `failed` 结果，这条纪律才算闭环。

## 5. 策略引擎的评审

判定序 `deny → allow → 档位` 实现得干净：三个独立函数、没有 switch fallthrough、
deny 永远第一、`bypassPermissions` 也翻不了 deny 的案（有测试守护）。

**两处结构性问题**：

1. **`allow` 分支对多路径用 `.some()`**（`engine.ts:414-416`）。deny 用 `.some` 是对的
   （任一路径违规即拒），allow 必须是 `.every`（全部路径都在授权范围内才放行）。
   当前没有多路径的写工具，所以是潜伏缺陷；一旦加上"批量重命名/多文件补丁"类工具，
   它会立刻变成 P0。
2. **策略引擎的"拒绝计数"用异常表达上限**。`DenialLimitExceeded` 是控制流而不是
   错误分类，它从 `evaluate()` 抛出，穿透了本该"错误即数据"的执行器。建议改为
   返回一个 `effect: "abort"` 的三态扩展，或由循环在 `permissionDenials.length`
   上判断——后者更简单，也更符合"预算类限制由循环负责"的现有分工。

**命令解析这一层是全仓库质量最高的模块之一**：wrapper 剥离区分了"剥"（timeout/nice/env）
与"不剥"（npx/docker/mise/xargs），`find` 的危险参数要求精确匹配，
`isUnresolvableShape` 对 `sh -c`、`xargs -I`、`node -e`、`python -c`、输出重定向一律拦。
这些语义选择都有明确理由，且都有测试。

## 6. 上下文工程的评审

**动静分离做得对**：静态块确定性渲染（无时间戳、无随机序），动态块（cwd/平台/模式/轮次/日期）
排在静态块之后，规则文件进首条 user 消息的 `<system-reminder>` 而不是系统提示词。
这是前缀缓存的正确姿势。

**但缓存这一层只做了一半**：

- `assemble()` 计算了 `cacheBreakpoint`（`registry.ts:241`），**从未使用**；
- 两个 provider 都没有发 `cache_control` 标记。

也就是说"保证前缀缓存稳定"的设计意图成立，但收益没有兑现。这不是缺陷，是未完成的优化。

**压缩流水线有两个结构问题**：

1. **保护错了对象**（AUD-022）。`takeHead` 的契约是"system + 首条 user（用户请求）"，
   但循环装配的顺序是 `[system, 动态环境块, ...messages]`，首条 user 是环境块。
   用户请求因此落在可折叠区。当前没有接 `summarizer`，中间区只是折叠 observation
   不整体丢弃，所以还没暴露；一旦接入 LLM 摘要（`compaction.ts:127-136` 已经预留），
   用户请求会被摘要替换掉——目标漂移的第一道防线就没了。
2. **压缩只作用于发送副本，不落库**。`messages` 数组在内存与 store 里持续增长，
   每轮重新压缩一遍。长会话下这是 O(n²) 的重复计算，恢复时还要全量重放。

## 7. 存储与恢复的评审

SQLite schema 与文档逻辑模型一致，字段命名沿用文档定义，这一点很好。
乐观锁（`WHERE state_version = ?` + `changes === 0` 判冲突）实现正确。

**恢复语义的设计是对的**：非幂等 + 未闭合 → `outcome_unknown`，不自动重放。
这是"宁可问人也不要重复副作用"的正确选择。

**三个结构性问题**：

1. `transition()` 存在但不用（见 §3），于是"状态变更与事件追加同事务"的保证不成立。
2. `appendMessages` 不在事务里（`sqlite.ts:419-433`），且用 `MAX(seq)` 读后再写。
   与 `appendEvents` 的事务写法不一致。
3. `getTask` 每次都 `getMessages`（`sqlite.ts:266`）。循环内每轮至少调 3 次
   （`moveTo`、`finish`、检查点前），每次全量 JSON 解析。任务跑到 200 条消息时
   这是明显的浪费。

## 8. 可观测性的评审

日志层做得不错：JSONL、递归脱敏、stdout/stderr 分工明确（headless 的机器可读输出不被日志污染）。

**指标覆盖与文档要求有差距**：

- 文档要求"三态决策计数 + 等审批的墙钟时间"，`policy.decision.{allow,ask,deny}` 有，
  `approval.blocked_ms` **没有**（`Metrics.startTimer` 从未被调用）；
- `retry.api` 只写日志不进事件流（AUD-010），恢复时无法从事件流还原退避历史——
  而这正是该事件类型存在的理由。

## 9. 架构层面的三个主要风险

按"如果不处理，会在什么时候造成麻烦"排序：

1. **声明与实现的缝隙会持续扩大**。当前已有至少 7 处"注释/工具描述/文档声称的保障
   与代码行为不符"（AUD-003/004/009/014/015/019/020）。这类问题的危险在于：
   读者（包括未来的维护者与使用 agent 的模型自己）会**依据描述做决策**。
   `plan.enter_plan_mode` 的描述直接告诉模型"写工具已不可用"，而它仍然可用——
   这等于在系统提示词里埋了一条错误信息。
2. **状态机与事务的权威性被架空**。一旦引入并发（后台任务、多 agent、TUI 的
   异步审批），现在这些"偶尔能跑通"的路径会集中变成竞态。
3. **验证链路是策略体系外的执行通道**。AUD-003 不只是安全问题，它也是架构问题：
   系统里存在一条"不经过权限判定就能执行仓库代码"的路径，而这条路径在每次交付前
   自动触发。

## 10. 结论

架构的骨架是对的，不需要重构。需要的是三件"接上"的工作：

- 把已有的 `transition()` 接上，让状态机说话算数；
- 把验证流水线接进策略引擎，消掉第二条执行通道；
- 把 `gitignorePatterns`、`Retry-After`、`cacheBreakpoint`、`hooks` 这些"设计好了但没接线"
  的地方逐个接上或明确删掉——**留着不接线比删掉更贵**，因为它会让下一个人以为它生效了。
