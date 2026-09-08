# FEATURE_GAP_ANALYSIS · 功能差距分析

> 判定标准：**只有代码存在且有测试验证**才记 IMPLEMENTED。
> 文档里规划过但代码里没有的，一律记 MISSING —— 这是本次审计最重要的纪律。

状态：**IMPLEMENTED** 已实现且有测试 · **PARTIAL** 部分实现 · **MISSING** 未实现 ·
**DEFECTIVE** 已实现但有缺陷 · **UNVERIFIED** 无法验证

## 1. 十条项目目标的达成度

| #   | 目标                           | 状态          | 已实现的部分                                                                                                                                            | 关键缺口                                                                                                               |
| --- | ------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | 自主理解用户编程需求           | IMPLEMENTED   | 用户请求包裹为不可信输入（`system-prompt.ts:126`）；`ask` 决策走 `decisionHint` 显式信号而非猜问号                                                      | 无                                                                                                                     |
| 2   | 自主分析代码仓库               | PARTIAL       | `repo.list_files` / `read_file` / `search_text` / `git_status` / `read_diff`；ACI 纪律（强制绝对路径、分页、命中过多要求收窄）                          | 无符号索引/AST 理解；`search_text` 全树无上限扫描（AUD-025）                                                           |
| 3   | 自主规划和拆解任务             | **DEFECTIVE** | `plan.enter_plan_mode` / `exit_plan_mode` 工具、`ExecutionPlanSchema`（含依赖校验）、`--mode plan` 在注册层摘除写工具                                   | **进入 plan 模式后写工具仍可用**（AUD-004）；计划不落盘、不驱动执行、不注入上下文（`pendingSteps` 从未赋值）           |
| 4   | 调用工具读/建/改文件           | IMPLEMENTED   | 6 个 repo 工具 + edit/write；read-before-edit、mtime 校验、唯一匹配、引号容错、结构化文件写后校验                                                       | `.env.example` 读不了（AUD-019）；`CODE_LIKE_PATHS` 批了也不给写（AUD-020）                                            |
| 5   | 执行 Shell / Git / 测试 / 构建 | IMPLEMENTED   | `command.run`（结构化 argv）、`test.run`（自动发现）、沙箱无 shell 执行、整组 kill、输出上限；`git_status`/`read_diff`                                  | `move-to-background` 未实现（AUD-015）；`git commit`/`git push` 无专用工具                                             |
| 6   | 根据执行结果自主修复错误       | IMPLEMENTED   | Repair Loop（验证失败 → 诊断回喂 → 重试，`maxRepairRounds` 上限）；进度守卫（重复调用/反复改同一文件/同一错误复发）                                     | 修复轮次计入 `usage.repairRounds` 正确，但 `rounds` 会被重置（AUD-005）                                                |
| 7   | 管理上下文、记忆、会话         | PARTIAL       | 分层压缩（去重/折叠/摘要器钩子）、AGENTS.md 拼接与 `@import`、检查点、`--resume`/`--continue`、SQLite 持久化                                            | 嵌套 AGENTS.md 生产路径不加载（AUD-021）；压缩保护错对象（AUD-022）；无长期记忆/跨会话知识沉淀                         |
| 8   | Skills、MCP、Hooks、Subagents  | **MISSING**   | 仅有的：`ToolRegistry.origin` 支持 `mcp:<server>`、`registerWithLengthCheck` 的 MCP 名字长度校验、`ToolHooks` 接口、`deferred` + `tool_search` 延迟加载 | MCP 客户端、Skills 加载器、Hook 接线（`runtime` 从不传 `hooks`）、Subagent 派生——**全部未实现**                        |
| 9   | 可靠的权限控制与安全机制       | PARTIAL       | 三态判定、bypass-immune、realpath 路径守卫、审批绑参数哈希、无 TTY 拒绝、沙箱 fail-closed、命令拆段                                                     | 验证绕过策略（AUD-003）；Hook 可改入参（AUD-007）；`respectGitignore` 失效（AUD-009）；allow 多路径 `.some`（AUD-011） |
| 10  | 完整执行报告与可审查 Diff      | PARTIAL       | 交付报告落盘（含 changedFiles + 验证状态 + "未跑验证是缺口不是通过"的显式声明）、`file.changed` 事件、`repo.read_diff`                                  | 无统一 diff 产物（`computeDiff` 已导出但循环未调用）；无 `--output-format` 的 diff 段                                  |

