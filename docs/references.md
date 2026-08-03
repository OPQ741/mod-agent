# References · 参考来源

> 供设计核验与后续深入学习。官方 SDK / API、MCP 规范与云平台策略持续演进，正式实现前应再核对所选版本，并用锁文件与契约测试锁定行为。核对日期：2026-08。

## Agent 运行时与范式

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
  https://arxiv.org/abs/2407.1489

## 模型与网关

- **OpenAI Agents 文档：运行时方案比较**
  https://developers.openai.com/api/docs/guides/agents
- **OpenAI Agents SDK（TS 参考实现）**
  https://developers.openai.com/api/docs/guides/agents/sdk
- **LangGraph Persistence**（checkpoint / 恢复 / 人类审批对比参考，不意味着必须采用）
  https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/persistence.mdx

## MCP 扩展

- **MCP Tools 规范**
  https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- **MCP TypeScript SDK**
  https://ts.sdk.modelcontextprotocol.io/
- **MCP Security Best Practices**
  https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices

## 代码检索与解析

- **Tree-sitter**（增量语法、多语言、错误恢复）
  https://github.com/tree-sitter/tree-sitter/blob/master/docs/src/index.md
- **TypeScript Compiler API 指南**（Program / SourceFile / TypeChecker）
  https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API
- **Aider Repo Map**（tree-sitter 符号索引）
  https://aider.chat/docs/git.html

## 安全与沙箱

- **OWASP Top 10 for LLM Applications 2025**
  https://genai.owasp.org/resource/owasp-top-10-for-llm-applications-2025/
- **Microsoft：Securing CI/CD in an agentic world**（Agents Rule of Two、Read 工具密钥泄漏教训）
  https://www.microsoft.com/en-us/security/blog/2026/06/05/securing-ci-cd-in-agentic-world-claude-code-github-action-case/
- **Docker 安全：Rootless 与 seccomp**
  https://docs.docker.com/engine/security/rootless/
  https://docs.docker.com/engine/security/seccomp/
- **GitHub Copilot 沙箱与安全设置**
  https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings

## 评测

- **SWE-bench 项目**
  https://github.com/SWE-bench/SWE-bench
- **Playwright 测试断言**（异步 UI、自动重试）
  https://playwright.dev/docs/test-assertions

## 观测

- **OpenTelemetry Semantic Conventions**
  https://opentelemetry.io/docs/specs/semconv/

## 主流产品官方文档

- Claude Code：permissions / sub-agents / skills & hooks
  https://code.claude.com/docs/en/permissions
- Cursor：Agent mode、codebase indexing、plan 模式
  https://cursor.com/help/ai-features/agent
- Devin / Cognition
  https://cognition.com/blog/introducing-devin

---

以下五个分类为 [Coding Agent 全景图鉴](./coding-agents.md) 的链接清单，2026-08-13 逐个打开核对（GitHub 仓库页 + 官方文档）。star 数为核对日动态约数，仅作量级参考；仓库 slug 若发生迁移，GitHub 旧地址会自动跳转。

## 终端 / CLI Coding Agent

| 项目                   | GitHub（已核实）                                                                                         | 官方文档                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Claude Code            | https://github.com/anthropics/claude-code （自定义源码许可，非 OSI）                                     | https://code.claude.com/docs/en/overview                                              |
| OpenAI Codex CLI       | https://github.com/openai/codex （Apache-2.0）                                                           | https://developers.openai.com/codex                                                   |
| Gemini CLI             | https://github.com/google-gemini/gemini-cli （Apache-2.0）                                               | https://google-gemini.github.io/gemini-cli/                                           |
| Aider                  | https://github.com/Aider-AI/aider （Apache-2.0）                                                         | https://aider.chat/                                                                   |
| OpenCode               | https://github.com/anomalyco/opencode （MIT；原 sst/opencode 自动跳转）                                  | https://opencode.ai/docs/                                                             |
| Goose                  | https://github.com/aaif-goose/goose （Apache-2.0；原 block/goose 跳转，现归 Linux 基金会 AAIF）          | https://block.github.io/goose/                                                        |
| Crush                  | https://github.com/charmbracelet/crush （FSL-1.1-MIT）                                                   | https://charm.sh/                                                                     |
| Qwen Code              | https://github.com/QwenLM/qwen-code （Apache-2.0）                                                       | https://qwenlm.github.io/qwen-code-docs/                                              |
| Amazon Q Developer CLI | https://github.com/aws/amazon-q-developer-cli （Apache-2.0；README 声明仅收安全补丁，转向闭源 Kiro CLI） | https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line-installing.html |
| Continue（CLI `cn`）   | https://github.com/continuedev/continue （Apache-2.0；README 声明只读停更，最终 2.0.0）                  | https://docs.continue.dev/cli/quickstart                                              |

