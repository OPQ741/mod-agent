# AGENTS.md — mod-agent

本文件是给 AI 编码代理（Coding Agent）看的项目操作手册。README.md 讲「这个项目是什么」，本文件讲「在这个仓库里怎样正确干活」。Codex、GitHub Copilot、Cursor、Windsurf、Amp、Devin 都会自动读取根目录的 `AGENTS.md`；Claude Code 可通过 `CLAUDE.md` 里一行 `@AGENTS.md` 引用本文件。跨工具共享约定只写这一份，工具专属配置另放原生文件。

## 1. 项目当前阶段

TypeScript + Node.js 实现的 AI Coding Agent CLI，形态对标 Claude Code。**当前处于设计阶段**：仓库主体是 VitePress 文档站（`docs/`，21 篇源文档，约 6000+ 行），尚无运行时代码。修改前请先确认你面对的是「文档站阶段的仓库」还是「未来代码阶段的仓库」，两者约束不同。

## 2. 开始任何任务前

- 先读 `README.md`；涉及架构决策时先读 `docs/architecture.md`。
- 先跑 `git status` 与 `git rev-parse HEAD` 建立基线，保留用户已有的未提交改动，不覆盖无关文件。
- 修改文档站正文时，**标题文字必须逐字不动**：站内锚点由标题文本生成（形如 `./x.md#_1-1-接口即能力`），改一个标题会让其它文档指向它的链接全部断链。
- 技术并列或择一里的斜杠 `/` 必须原样保留，不得改成顿号 `、`，也不得擅自加空格。
- 表格、mermaid、代码块、交叉链接、技术数字与出处默认保持原样，除非任务本身要求改动。

## 3. 常用命令（真实存在于 package.json scripts，可照抄运行）

- `npm run docs` — 本地预览文档站（默认 `http://localhost:5173`）。
- `npm run docs:build` — 构建静态产物到 `docs/.vitepress/dist`。
- `npm run lint` — 全量校验：ESLint + markdownlint + 文档链接 + Prettier。
- `npm run lint:eslint` — 仅检查 JS/TS。
- `npm run lint:md` — 仅检查 Markdown。
- `npm run lint:links` — 按 VitePress 锚点规则校验 `docs/` 内文档的页内 / 跨页链接。
- `npm run lint:fix` — 自动修复 ESLint / markdownlint / Prettier 问题。
- `npm run format:check` — 仅检查格式，不写文件。
- `npm run typecheck` — TypeScript strict 类型检查（`tsc --noEmit`）。

## 4. 硬性边界

这些是硬约束，不是建议。违反会被 CI 或 Git 钩子拦下。

- `docs/.vitepress/dist` 与 `docs/.vitepress/cache` 是构建产物，禁止手改。
- 禁止用 `--no-verify` 跳过 Git 钩子、或注释掉失败的检查来「让 CI 变绿」。
- 文本文件统一 LF（见 `.gitattributes`），不要修改 git 的 `core.autocrlf` 设置。
- 提交信息必须符合 Conventional Commits（`commit-msg` 钩子会拦）。
- 不要在生成的源码、提交信息、日志或测试报告中输出密钥、Token、密码等敏感数据。
- 不擅自升级依赖、不删除看似无用但未确认的代码、不直接向主分支推送。
- 修改范围应尽可能小，不做与任务无关的重构。

## 5. 完成任何改动前

- 文档改动：先跑 `npm run lint:links` 确认没断链，再跑 `npm run lint`。
- 代码改动（未来）：先跑 `npm run typecheck` 与 `npm run lint`；新增行为应有对应测试。
- 检查 `git diff`，确认没有与任务无关的改动、没有覆盖用户已有修改。
- 汇报实际跑了哪些校验、结果如何；没跑的不要声称跑过。
- 无法验证的项，明确说明原因与剩余风险，不要留白。

## 6. 何时启用代码阶段规则

- 核心模块不得直接 import 具体模型 SDK，只能经统一的模型适配接口调用。
- 所有外部工具入参必须校验、返回必须处理错误与超时；有副作用的操作走权限分级。
- 高风险操作（写文件、执行 Shell、Git 推送）需要显式审批，不允许只靠 Prompt 约束模型。
- 任务状态持久化、错误重试上限、变更范围与验收证据链，见 `docs/architecture.md` 与 `docs/security.md`。

## 7. 参考

- AGENTS.md 开放规范由 Agentic AI Foundation（Linux 基金会）维护，官方站点 `agents.md`，源码仓库 `openai/agents.md`。
- 详细文档索引见 `docs/index.md`；架构见 `docs/architecture.md`；编码规范见 `CONTRIBUTING.md`（如存在）。