**总体达成度**：10 项中 4 项 IMPLEMENTED、5 项 PARTIAL、1 项 DEFECTIVE、1 项 MISSING。
如果只看"能跑一个改代码的闭环"，答案是肯定的；如果对照"对标 Claude Code"，
缺口集中在**扩展体系（第 8 项）**与**规划落地（第 3 项）**。

## 2. 八大审计领域逐项核对

### 2.1 项目工程化

| 检查点                  | 状态        | 证据                                                                                     |
| ----------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| `package.json` 脚本完整 | IMPLEMENTED | 12 个脚本；`verify = typecheck + test`                                                   |
| tsconfig 严格           | IMPLEMENTED | `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`                           |
| ESLint                  | IMPLEMENTED | flat config v10；未启用 `strictTypeChecked`                                              |
| Vitest                  | IMPLEMENTED | 417 用例；`pool: forks`；离线                                                            |
| **CI 跑测试**           | **MISSING** | `ci.yml` 只有 lint + docs-build（AUD-006）                                               |
| CI 跑构建               | MISSING     | 无 `npm run build` job                                                                   |
| 依赖安全                | IMPLEMENTED | CodeQL + dependency-review + scorecard + gitleaks 四个 workflow                          |
| 构建发布流程            | PARTIAL     | release-please + commitlint 齐备，但无 npm publish 流程（`private: true`，符合当前阶段） |

### 2.2 Agent Core

| 检查点       | 状态          | 说明                                                                                                                |
| ------------ | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| Agent Loop   | IMPLEMENTED   | 单一异步生成器，背压真实                                                                                            |
| 状态管理     | PARTIAL       | 14 态转换表存在，但 4 处直接赋值绕过（见 ARCHITECTURE_REVIEW §3）                                                   |
| Tool Calling | **DEFECTIVE** | 并行工具调用只取第一个（AUD-001）                                                                                   |
| 多轮执行     | IMPLEMENTED   | tool_result 回灌、配对维护、`turns` 计数                                                                            |
| 停止条件     | IMPLEMENTED   | 步数/成本/墙钟/输入 token/无进展 五维；`repairRounds` 刻意不硬刹车（有注释说明理由）                                |
| 最大迭代次数 | IMPLEMENTED   | `maxRounds` 默认 30，但可被 resume 绕过（AUD-005）                                                                  |
| 异常恢复     | PARTIAL       | 工具错误即数据 ✅；模型错误 → 终止 ✅；**策略拒绝上限异常穿透**（AUD-002）                                          |
| 流式响应     | IMPLEMENTED   | SSE 流式已落地；`agent.message_delta` 按阈值合并后进事件流，`tool.progress` 每 200ms 合并长命令输出，断流可恢复一次 |
| 用户取消     | PARTIAL       | `AbortSignal` 贯穿到子进程 ✅；`cancelRequestedAt` 下一轮入口生效 ✅；并发取消撞锁（AUD-008）                       |

### 2.3 LLM Provider