## IDE 内 Coding Agent

| 项目                      | GitHub（已核实）                                                                           | 官方文档                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Cursor                    | 无公开仓库（闭源，Anysphere）                                                              | https://cursor.com/docs/agent ｜ 规则 https://cursor.com/docs/rules ｜ 云端 https://cursor.com/docs/cloud-agent                  |
| Windsurf                  | 无编辑器公开仓库（2025-07 被 Cognition 收购）                                              | https://docs.windsurf.com/windsurf/cascade/cascade ｜ 收购公告 https://windsurf.com/blog/windsurfs-next-chapter                  |
| GitHub Copilot agent mode | 无独立仓库                                                                                 | https://docs.github.com/en/copilot/how-tos/chat-with-copilot/chat-in-ide                                                         |
| Cline                     | https://github.com/cline/cline （Apache-2.0）                                              | https://cline.bot                                                                                                                |
| Roo Code                  | https://github.com/RooCodeInc/Roo-Code （Apache-2.0；**2026-05-15 停服、Public archive**） | https://roocode.com                                                                                                              |
| Kilo Code                 | https://github.com/Kilo-Org/kilocode （MIT）                                               | https://kilo.ai                                                                                                                  |
| Zed                       | https://github.com/zed-industries/zed （GPL-3.0）                                          | https://zed.dev/docs/ai/agent-panel ｜ 并行 https://zed.dev/docs/ai/parallel-agents ｜ 外部 agent https://zed.dev/docs/ai/agents |
| Trae（字节）              | IDE 闭源；仅研究型 CLI 开源 https://github.com/bytedance/trae-agent （MIT）                | https://docs.trae.ai/ide/what-is-trae                                                                                            |
| Void                      | https://github.com/voideditor/void （Apache-2.0；**已弃用归档**）                          | https://voideditor.com                                                                                                           |

## 云端 / 自治 Coding Agent

| 项目                       | GitHub（已核实）                                                                            | 官方文档                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Devin (Cognition)          | 无官方开源仓库                                                                              | https://docs.devin.ai/get-started/devin-intro                                                       |
| GitHub Copilot cloud agent | 无开源仓库                                                                                  | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github |
| Replit Agent               | 无开源仓库                                                                                  | https://docs.replit.com/features/agent/overview                                                     |
| bolt.diy（开源版）         | https://github.com/stackblitz-labs/bolt.diy （MIT；WebContainer 商用需另授权）              | https://stackblitz-labs.github.io/bolt.diy/ ｜ 托管产品 https://bolt.new                            |
| v0 (Vercel)                | 无开源仓库                                                                                  | https://v0.dev/faq                                                                                  |
| Lovable                    | 无开源仓库                                                                                  | https://docs.lovable.dev                                                                            |
| Factory / Droid            | 核心闭源；开源 TS SDK https://github.com/Factory-AI/droid-sdk-typescript （license 未核实） | https://docs.factory.com/                                                                           |

## 开源平台、框架与学术项目

