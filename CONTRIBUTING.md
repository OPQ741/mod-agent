# 贡献指南

感谢你有兴趣改进 mod-agent。本文说明从本地跑起到提交 PR 的完整流程。所有约定都由 CI 与 Git 钩子强制执行，本地先跑通可以省下往返。

## 环境要求

- Node.js >= 22
- npm >= 10

## 本地开发

```bash
git clone https://github.com/OPQ741/mod-agent.git
cd mod-agent
npm install        # 触发 husky prepare，安装 Git 钩子
npm run docs       # 本地预览文档站（默认 http://localhost:5173）
```

## 提交前必须通过的检查

一次全量校验：

```bash
npm run lint
```

它串联以下四步，可单独运行来定位问题：

| 命令                   | 作用                                              |
| ---------------------- | ------------------------------------------------- |
| `npm run lint:eslint`  | ESLint 检查 JS/TS（flat config）                  |
| `npm run lint:md`      | markdownlint 检查所有 Markdown                    |
| `npm run lint:links`   | 按 VitePress 锚点规则校验 `docs/` 页内 / 跨页链接 |
| `npm run lint:agents`  | 校验 `AGENTS.md` 里引用的 `npm run` 命令真实存在  |
| `npm run format:check` | Prettier 检查格式                                 |

自动修复：`npm run lint:fix`。

## Git 钩子

通过 husky + lint-staged 在提交时自动执行，请勿用 `--no-verify` 绕过。

- **pre-commit**：对暂存文件跑 `eslint --fix`、`prettier --write`、`markdownlint-cli2 --fix` 与文档链接校验。
- **commit-msg**：commitlint 校验提交信息符合 Conventional Commits。

## 提交信息规范

格式：`type(scope): 中文或英文描述`

常用 type：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `build` / `ci` / `chore` / `revert`。

示例：

```text
feat(runtime): 新增任务状态机与预算守卫
docs: 修订 security 章节的沙箱基线描述
fix(tools): 修复并行工具执行的结果顺序错乱
```

## 编辑文档站的硬性规则

- **标题文字逐字不动**。站内锚点由标题文本生成，改标题会让其它文档的交叉链接全部断链。
- 技术并列或择一里的斜杠 `/` 原样保留，不得改成顿号 `、`，也不得擅自加空格。
- 表格、mermaid、代码块、交叉链接、技术数字与出处默认保持原样。
- `docs/.vitepress/dist` 与 `docs/.vitepress/cache` 是构建产物，禁止手改。

## 换行符

仓库通过 `.gitattributes` 统一文本文件为 LF（Windows 脚本除外），请勿修改 git 的 `core.autocrlf` 设置。

## 提出 PR 的流程

1. 从 `master` 切出分支，一个 PR 只围绕一个明确目标，保持改动小而独立。
2. 本地跑 `npm run lint` 全绿。
3. 若涉及跨模块的设计取舍或新增依赖，先在 `adr/` 记录一条 ADR（见 `adr/README.md`）。
4. 填写 PR 模板里的自检清单，指明实际运行了哪些验证。
5. 保持单一改动、不掺入无关重构，便于审查与回滚。

## 架构决策记录

影响多个模块、后续难以更改、或存在明显取舍的决策，请在 `adr/` 下新增一条 ADR。微小的实现细节不必记录。

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。

## 安全漏洞

请勿公开提 Issue。发现安全问题请按 [SECURITY.md](./SECURITY.md) 私密报告。
