# AGENTS.md — mod-agent

本文件是给 AI 编码代理（Coding Agent）看的项目操作手册。README.md 讲「这个项目是什么」，本文件讲「在这个仓库里怎样正确干活」。Codex、GitHub Copilot、Cursor、Windsurf、Amp、Devin 都会自动读取根目录的 `AGENTS.md`；Claude Code 可通过 `CLAUDE.md` 里一行 `@AGENTS.md` 引用本文件。跨工具共享约定只写这一份，工具专属配置另放原生文件。

请先理解当前代码仓库，再完成后续开发任务。

第一阶段：分析项目。

阅读 README、项目配置、目录结构和相关源代码。

分析项目使用的技术栈、运行方式、测试命令和现有代码规范。

找出与当前任务相关的模块及依赖关系。

暂时不要修改任何文件，先告诉我你的理解、实现方案、风险和验证方式。

第二阶段：实施修改。
在我确认方案后，再修改代码。尽量复用已有组件和工具，不要为了简单需求大规模重构，也不要擅自修改无关文件。

第三阶段：验证。

执行相关测试、类型检查和必要的构建命令。

如果失败，分析原因并修复，再次验证。

总结改动文件、关键实现、测试结果，以及仍然存在的问题。

最后检查 git diff，确保没有无关改动或敏感信息。

## 1. 项目当前阶段

TypeScript + Node.js 实现的 AI Coding Agent CLI，形态对标 Claude Code。**当前处于代码阶段**：`src/` 下已有可运行的 Agent Runtime（`runtime/loop.ts` 唯一主循环 → `tools/executor.ts` → `policy/` → `sandbox/` → `store/`），`tests/` 有 469 条离线用例（`npm test` 不联网、不烧 API 额度）；`docs/`（24 篇源文档）与实现并行维护，文档写目标架构，代码是它的落地。判断"某能力是否存在"一律以 `src/` 为准，不要只读文档下结论。

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
- `npm run lint:agents` — 校验本文件里引用的 `npm run` 命令真实存在（`scripts/verify-agents-md-commands.mjs`）。
- `npm run lint:fix` — 自动修复 ESLint / markdownlint / Prettier 问题。
- `npm run format:check` — 仅检查格式，不写文件。
- `npm run typecheck` — TypeScript strict 类型检查（`tsc --noEmit`）。
- `npm run build` — 编译到 `dist/`（`tsc -p tsconfig.build.json`）。
- `npm run test` — 全量离线测试（`vitest run`，469 用例，不联网、不需要 API Key）。
- `npm run test:watch` — 监听模式，改一处跑相关用例时用。
- `npm run cli` — 跑编译产物 `node dist/cli/main.js`（需先 `npm run build`）。
- `npm run verify` — `typecheck` + `test`；改代码后至少跑这一条。

跨语言协作者或脚本可以用根目录 `Makefile` 的统一目标：`make install` / `make docs` / `make lint` / `make typecheck` / `make check`（= lint + typecheck，CI 的最小子集）。

## 4. 任务→入口对照

拿到一条明确的修改请求时，先看这张表定位入口，再决定改动范围与必跑校验。表里没有的场景，回到 §2 与 §5 兜底。