| 项目              | GitHub（已核实）                                                                                       | 官方文档 / 论文                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| SWE-agent         | https://github.com/SWE-agent/SWE-agent （MIT；官方重心转向 mini-SWE-agent）                            | https://swe-agent.com/latest/background/ ｜ https://arxiv.org/abs/2405.15793 |
| OpenHands         | https://github.com/OpenHands/OpenHands （MIT；原 All-Hands-AI 跳转）                                   | https://docs.openhands.dev/ ｜ https://arxiv.org/abs/2407.16741              |
| Agentless         | https://github.com/OpenAutoCoder/Agentless （MIT）                                                     | https://arxiv.org/abs/2407.01489                                             |
| Moatless Tools    | https://github.com/aorwall/moatless-tools （MIT；论文实现见 moatless-tree-search）                     | https://github.com/aorwall/moatless-tree-search                              |
| AutoCodeRover     | https://github.com/AutoCodeRoverSG/auto-code-rover （**Sonar Source-Available License v1.0，非商业**） | https://arxiv.org/abs/2404.05427                                             |
| MetaGPT           | https://github.com/FoundationAgents/MetaGPT （MIT；原 geekan 跳转）                                    | https://openreview.net/forum?id=VtmBAGCN7o                                   |
| AutoGen           | https://github.com/microsoft/autogen （MIT；**已进入维护模式**，后继 Microsoft Agent Framework）       | https://microsoft.github.io/autogen/                                         |
| CrewAI            | https://github.com/crewAIInc/crewAI （MIT）                                                            | https://docs.crewai.com/                                                     |
| LangGraph         | https://github.com/langchain-ai/langgraph （MIT）                                                      | https://docs.langchain.com/oss/python/langgraph/                             |
| OpenAI Agents SDK | https://github.com/openai/openai-agents-python （MIT；JS 版 openai/openai-agents-js）                  | https://openai.github.io/openai-agents-python/                               |
| Google ADK        | https://github.com/google/adk-python （Apache-2.0）                                                    | https://google.github.io/adk-docs/                                           |
| Pydantic AI       | https://github.com/pydantic/pydantic-ai （MIT）                                                        | https://ai.pydantic.dev/                                                     |
| Mastra            | https://github.com/mastra-ai/mastra （**双许可**：核心 Apache-2.0 + ee/ 企业许可）                     | https://mastra.ai                                                            |
| gpt-engineer      | https://github.com/AntonOsika/gpt-engineer （MIT；**已 archived**）                                    | https://github.com/AntonOsika/gpt-engineer                                   |
| smol developer    | https://github.com/smol-ai/developer （MIT）                                                           | https://github.com/smol-ai/developer                                         |

## 开放协议与规范

| 协议                         | 仓库 / 官网（已核实）                                                                                                         | 备注                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| MCP (Model Context Protocol) | https://github.com/modelcontextprotocol/modelcontextprotocol （MIT；原 specification 跳转）｜ https://modelcontextprotocol.io | agent ↔ 工具/数据，tools/resources/prompts 三原语                      |
| A2A (Agent2Agent)            | https://github.com/a2aproject/A2A （Apache-2.0）｜ https://a2a-protocol.org                                                   | agent ↔ agent，Google 发起、Linux 基金会托管                           |
| ACP (Agent Client Protocol)  | https://zed.dev/docs/ai/agents                                                                                                | 编辑器 ↔ 外部 CLI agent（Zed 主推）                                    |
| AGENTS.md                    | https://agents.md                                                                                                             | 给 agent 看的项目 README，Linux 基金会 AAIF 托管；仓库 slug 未单独核实 |

## 维护说明

- 每个依赖 / 对标项目记录四件事：**许可证、最近提交、归档状态、替代方案**；「源码可见」不等于 OSI 开源（Claude Code 自定义许可、Crush FSL、AutoCodeRover Sonar、Mastra 双许可、Zed GPL-3.0 均需单独合规判断）。
- 本清单与 [coding-agents.md](./coding-agents.md) 的画像一一对应；发现链接失效或项目停服 / 迁移时，以官方仓库为准并同步更新两处。
- 本文档随设计推进持续更新：新选型、新 ADR、新踩坑记录都会回链到这里。

## 机制精读来源（2026-08-13 逐页 fetch 核实）

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