| 检查点                 | 状态          | 说明                                                                                  |
| ---------------------- | ------------- | ------------------------------------------------------------------------------------- |
| Provider 抽象          | IMPLEMENTED   | `ModelProvider` + `capabilities`；业务层只见统一契约                                  |
| Anthropic 接入         | IMPLEMENTED   | `system` 独立参数、`input_schema`、`tool_result` 配对、`stop_reason`、缓存 token 统计 |
| OpenAI 接入            | IMPLEMENTED   | 同一 `OpenAICompatProvider` 覆盖 OpenAI/DeepSeek/通义/vLLM/Ollama                     |
| OpenAI-compatible 接入 | IMPLEMENTED   | 同上；`baseUrl` 可配                                                                  |
| 流式响应               | IMPLEMENTED   | SSE + `generateStream`；与非流式结果逐字段相等（复用同一段响应解析）                  |
| Tool Calling 兼容性    | IMPLEMENTED   | 分片累积（`accumulateCallFragments`）、参数 JSON 失败转数据、两家消息形状差异有测试   |
| 超时                   | IMPLEMENTED   | 网关级 + 外部 signal 联动                                                             |
| 重试                   | PARTIAL       | 指数退避 + 抖动 + 可重试码分类 ✅；`Retry-After` 未使用（AUD-014）                    |
| Token 统计             | IMPLEMENTED   | input/output/cache read/cache creation 分别累计                                       |
| 成本统计               | **DEFECTIVE** | 所有模型共用一张 Sonnet 档价目表（AUD-013）                                           |

### 2.4 Tool System

| 检查点           | 状态        | 说明                                                                         |
| ---------------- | ----------- | ---------------------------------------------------------------------------- |
| 工具注册机制     | IMPLEMENTED | 重名抛错、注册时校验 schema 可转 JSON Schema                                 |
| JSON Schema      | IMPLEMENTED | 自写 Zod→JSONSchema 转换器，不支持的类型显式失败而非静默产出错 schema        |
| 工具参数验证     | IMPLEMENTED | 两阶段：Zod → 业务 `validate`                                                |
| 文件读取         | IMPLEMENTED | 分页 + 行号 + 二进制检测 + 256KB 硬顶 + `allowLarge`                         |
| 文件写入         | IMPLEMENTED | 新建/整写；已有文件强制 read-before-edit                                     |
| 文件编辑         | IMPLEMENTED | search-and-replace，唯一匹配底线                                             |
| 文件搜索         | IMPLEMENTED | 字面/正则；默认只给文件+计数；命中过多要求收窄                               |
| Shell            | IMPLEMENTED | 结构化 argv、无 shell、进程组 kill                                           |
| Git              | PARTIAL     | 只读（status / diff）；无 commit/branch/stash 工具                           |
| 工具执行结果格式 | IMPLEMENTED | 统一 `ToolExecutionResult`；失败带 code/retryable；大结果落盘后给 URI + 预览 |
| 工具并行执行     | **MISSING** | `isConcurrencySafe` 已声明但执行器串行、且丢弃并行调用（AUD-001）            |

### 2.5 Context Engine

| 检查点         | 状态        | 说明                                                                                       |
| -------------- | ----------- | ------------------------------------------------------------------------------------------ |
| System Prompt  | IMPLEMENTED | 动静分离、确定性渲染、工具自述内聚                                                         |
| AGENTS.md 加载 | PARTIAL     | 根目录 + `@import` 展开（深度 4、循环检测、不可见字符剥离）；**嵌套目录不加载**（AUD-021） |
| 历史消息管理   | IMPLEMENTED | 水位线增量落库；配对不拆开                                                                 |
| Token 预算     | PARTIAL     | `estimateTokens` CJK 感知 ✅；但循环内不做发送前预算裁剪，超窗口依赖压缩                   |
| 上下文压缩     | PARTIAL     | 四层流水线；保护错对象（AUD-022）；压缩结果不落库                                          |
| 项目上下文收集 | PARTIAL     | 动态块有 cwd/平台/模式/轮次/日期；`gitBranch`/`gitDirty`/`pendingSteps` 字段从未赋值       |
| 会话恢复       | IMPLEMENTED | 检查点 + 未闭合工具调用判据 + 规则只注入一次                                               |

### 2.6 Security

详见 `SECURITY_AUDIT.md`。摘要：

