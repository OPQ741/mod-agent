# mod-agent

一个用 **TypeScript + Node.js** 从零实现的 AI Coding Agent CLI——类 Claude Code 的命令行智能体：理解自然语言编程需求，自主完成「读代码 → 改文件 → 跑测试 → 迭代修复」闭环，并产出人可审查的 diff。

> 项目阶段：**设计阶段**。本文档集描述目标架构与工程约定，尚未开始编码。

## 设计目标

在持久隔离的工作区里接收自然语言需求 / issue，自主完成仓库探索、多文件修改、测试验证与自我修正，最终产出可审查的分支 diff。它是一个**人在环上（human-in-the-loop）**的委托执行系统，而不是完全无人值守的「AI 软件工程师」：人负责需求决策与最终审查，Agent 负责探索、实现、验证与迭代。

核心能力覆盖：多模型统一接入、结构化工具调用、MCP 扩展、Hook 生命周期、上下文压缩、长期记忆与项目级指令注入、运行时 Checkpoint（长任务中断可恢复）、Git Worktree 任务隔离。

## 技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 语言 / 运行时 | TypeScript + Node.js | 流式 API 原生友好 |
| CLI / TUI | **Commander + Ink** | 命令框架 + React 风格终端渲染，流式输出与工具状态展示 |
| 数据校验 | **Zod** | 工具入参、计划、模型结构化输出统一校验 |
| 本地存储 | **SQLite**（better-sqlite3） | 会话、消息、检查点、记忆的本地持久化 |
| LLM 接入 | Model Gateway 统一抽象 | OpenAI / Anthropic / Ark 等可插拔 Provider，透传 prompt cache |
| 协议扩展 | **MCP**（官方 TypeScript SDK） | 外部工具生态 |
| 沙箱 | Docker + 受限子进程（降级） | 命令隔离、网络默认关闭 |
| 代码检索 | ripgrep + tree-sitter / TS Compiler API | 词法 + 符号 + 关系，纯向量 RAG 只是补充 |
| 工作区隔离 | **Git Worktree** | 每任务独立分支与目录，完成后合并清理 |

> 远期方向（MVP 不做）：把单 CLI 扩展为 Web 控制台 + BFF + PostgreSQL + 队列的团队平台（多租户、RBAC、PR/Issue 集成）。相关设计见 `roadmap.md` Phase 5。

## 文档导航

按「为什么 → 是什么 → 怎么做」组织：

| 文档 | 回答的问题 |
| --- | --- |
| [README.md](./README.md) | 项目定位 + 技术栈 + 全文导航 |
| [overview.md](./overview.md) | 目标与边界、设计原则、任务模式、MVP 做 / 不做 |
| [research.md](./research.md) | 领域调研：主流产品、评测基准、架构范式、失败模式与安全实证 |
| [architecture.md](./architecture.md) | 总体分层架构、架构决策记录（ADR）、技术选型、monorepo 结构 |
| [agent-loop.md](./agent-loop.md) | Agent Runtime：任务状态机、核心循环、停止/恢复/预算语义 |
| [context-engineering.md](./context-engineering.md) | 代码库理解、分层检索、上下文装配与压缩、注入防护 |
| [tools-and-extensions.md](./tools-and-extensions.md) | 工具契约、统一执行结果、MCP、Skills、人工审批策略 |
| [code-editing.md](./code-editing.md) | 文件读取与编辑策略、Worktree 隔离、用户变更保护、Diff 审核 |
| [verification-and-multiagent.md](./verification-and-multiagent.md) | 验证流水线、错误分类、Repair Loop、子 Agent 协作 |
| [security.md](./security.md) | 威胁模型、沙箱基线、命令执行层、密钥/网络、安全验收 |
| [data-and-events.md](./data-and-events.md) | EventStream 事件模型、SQLite 持久化、检查点、一致性规则 |
| [model-gateway.md](./model-gateway.md) | Provider 适配、模型路由、提示词版本管理、结构化输出 |
| [observability-evaluation.md](./observability-evaluation.md) | Trace/指标/日志/成本，以及评测体系与发布门禁 |
| [roadmap.md](./roadmap.md) | 分阶段路线（Phase 0–6）、优先开发顺序、MVP 验收清单 |
| [references.md](./references.md) | 参考来源汇总 |

## 核心设计原则（速览）

1. **单 Agent 闭环优先**：一个 ReAct 主循环 + 受控子任务派生，不做对等多 Agent 编排。
2. **接口即能力（ACI）**：工具输入输出契约与模型能力同等重要，输出结构化、无歧义、带裁剪。
3. **验证驱动**：生成廉价、验证昂贵——任何修改必须跑测试 / lint / 类型检查，不信模型自述成功。
4. **上下文是缓存**：按需检索、临近上限压缩、记忆外置，对抗 context rot。
5. **安全默认**：文件写入 / 命令执行 / 网络默认隔离与授权，破坏性操作显式确认。
6. **状态外置可恢复**：任务状态、失败历史、检查点持久化，长任务可从中断点恢复。

详见 [overview.md](./overview.md)。