| 任务                                                  | 入口                                                                                                   | 完成后必跑                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| 改某篇文档正文                                        | `docs/<name>.md`                                                                                       | `npm run lint:links` → `npm run lint`           |
| 加 / 删 / 重命名一篇文档                              | `docs/` 新增文件 + `docs/.vitepress/config.mts` sidebar + `docs/index.md` 导航表，三处同步             | `npm run lint:links` → `npm run lint`           |
| 改侧栏编号 / 顺序                                     | `docs/.vitepress/config.mts`；侧栏 `text` 前缀使用连续两位数 `01`–`24`，不用 `03-1` 之类的连字符子编号 | `npm run lint:links` → `npm run lint`           |
| 改 VitePress 站点配置（主题、导航、构建）             | `docs/.vitepress/config.mts`；主题/静态资源在 `docs/public/`                                           | `npm run docs:build`                            |
| 修本文件里引用的命令是否还存在                        | `scripts/verify-agents-md-commands.mjs`；改 `package.json` scripts 或本文件后必跑                      | `npm run lint:agents`                           |
| 修 ESLint / Prettier / commitlint / markdownlint 规则 | 分别对应 `eslint.config.mjs`、`.prettierrc.json`、`commitlint.config.mjs`、`.markdownlint-cli2.jsonc`  | `npm run lint`                                  |
| 改 Git 钩子                                           | `.husky/pre-commit`、`.husky/commit-msg`；配 `lint-staged.config.mjs` 决定哪些文件跑哪些命令           | 本地 `git commit` 空提交一次自测                |
| 改 CI / GitHub Actions                                | `.github/workflows/*.yml`；`.nvmrc` 决定 Node 版本；`dependabot.yml` 决定依赖更新节奏                  | `actionlint`（可选），推送后看 Actions          |
| 改文档站的对外发布                                    | `.github/workflows/deploy-docs.yml`（GitHub Pages），站点根 `https://opq741.github.io/mod-agent/`      | 推送 `master` 后看 Pages 部署日志               |
| 改 Issue / PR 模板                                    | `.github/ISSUE_TEMPLATE/*.yml`、`.github/pull_request_template.md`；表单字段变更影响 AI 生成信号采集   | GitHub Settings → Issues 预览                   |
| 改贡献者指引 / 治理文件                               | `README.md`、`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`AGENTS.md`、`CHANGELOG.md`       | `npm run lint:md`                               |
| 改主循环 / 循环边界行为（截断、取消、预算、审批）     | `src/runtime/loop.ts`；状态迁移在 `src/runtime/state-machine.ts`，驱动在 `driver.ts`                   | `npm run typecheck` → `npm run test`            |
| 新增 / 修改内置工具                                   | `src/tools/builtin/*`；工具契约（`AgentTool` / `ToolExecutionContext`）在 `src/shared/contracts.ts`    | `npm run test`（`tests/tools.test.ts`）         |
| 改权限、路径守卫、命令判定                            | `src/policy/engine.ts`、`pathguard.ts`、`command.ts`、`rules.ts`；含符号链接与穿越用例                 | `npm run test`（`tests/policy.test.ts`）        |
| 改编辑引擎 / read-before-edit                         | `src/patch/edit.ts`（`EditEngine`）；已读表**按任务**装配，见 `src/runtime/runtime.ts` 的 `run()`      | `npm run test`（`tests/patch.test.ts`）         |
| 改模型适配 / 网关重试与记账                           | `src/model/*`；统一契约在 `types.ts`，重试退避在 `gateway.ts`                                          | `npm run test`（`tests/model.test.ts`）         |
| 改持久化 / 检查点 / 恢复                              | `src/store/sqlite.ts`、`memory.ts`、`src/store/types.ts`                                               | `npm run test`（`tests/sandbox-store.test.ts`） |

原则：能一次改一处就一次改一处，不掺入与任务无关的重构或格式化。真要跨多文件才能改对，走 PR 模板，把改动动机与影响面写清楚。

## 5. 硬性边界

这些是硬约束，不是建议。违反会被 CI 或 Git 钩子拦下。

- `docs/.vitepress/dist` 与 `docs/.vitepress/cache` 是构建产物，禁止手改。
- 禁止用 `--no-verify` 跳过 Git 钩子、或注释掉失败的检查来「让 CI 变绿」。
- 文本文件统一 LF（见 `.gitattributes`），不要修改 git 的 `core.autocrlf` 设置。
- 提交信息必须符合 Conventional Commits（`commit-msg` 钩子会拦，`release-please` 也依赖它）。
- 不要在生成的源码、提交信息、日志或测试报告中输出密钥、Token、密码等敏感数据（`secret-scan.yml` 会跑 gitleaks）。
- 不擅自升级依赖、不删除看似无用但未确认的代码、不直接向主分支推送。
- 修改范围应尽可能小，不做与任务无关的重构。
- 默认分支是 `master`（不是 `main`），PR 目标始终为 `master`，只允许 squash merge。

## 6. 完成任何改动前

- 文档改动：先跑 `npm run lint:links` 确认没断链，再跑 `npm run lint`。
- 代码改动：先跑 `npm run typecheck` 与 `npm run test`，再跑 `npm run lint`；新增行为应有对应测试。
- 修缺陷时优先补一条**断言用户可观察结果**的回归用例（存库状态、磁盘内容、事件流、模型收到什么），而不是断言内部实现 —— `tests/regression.test.ts` 就是按这个规矩积累起来的。
- 检查 `git diff`，确认没有与任务无关的改动、没有覆盖用户已有修改。
- 汇报实际跑了哪些校验、结果如何；没跑的不要声称跑过。
- 无法验证的项，明确说明原因与剩余风险，不要留白。

## 7. 代码阶段的硬约束

这些约束已经生效（不是"将来启用"）：

- 核心模块不得直接 import 具体模型 SDK，只能经统一的模型适配接口调用。
- 所有外部工具入参必须校验、返回必须处理错误与超时；有副作用的操作走权限分级。
- 高风险操作（写文件、执行 Shell、Git 推送）需要显式审批，不允许只靠 Prompt 约束模型。
- 策略判定必须发生在 PreToolUse 钩子**之后**：钩子能改写入参，先判定后执行会让"批准 A、执行 B"。
- 路径判定用 realpath，且目标不存在时也要解析最近存在的祖先 —— 否则符号链接父目录会变成写路径逃逸。
- 能力声明必须与实现一致：声明 `streaming: true` 就必须真的提供 `generateStream()`，且流式与非流式的最终 `ModelResponse` 逐字段一致（流式只负责拼回同形状的原始响应，复用同一段解析）。
- 流式的重试语义与其他请求不同且不可改回去：**一个增量都还没吐出来才允许重试**，吐过之后断流只能失败 —— 重放会让用户看到重复的半段文本。
- 沙箱后端必须声明 `capabilities`，命令的默认网络档位由能力位决定（默认写在 `defaultNetworkProfile`，不要在各处写死）：做不到真断网的后端默认 `inherit`，不要用「阻断」类错误码假装有隔离。
- 任务状态持久化、错误重试上限、变更范围与验收证据链，见 `docs/architecture.md` 与 `docs/security.md`。

## 8. 参考

- AGENTS.md 开放规范由 Agentic AI Foundation（Linux 基金会）维护，官方站点 `agents.md`，源码仓库现为 `agentsmd/agents.md`（原 `openai/agents.md` 已迁移）。注意加载顺序与就近覆盖的条款只在站点正文里，仓库 README 只有最小示例。
- 详细文档索引见 `docs/index.md`；架构见 `docs/architecture.md`；编码规范见 `CONTRIBUTING.md`（如存在）。
- 面向 GitHub Copilot 的项目入口在 `.github/copilot-instructions.md`，只指向本文件，不重复内容。
- 面向外部 AI 检索的项目自述在 `docs/public/llms.txt`，站点上线后可通过 `https://opq741.github.io/mod-agent/llms.txt` 访问。