| 检查点           | 状态                                                                             |
| ---------------- | -------------------------------------------------------------------------------- |
| 路径穿越         | IMPLEMENTED（realpath + 父目录校验 + 有测试）                                    |
| 符号链接逃逸     | IMPLEMENTED（写路径显式拦 `symlinkEscape`）                                      |
| Shell 注入       | IMPLEMENTED（`shell: false`，从根上消除）                                        |
| 权限控制         | PARTIAL（判定序正确，但存在绕过通道）                                            |
| 敏感信息泄露     | IMPLEMENTED（日志递归脱敏、命令输出脱敏、env 白名单、凭证不走 argv）             |
| Prompt Injection | PARTIAL（不可信包裹 + 规则不得覆盖策略；但仓库内容仍是可信执行路径，见 AUD-003） |
| 子进程安全       | IMPLEMENTED（进程组 kill、输出上限、敏感 env 拒绝透传）                          |
| MCP 信任边界     | **MISSING**（无 MCP 实现，边界无从谈起）                                         |

### 2.7 Extension System

| 检查点     | 状态    | 说明                                                                                                   |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------ |
| Skills     | MISSING | 无加载器、无 `SKILL.md` 解析、无目录约定                                                               |
| MCP        | MISSING | 仅规则名约定 `mcp__server__tool` 与错误码                                                              |
| Hooks      | MISSING | `ToolExecutor` 支持 `preToolUse`/`postToolUse`，但 `runtime` 从不构造 `hooks`；且顺序有缺陷（AUD-007） |
| Plugins    | MISSING | 无                                                                                                     |
| Subagents  | MISSING | `AssembleOptions.allowTools/disallowTools` 注释提到"子代理的四层过滤"，但无派生实现                    |
| 自定义工具 | PARTIAL | `ToolRegistry.register()` 是公开 API，SDK 调用方可注册；无配置文件声明式注册                           |

**这一整块是当前最大的能力空白。** 好消息是地基已经具备：`AgentTool` 契约、注册表三层装配、
`origin` 来源标记、`deferred` + `tool_search` 延迟加载，这些正是接 MCP 与 Skills 所需要的形状。

### 2.8 Testing

详见 `TEST_COVERAGE_REPORT.md`。摘要：

| 检查点        | 状态                                                                          |
| ------------- | ----------------------------------------------------------------------------- |
| 单元测试      | IMPLEMENTED（12 文件 417 用例）                                               |
| 集成测试      | IMPLEMENTED（CLI 端到端、SDK 端到端、真实文件系统、真实子进程）               |
| E2E           | PARTIAL（有 `--script` 离线回放端到端；无真实模型 E2E）                       |
| 测试覆盖率    | **UNVERIFIED**（无覆盖率工具，V8 采集对 Vite 模块无效）                       |
| Mock Provider | IMPLEMENTED（`ScriptedProvider`，脚本耗尽抛错不兜底——设计正确）               |
| Benchmark     | MISSING                                                                       |
| 安全测试      | PARTIAL（策略/路径/命令拆分有大量用例；无对抗性注入测试、无 bypass 模糊测试） |

## 3. 差距排序（按"离可用闭环还差多少"）

1. **扩展体系（Skills/MCP/Hooks/Subagents）**：0 → 1 的阶段，工作量最大，但地基已备。
2. **规划落地**：工具存在、数据模型存在，缺"计划落盘 + 驱动执行 + 注入上下文"这条链。
3. **流式响应**：已实现（SSE + `agent.message_delta`），长命令增量输出（`tool.progress`）与断流恢复也已在第五批补齐。剩下的边界是 OpenAI 兼容端点在"上游不发 `finish_reason`"时没有可恢复的工具块，以及计价仍按定价表估算（AUD-013）。
4. **并行工具调用**：不是"优化"，是正确性问题——多文件任务会静默少做一半。
5. **验证链路的策略接入**：安全前提，改动量很小（一处调用点）。
