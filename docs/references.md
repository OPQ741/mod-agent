# References · 参考来源

> 供设计核验与后续深入学习。官方 SDK / API、MCP 规范与云平台策略持续演进，正式实现前应再核对所选版本，并用锁文件与契约测试锁定行为。核对日期：**2026-10-14 全量复核**（主体初核于 2026-08，[§0](#_0-2026-08-补充核验来源) 是主体定稿后同月内追加的一批来源）。

> 怎么用这份清单：它不是拿来逐篇读完的书单，而是出问题时的字典。设计某一层拿不准时，按分类翻对应的官方文档；决定引入某个开源项目前，先看它后面括号里的许可证与停服 / 归档状态，代码能看不等于能放心商用。链接逐条核验：[§1](#_1-agent-运行时与范式)–[§5](#_5-安全与沙箱) 于 2026-08、[§6](#_6-评测)–[§11](#_11-云端-自治-coding-agent) 于 2026-08 逐个打开核对；正式实现前请按上面提示再核对一次版本。

## 0. 2026-08 补充核验来源

这一节是 2026-08 主体定稿后、同月内新开的一批来源，其中有几条推翻或更新了主体定稿时的认识，按主题列出。若与前面章节的说法冲突，以本节为准。

**基准与能力（更新了旧的分数口径）**

- **SWE-bench 官方榜**（统一 mini-SWE-agent harness，可横向比较）
  https://www.swebench.com
- **SWE-bench Verified 榜单核查**（指出 82 行中 76 行为厂商自报、顶部饱和）
  https://benchlm.ai/benchmarks/mercorsweverified
- **Terminal-Bench 2.0 官方榜**（注意：当前版本已是 4.0，2.x 分数不可直接比较）
  https://www.tbench.ai/leaderboard/terminal-bench/2.0
- **Terminal-Bench 2.0 深度解读**（脚手架效应、Easy/Hard 难度断层）
  https://explainx.ai/blog/terminal-bench-2-0-ai-agent-benchmark-evaluation
- **Agent 成本基准（2026）**（单任务成本、路由节省幅度）
  https://relayplane.com/benchmarks/agent-costs
- **AI Agent Cost Per Task 2026**（Aider Polyglot 成本、Claude Code 企业用量）
  https://www.kunalganglani.com/blog/ai-agent-cost-per-task-2026

**MCP 规范改版（自 2025-11-25 以来最大一次）**

- **MCP 2026-07-28 发布公告**（无状态内核、MRTR、头部路由、扩展框架、废弃策略）
  https://blog.modelcontextprotocol.io/posts/2026-07-28/
- **MCP 捐给 Agentic AI Foundation**（2025-12-09，Linux 基金会旗下）
  https://blog.modelcontextprotocol.io/posts/2025-12-09-mcp-joins-agentic-ai-foundation
- **MCP 2026-07-28 变更解读**（错误码 -32002 → -32602、inputSchema 支持 2020-12 等破坏性变更）
  https://witho2.com/news/mcp-2026-spec-is-live-what-the-stateless-rewrite-means-for-ai-tools

**开放规范**

- **AGENTS.md 官方站**（已由 Agentic AI Foundation 托管；6 万+ 仓库；就近优先；OpenAI 主仓 88 份）
  https://agents.md
- **AGENTS.md 通俗指南**（与 README / CLAUDE.md / .cursorrules / llms.txt 的分别）
  https://agent-ready.dev/what-is-agents-md
- **Agent Skills 规范官方站**（SKILL.md 格式、渐进披露三段、客户端清单）
  https://skill.md
- **Agent Skills 规范详解**（六个 frontmatter 字段的约束、规范到底定义了什么 / 没定义什么）
  https://www.skillsboard.sh/agent-skills

**安全（2026 年最重要的实证）**

- **Pillar Security：Week of Sandbox Escapes**（Cursor / Codex / Gemini CLI / Antigravity 四款，7 个发现，四种失败模式）
  https://www.pillar.security/blog/the-week-of-sandbox-escapes
- **相关报道汇总**（CVE-2026-48124、Codex v0.95.0 修复、Google 降级的争议）
  https://www.bleepingcomputer.com/news/security/cursor-codex-gemini-cli-antigravity-hit-by-sandbox-escapes/
- **Cymulate：Configuration-Based Sandbox Escape**（更早的同模式命名，2026-04）
  https://cymulate.com/blog/the-race-to-ship-ai-tools-left-security-behind-part-1-sandbox-escape/
- **Adversa AI 2026-08 汇总**（零点击注入覆写沙箱辅助二进制）
  https://aigovernance.com/news/zero-click-prompt-injection-escapes-coding-agent-sandbox-binary-overwritten

**多 Agent（立场反转）**

- **Don't Build Multi-Agents**（Cognition / Walden Yan，2025-06 原立场）
  https://cognition-labs.com/blog/dont-build-multi-agents
- **十个月后的反转与其解读**（写入单线程、审查 agent 平均抓 2 bug/PR、58% 严重、不共享上下文反而更好）
  https://aijourn.com/your-agents-are-failing-at-the-parts-of-the-job-nobody-wrote-down

**Claude Code 机制细节**

- **Best practices for Claude Code**（上下文窗口是最需管理的资源；给 agent 一个它能跑的检查）
  https://www.anthropic.com/engineering/claude-code-best-practices
- **Steering Claude Code: skills, hooks, rules, subagents**（CLAUDE.md <200 行、路径作用域规则、子 agent 默认在主对话下 3 层，可经 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 配置）
  https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more
- **Agent SDK：How the agent loop works**（自动压缩、compact_boundary、MCP 工具 schema 延迟加载）
  https://docs.anthropic.com/en/docs/agent-sdk/agent-loop
- **Agent SDK：Hooks**（事件清单、permissionDecision、退出码语义）
  https://platform.claude.com/docs/en/agent-sdk/hooks

**上下文管理**

- **Managing context on the Claude Developer Platform**（context editing +29%、加 memory tool +39%、100 轮评测省 84% token）
  https://anthropic.com/news/context-management
- **Context Engineering: Compaction, Memory, Drift**（锚定式摘要、write-before-compact、压缩策略风险排序）
  https://www.tmls.nyc/research/context-engineering
- **The Context Engineering Playbook**（Write / Select / Compress / Isolate 四分类）
  https://dreaming.press/posts/context-engineering-playbook-write-select-compress-isolate.html

**ACI 与编辑**

- **SWE-agent: Agent Computer Interface**（四条设计准则、100 行查看器、只列文件名的搜索、空输出固定串）
  https://swe-agent.com/latest/background/aci/
- **SWE-agent 论文**（arXiv:2405.15793，ACI 消融 +10.7 个百分点）
  https://arxiv.org/abs/2405.15793

**Git worktree 与并行**

- **Git worktrees: branches without the context switch**（Claude Code `--worktree`、Codex app、并行的适用与不适用）
  https://tylercrosse.com/ideas/2026/git-worktrees
- **Best Git Worktree Tools for AI Coding 2026**（worktree 不解决语义冲突、共享运行时比共享文件更致命、一分支一 worktree）
  https://nimbalyst.com/blog/best-git-worktree-tools-ai-coding-2026/

## 1. Agent 运行时与范式

- **Building Effective Agents** — Anthropic：workflow 模式（chaining/routing/parallelization/orchestrator-workers/evaluator-optimizer）
  https://www.anthropic.com/engineering/building-effective-agents
- **Effective Context Engineering for AI Agents** — Anthropic：上下文工程五手段、四层记忆、context rot
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- **Building Agents with the Claude Agent SDK** — gather→act→verify 循环
  https://docs.anthropic.com/en/docs/build-with-claude-agent-sdk
- **SWE-agent（NeurIPS 2024）**：ACI 概念
  https://arxiv.org/abs/2405.15793
- **OpenHands（ICLR 2025）**：EventStream 事件溯源、Docker runtime
  https://arxiv.org/abs/2407.16741
- **Reflexion**：自然语言自反思
  https://arxiv.org/abs/2303.11366
- **Agentless**：固定三阶段流水线 baseline
  https://arxiv.org/abs/2407.01489

## 2. 模型与网关

- **OpenAI Agents 文档：运行时方案比较**
  https://developers.openai.com/api/docs/guides/agents
- **OpenAI Agents SDK（TS 参考实现）**
  https://developers.openai.com/api/docs/guides/agents/sdk
- **LangGraph Persistence**（checkpoint / 恢复 / 人类审批对比参考，不意味着必须采用）
  https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/persistence.mdx

## 3. MCP 扩展

- **MCP Tools 规范**
  https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- **MCP TypeScript SDK**
  https://ts.sdk.modelcontextprotocol.io/
- **MCP Security Best Practices**
  https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices

## 4. 代码检索与解析

- **Tree-sitter**（增量语法、多语言、错误恢复）
  https://github.com/tree-sitter/tree-sitter/blob/master/docs/src/index.md
- **TypeScript Compiler API 指南**（Program / SourceFile / TypeChecker）
  https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API
- **Aider Repo Map**（tree-sitter 符号索引）
  https://aider.chat/docs/git.html

## 5. 安全与沙箱

- **OWASP Top 10 for LLM Applications 2025**
  https://genai.owasp.org/resource/owasp-top-10-for-llm-applications-2025/
- **Microsoft：Securing CI/CD in an agentic world**（Agents Rule of Two、Read 工具密钥泄漏教训）
  https://www.microsoft.com/en-us/security/blog/2026/06/05/securing-ci-cd-in-agentic-world-claude-code-github-action-case/
- **Docker 安全：Rootless 与 seccomp**
  https://docs.docker.com/engine/security/rootless/
  https://docs.docker.com/engine/security/seccomp/
- **GitHub Copilot 沙箱与安全设置**
  https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings

## 6. 评测

- **SWE-bench 项目**
  https://github.com/SWE-bench/SWE-bench
- **Playwright 测试断言**（异步 UI、自动重试）
  https://playwright.dev/docs/test-assertions

## 7. 观测

- **OpenTelemetry Semantic Conventions**
  https://opentelemetry.io/docs/specs/semconv/

## 8. 主流产品官方文档

- Claude Code：permissions / sub-agents / skills & hooks
  https://code.claude.com/docs/en/permissions
- Cursor：Agent mode、codebase indexing、plan 模式
  https://cursor.com/help/ai-features/agent
- Devin / Cognition
  https://cognition.com/blog/introducing-devin

---

以下五个分类为 [Coding Agent 全景图鉴](./coding-agents.md) 的链接清单，2026-10-14 逐个打开核对（GitHub 仓库页 + 官方文档），主体初核于 2026-08-13。图鉴正文只给规模档位不给精确 star 数；仓库 slug 若发生迁移，GitHub 旧地址会自动跳转。

## 9. 终端 / CLI Coding Agent

| 项目                   | GitHub（已核实）                                                                                             | 官方文档                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Claude Code            | https://github.com/anthropics/claude-code （自定义源码许可，非 OSI）                                         | https://code.claude.com/docs/en/overview                                              |
| OpenAI Codex CLI       | https://github.com/openai/codex （Apache-2.0）                                                               | https://developers.openai.com/codex                                                   |
| Gemini CLI             | https://github.com/google-gemini/gemini-cli （Apache-2.0）                                                   | https://google-gemini.github.io/gemini-cli/                                           |
| Aider                  | https://github.com/Aider-AI/aider （Apache-2.0）                                                             | https://aider.chat/                                                                   |
| OpenCode               | https://github.com/anomalyco/opencode （MIT；原 sst/opencode 自动跳转）                                      | https://opencode.ai/docs/                                                             |
| Goose                  | https://github.com/aaif-goose/goose （Apache-2.0；原 block/goose 跳转，现归 Linux 基金会 AAIF）              | https://goose-docs.ai/（旧地址 https://block.github.io/goose/ 现仅做跳转）            |
| Crush                  | https://github.com/charmbracelet/crush （FSL-1.1-MIT）                                                       | https://charm.sh/                                                                     |
| Qwen Code              | https://github.com/QwenLM/qwen-code （Apache-2.0）                                                           | https://qwenlm.github.io/qwen-code-docs/                                              |
| Amazon Q Developer CLI | https://github.com/aws/amazon-q-developer-cli （Apache-2.0；README 声明仅收安全补丁，转向闭源 Kiro CLI）     | https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line-installing.html |
| Continue（CLI `cn`）   | https://github.com/continuedev/continue （Apache-2.0；只读停更，最终 2.0.0，团队 2026-06-16 被 Cursor 收编） | https://docs.continue.dev/cli/quickstart                                              |
| Pi                     | https://github.com/earendil-works/pi （MIT）                                                                 | 未核实到独立文档站，以仓库 README 为准                                                |
| Grok Build             | https://github.com/xai-org/grok-build （Apache-2.0）                                                         | 未核实到独立文档站，以仓库 README 为准                                                |
| Plandex                | https://github.com/plandex-ai/plandex （MIT）                                                                | https://plandex.ai                                                                    |
| Kimi Code              | https://github.com/MoonshotAI/kimi-code （MIT；旧版 MoonshotAI/kimi-cli 已 2026-09-22 归档）                 | 未核实到独立文档站，以仓库 README 为准                                                |
| MiniMax Code           | https://github.com/MiniMax-AI/minimax-code （MIT）                                                           | 未核实到独立文档站，以仓库 README 为准                                                |
| gptme                  | https://github.com/gptme/gptme （MIT）                                                                       | https://gptme.org                                                                     |
| ForgeCode              | https://github.com/tailcallhq/forgecode （Apache-2.0；原 antinomyhq/forge 迁移）                             | 未核实到独立文档站，以仓库 README 为准                                                |

## 10. IDE 内 Coding Agent

| 项目                      | GitHub（已核实）                                                                           | 官方文档                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Cursor                    | 无公开仓库（闭源，Anysphere）                                                              | https://cursor.com/docs/agent ｜ 规则 https://cursor.com/docs/rules ｜ 云端 https://cursor.com/docs/cloud-agent                  |
| Windsurf                  | 无编辑器公开仓库（2025-07 被 Cognition 收购，2026-06-02 改名 Devin Desktop）               | https://docs.windsurf.com/windsurf/cascade/cascade ｜ 收购公告 https://windsurf.com/blog/windsurfs-next-chapter                  |
| GitHub Copilot agent mode | 无独立仓库                                                                                 | https://docs.github.com/en/copilot/how-tos/chat-with-copilot/chat-in-ide                                                         |
| Cline                     | https://github.com/cline/cline （Apache-2.0）                                              | https://cline.bot                                                                                                                |
| Roo Code                  | https://github.com/RooCodeInc/Roo-Code （Apache-2.0；**2026-05-15 停服、Public archive**） | https://roocode.com                                                                                                              |
| Kilo Code                 | https://github.com/Kilo-Org/kilocode （MIT）                                               | https://kilo.ai                                                                                                                  |
| Zed                       | https://github.com/zed-industries/zed （GPL-3.0）                                          | https://zed.dev/docs/ai/agent-panel ｜ 并行 https://zed.dev/docs/ai/parallel-agents ｜ 外部 agent https://zed.dev/docs/ai/agents |
| Trae（字节）              | IDE 闭源；仅研究型 CLI 开源 https://github.com/bytedance/trae-agent （MIT）                | https://docs.trae.ai/ide/what-is-trae                                                                                            |
| Void                      | https://github.com/voideditor/void （Apache-2.0；**已弃用归档**）                          | https://voideditor.com                                                                                                           |
| Google Antigravity        | 无公开仓库（闭源，含 `agy` CLI 与 SDK）                                                    | https://antigravity.google                                                                                                       |
| Kiro（AWS）               | 无公开仓库（前身 amazon-q-developer-cli 曾 Apache-2.0，转 Kiro 后改 AWS IP License）       | https://kiro.dev                                                                                                                 |
| JetBrains Junie           | 无公开仓库（闭源；Fleet 已于 2025-12-22 关停，转 JetBrains Air）                           | https://www.jetbrains.com/                                                                                                       |

## 11. 云端 / 自治 Coding Agent

| 项目                       | GitHub（已核实）                                                                            | 官方文档                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Devin (Cognition)          | 无官方开源仓库                                                                              | https://docs.devin.ai/get-started/devin-intro                                                       |
| GitHub Copilot cloud agent | 无开源仓库                                                                                  | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github |
| Replit Agent               | 无开源仓库                                                                                  | https://docs.replit.com/features/agent/overview                                                     |
| bolt.diy（开源版）         | https://github.com/stackblitz-labs/bolt.diy （MIT；WebContainer 商用需另授权）              | https://stackblitz-labs.github.io/bolt.diy/ ｜ 托管产品 https://bolt.new                            |
| v0 (Vercel)                | 无开源仓库                                                                                  | https://v0.dev/faq                                                                                  |
| Lovable                    | 无开源仓库                                                                                  | https://docs.lovable.dev                                                                            |
| Factory / Droid            | 核心闭源；开源 TS SDK https://github.com/Factory-AI/droid-sdk-typescript （license 未核实） | https://docs.factory.com/                                                                           |
| Jules (Google)             | 无开源仓库                                                                                  | https://labs.google/jules                                                                           |

## 12. 开源平台、框架与学术项目

| 项目              | GitHub（已核实）                                                                                                                                          | 官方文档 / 论文                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| SWE-agent         | https://github.com/SWE-agent/SWE-agent （MIT；官方重心转向 mini-SWE-agent）                                                                               | https://swe-agent.com/latest/background/ ｜ https://arxiv.org/abs/2405.15793  |
| OpenHands         | https://github.com/OpenHands/OpenHands （MIT；原 All-Hands-AI 跳转）                                                                                      | https://docs.openhands.dev/ ｜ https://arxiv.org/abs/2407.16741               |
| Agentless         | https://github.com/OpenAutoCoder/Agentless （MIT）                                                                                                        | https://arxiv.org/abs/2407.01489                                              |
| Moatless Tools    | https://github.com/aorwall/moatless-tools （MIT；论文实现见 moatless-tree-search）                                                                        | https://github.com/aorwall/moatless-tree-search                               |
| AutoCodeRover     | https://github.com/AutoCodeRoverSG/auto-code-rover （**Sonar Source-Available License v1.0，非商业**）                                                    | https://arxiv.org/abs/2404.05427                                              |
| MetaGPT           | https://github.com/FoundationAgents/MetaGPT （MIT；原 geekan 跳转）                                                                                       | https://openreview.net/forum?id=VtmBAGCN7o                                    |
| AutoGen           | https://github.com/microsoft/autogen （MIT；**已进入维护模式**，后继 Microsoft Agent Framework）                                                          | https://microsoft.github.io/autogen/                                          |
| CrewAI            | https://github.com/crewAIInc/crewAI （MIT）                                                                                                               | https://docs.crewai.com/                                                      |
| LangGraph         | https://github.com/langchain-ai/langgraph （MIT）                                                                                                         | https://docs.langchain.com/oss/python/langgraph/                              |
| OpenAI Agents SDK | https://github.com/openai/openai-agents-python （MIT；JS 版 openai/openai-agents-js）                                                                     | https://openai.github.io/openai-agents-python/                                |
| Google ADK        | https://github.com/google/adk-python （Apache-2.0）                                                                                                       | https://google.github.io/adk-docs/                                            |
| Pydantic AI       | https://github.com/pydantic/pydantic-ai （MIT）                                                                                                           | https://ai.pydantic.dev/                                                      |
| Mastra            | https://github.com/mastra-ai/mastra （**双许可**：核心 Apache-2.0 + ee/ 企业许可）                                                                        | https://mastra.ai                                                             |
| gpt-engineer      | https://github.com/AntonOsika/gpt-engineer （MIT；**已 archived**）                                                                                       | https://github.com/AntonOsika/gpt-engineer                                    |
| smol developer    | https://github.com/smol-ai/developer （MIT）                                                                                                              | https://github.com/smol-ai/developer                                          |
| mini-SWE-agent    | https://github.com/SWE-agent/mini-swe-agent （MIT；SWE-agent 官方当前重心）                                                                               | https://github.com/SWE-agent/mini-swe-agent                                   |
| OpenHands SDK     | https://github.com/OpenHands/software-agent-sdk （MIT；agent 核心已从主仓库重构至此，另有 typescript-client）                                             | https://docs.openhands.dev/                                                   |
| deepagents        | https://github.com/langchain-ai/deepagents （MIT；JS 移植 langchain-ai/deepagentsjs）                                                                     | https://docs.langchain.com/oss/python/deepagents/overview                     |
| smolagents        | https://github.com/huggingface/smolagents （Apache-2.0）                                                                                                  | https://huggingface.co/docs/smolagents                                        |
| Claude Agent SDK  | https://github.com/anthropics/claude-agent-sdk-typescript ｜ claude-agent-sdk-python （**非开源**，Anthropic 商业条款；内部 runs the Claude Code binary） | https://code.claude.com/docs/en/agent-sdk/overview                            |
| OpenAI Codex SDK  | https://github.com/openai/codex 内（`@openai/codex-sdk`，Apache-2.0，2026-07 转稳定版）                                                                   | SDK spawn CLI 进程读 JSONL 事件流；文档见 https://developers.openai.com/codex |
| Terminal-Bench    | https://github.com/laude-institute/harbor （框架，含参照 agent Terminus 2；原 terminal-bench 仓库重定向）                                                 | https://www.tbench.ai/leaderboard/terminal-bench/2.0                          |

## 13. 开放协议与规范

| 协议                         | 仓库 / 官网（已核实）                                                                                                                 | 备注                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP (Model Context Protocol) | https://github.com/modelcontextprotocol/modelcontextprotocol （MIT；原 specification 跳转）｜ https://modelcontextprotocol.io         | agent ↔ 工具/数据，tools/resources/prompts 三原语                                                                                                                                    |
| A2A (Agent2Agent)            | https://github.com/a2aproject/A2A （Apache-2.0）｜ https://a2a-protocol.org                                                           | agent ↔ agent，Google 发起、Linux 基金会托管                                                                                                                                         |
| ACP (Agent Client Protocol)  | https://github.com/agentclientprotocol/agent-client-protocol （Apache-2.0；原 zed-industries 名下）｜ https://agentclientprotocol.com | 编辑器 ↔ 外部 CLI agent，Zed 发起；`session/prompt`、`session/update`、`session/request_permission` 原语，客户端覆盖 Zed / VS Code / JetBrains / Neovim / Emacs 等                   |
| AGENTS.md                    | https://agents.md ｜ 仓库 https://github.com/agentsmd/agents.md （MIT）                                                               | 给 agent 看的项目 README，Linux 基金会 AAIF 托管。**加载顺序与就近覆盖条款以站点正文为准，仓库 README 只有最小示例**；本仓库 `AGENTS.md` §8 引用的 `openai/agents.md` 是迁移前旧归属 |
| OTel GenAI 语义约定          | https://github.com/open-telemetry/semantic-conventions-genai （Apache-2.0）                                                           | agent / 工具调用的可观测性命名标准：`invoke_agent`、`execute_tool` span、`gen_ai.usage.*`，并含 MCP 约定                                                                             |
| Spec Kit                     | https://github.com/github/spec-kit （MIT）                                                                                            | GitHub 官方的规约驱动开发工具包，适配多家 agent，与 Kiro 的 spec 机制同源                                                                                                            |
| execpolicy                   | https://github.com/openai/codex 内 `codex-rs/execpolicy` （Rust，Apache-2.0）                                                         | Starlark 风格 `prefix_rule` 的 allow / prompt / forbidden 命令策略，fail-closed，规则自带 match / not_match 测试                                                                     |

## 14. 维护说明

- 每个依赖 / 对标项目记录四件事：**许可证、最近提交、归档状态、替代方案**；"源码可见"不等于 OSI 开源（Claude Code 自定义许可、Crush FSL、AutoCodeRover Sonar、Mastra 双许可、Zed GPL-3.0 均需单独合规判断）。
- 本清单与 [coding-agents.md](./coding-agents.md) 的画像一一对应；发现链接失效或项目停服 / 迁移时，以官方仓库为准并同步更新两处。
- 本文档随设计推进持续更新：新选型、新 ADR、新踩坑记录都会回链到这里。

## 15. 机制精读来源（2026-08-13 逐页 fetch 核实）

供各专题设计文档（agent-loop / context-engineering / tools-and-extensions / security / code-editing / verification-and-multiagent / data-and-events / model-gateway / observability-evaluation / architecture / roadmap / overview）引用的机制级原文页面：

**Claude Code（Anthropic）**

- https://code.claude.com/docs/en/skills — Skill 目录 + SKILL.md frontmatter、按需加载、≤500 行分包
- https://code.claude.com/docs/en/memory — CLAUDE.md 分层拼接 + AGENTS.md 回退；MEMORY.md 索引 200 行 / 25KB
- https://code.claude.com/docs/en/hooks — 三类节奏钩子、exit 2 阻断、additionalContext / updatedToolOutput
- https://code.claude.com/docs/en/headless — text / json / stream-json 三档输出、total_cost_usd、`--bare`
- https://code.claude.com/docs/en/settings — 配置五层优先级、allow 并集 + deny/ask 优先

**Aider**

- https://aider.chat/docs/repomap.html — tree-sitter 符号 + 图排序 + ~1k token repo map
- https://aider.chat/docs/git.html — 改动即 commit、脏文件先提交、weak-model 写 message

**Gemini CLI（Google）**

- https://google-gemini.github.io/gemini-cli/docs/cli/headless.html — headless JSON schema（models.tokens / tools 决策 / files 增删行）、`--approval-mode` / `--yolo`

**Cline**

- https://docs.cline.bot/core-workflows/checkpoints — Shadow Git 每工具调用快照、三态恢复
- https://docs.cline.bot/core-workflows/plan-and-act — Plan 只读靠不注册写工具、规划/执行分模型

**Kilo Code**

- https://kilo.ai/docs/features/auto-approving-actions — 权限风险分级表、命令前缀白/黑名单、YOLO + AI 守门员、写后诊断延迟
- https://kilo.ai/docs/code-with-ai/platforms/cloud-agent — 云端每轮自动 commit/push、worktree、单消息 15 分钟上限

**Cursor**

- https://cursor.com/docs/rules — 规则 frontmatter 激活矩阵、嵌套 AGENTS.md 就近优先

**Windsurf**

- https://docs.windsurf.com/windsurf/cascade/cascade — 命名 checkpoint + 不可逆警示、后台规划 agent

**Zed**

- https://zed.dev/docs/ai/tools — `spawn_agent` 独立上下文、工具权限三态（allow/deny/confirm）、Profile 与权限两层
- https://zed.dev/docs/ai/parallel-agents — 每线程独立上下文、detached-HEAD worktree 并发隔离

**Devin（Cognition）**

- https://docs.devin.ai/cli/reference/configuration/config-file — fail-closed 沙箱、域名级网络过滤、allow/deny/ask 三集合、read_config_from 兼容读取
- https://docs.devin.ai/get-started/devin-intro — 三件套工作台、Slack 派活、可接管

**GitHub Copilot cloud agent**

- https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github — draft PR + 发起者不可自批、Actions 默认不自动跑、custom agents / Automations

**v0（Vercel）**

- https://v0.dev/faq — 自动分支 `v0/main-xxx`、自动 commit、永不直接推 main、Vercel Sandbox 预览

**Factory / Droid**

- https://docs.factory.ai/droid-cli/cli-reference.md — 自治等级表（默认只读 → unsafe）、`--use-spec`、`--mission`、`--worktree`

**AGENTS.md 规范**

- https://agents.md — 开放格式、就近覆盖、无必填字段、约定即执行、Linux 基金会 AAIF 托管

**SWE-agent（Princeton）**

- https://swe-agent.com/latest/background/aci/ — ACI 与 prompt engineering 同构、输出裁剪（100 行 / 文件名列表）、编辑前 linter

**OpenAI Agents SDK**

- https://openai.github.io/openai-agents-python/ — 原语（Agent / Handoff / Guardrail / Session / Tracing）、provider-agnostic、SandboxAgent
- https://openai.github.io/openai-agents-python/guardrails/ — 输入 / 输出 / 工具三层护栏、并行 vs 阻塞、tripwire
- https://openai.github.io/openai-agents-python/sessions/ — run 前后自动存取历史、中断恢复、多存储后端、压缩

**MCP 规范**

- https://modelcontextprotocol.io/specification/ — Host / Client / Server 三层、Tools / Resources / Prompts 三原语、Elicitation、工具安全
- https://modelcontextprotocol.io/introduction — 协议定位与类比 LSP

**A2A 规范**

- https://a2a-protocol.org/latest/ — MCP vs A2A 边界、Opacity、不是框架 / 不是子代理协议

**OpenHands**

- https://github.com/OpenHands/software-agent-sdk — Conversation 对象化、events 一等公民、本地 vs 临时容器工作区、内核与界面分离

## 16. 从零实现教程（Claude Code 逆向学习，2026-08 逐章核实）

贯穿各专题的"最小可运行实现 + 真实 Claude Code 对照"一手参考，补充本设计文档的落地细节（Agent Loop 的 continue reason、工具延迟加载 / 并行、read-before-edit 与 mtime、双后端流式与前缀缓存、分层压缩、记忆语义召回、Skills inline/fork、Plan 四选项、子 Agent 配置化、MCP 握手、自治续跑、测试方法论）。

- **claude-code-from-scratch（Di Wang）** — 从零构建 Claude Code 的 16 章教程（约 4300 行可运行 Python，配"真实 Claude Code 多做了什么 / 简化决策"对照）：
  在线阅读 https://diwang.info/claude-code-from-scratch/#/
  源码仓库 https://github.com/Windy3f3f3f3f/claude-code-from-scratch
  章节：00 引言 / 01 Agent Loop / 02 工具 / 03 System Prompt / 04 CLI 与会话 / 05 流式双后端 / 06 权限 / 07 上下文 / 08 记忆 / 09 Skills / 10 Plan Mode / 11 多 Agent / 12 MCP / 13 架构对比 / 14 测试 / 15 自治与续跑

- **how-claude-code-works（Di Wang）** — Claude Code 架构深度分析（21 章，基于 v2.1.88 泄露源码快照走读 + 官方文档 + 2.1.201 客户端明文反代抓包）：
  在线阅读 https://diwang.info/how-claude-code-works/#/
  快照章节（1–16）：概览 / Agent Loop / 上下文工程 / 工具系统 / 代码编辑 / Hooks / 多 Agent / 记忆 / Skills / Plan Mode / 权限安全 / 用户体验 / 最小组件 / 系统提示词 / 任务系统 / 可观测性
  快照后前沿（17–21）：**/goal 与 /loop、Auto Mode（分类器）、Dynamic Workflows、Agent Teams、Background Fleet**

> 定位说明：该教程是"教学用最小实现"（readline REPL、文件持久化、无沙箱），mod-agent 是"生产级目标架构"（Ink TUI、Zod、SQLite、Docker、Worktree）。本设计文档引用的是其机制设计与边界处理思路，不照搬其最小实现代码；凡涉及安全 / 持久化 / 隔离，以本设计文档的工程化选型为准。

> 两篇关系：`claude-code-from-scratch` 是"最小实现 + 真实对照"的教学教程，`how-claude-code-works` 是"对真实 Claude Code 全量代码的深度架构分析"。前者覆盖 mod-agent 的 day-1 落地机制，后者补充真实工程的全貌与最新前沿能力（尤其快照后第 17–21 章，是本设计文档 `dynamic-workflows.md` / `agent-teams.md` / `background-fleet.md` 三篇的一手依据）。
