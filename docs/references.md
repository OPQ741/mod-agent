# References · 参考来源

> 设计核验与后续深入学习用。官方 SDK / API、MCP 规范与云平台策略持续演进，正式实现前应再核对所选版本，并用锁文件与契约测试锁定行为。核对日期：2026-08。

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
