# 贡献指南

感谢你有兴趣改进 mod-agent。本文说明从本地跑起到提交 PR 的完整流程。所有约定都由 CI 与 Git 钩子强制执行，本地先跑通可以省下往返。

## 环境要求

- Node.js >= 22（`.nvmrc` 与 `package.json` 的 `engines` 为准）
- npm >= 10

## 本地开发

```bash
git clone https://github.com/OPQ741/mod-agent.git
cd mod-agent
npm install        # 触发 husky prepare，安装 Git 钩子
npm run docs       # 本地预览文档站（默认 http://localhost:5173）
```

不想配本地环境，点 README 顶部的 "Open in GitHub Codespaces" 徽章一键起云端工作区，或用 `.devcontainer/` 在本地 Docker 里跑。跨语言协作者可用 `make help` 查看统一入口。

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

通过 husky + lint-staged 在提交时自动执行。

- **pre-commit**：对暂存文件跑 `eslint --fix`、`prettier --write`、`markdownlint-cli2 --fix` 与文档链接校验。
- **commit-msg**：commitlint 校验提交信息符合 Conventional Commits。

禁止用 `--no-verify` 绕过钩子；紧急场景在 PR 描述里说明原因由维护者裁定。

## 提交信息规范

格式：`type(scope): 中文或英文描述`

常用 type：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `build` / `ci` / `chore` / `revert`。

示例：

```text
feat(runtime): 新增任务状态机与预算守卫
docs: 修订 security 章节的沙箱基线描述
fix(tools): 修复并行工具执行的结果顺序错乱
```

Conventional Commits 是发布自动化的输入：`release-please` 会累积合入 `master` 的 `feat` / `fix` 等提交生成 release PR 与 `CHANGELOG.md` 段落。写乱 type 会让下一次版本发布跳错档位。

## 编辑文档站的硬性规则

- **标题文字逐字不动**。站内锚点由标题文本生成，改标题会让其它文档的交叉链接全部断链。
- 技术并列或择一里的斜杠 `/` 原样保留，不得改成顿号 `、`，也不得擅自加空格。
- 表格、mermaid、代码块、交叉链接、技术数字与出处默认保持原样。
- `docs/.vitepress/dist` 与 `docs/.vitepress/cache` 是构建产物，禁止手改。

## 换行符

仓库通过 `.gitattributes` 统一文本文件为 LF（Windows 脚本除外），请勿修改 git 的 `core.autocrlf` 设置。

## GitHub Actions 供应链

`.github/workflows/*.yml` 中的第三方 action 目前用 tag 引用（例如 `ossf/scorecard-action@v2.4.0`）。真正启用发布通道、把安全类 workflow 加入 required checks 之前，建议一次性把它们钉到 commit SHA（`npx pin-github-action .github/workflows/*.yml`），之后由 `dependabot.yml` 里的 `github-actions` 生态自动开 PR 更新 SHA。

## 分支与合并策略

- 默认分支是 `master`（不是 `main`），所有 PR 目标为 `master`。
- 只允许 **squash merge**，保持主干线性。
- 禁止向 `master` 直接 push、禁止 `force push`。
- 必须通过 CI 全部必需检查（`ci.yml` 与 `dependency-review.yml`、`codeql.yml`、`secret-scan.yml` 中的安全类 workflow 都是 required checks），由 `CODEOWNERS` 指派的 reviewer 批准。
- 单人阶段可自审通过；引入协作者后强制外部 review。

上述由仓库 Settings → Branches → Branch protection rule 配置。分支名与大格式化 commit 的 blame 归属通过 `.git-blame-ignore-revs` 隔离，本地一次性配置：

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

## 提出 PR 的流程

1. 从 `master` 切出分支，一个 PR 只围绕一个明确目标，保持改动小而独立。
2. 本地跑 `npm run lint` 全绿。
3. 填写 PR 模板里的自检清单，指明实际运行了哪些验证。
4. 保持单一改动、不掺入无关重构，便于审查与回滚。
5. 涉及依赖新增或跨模块取舍时，在 PR 描述里写清备选方案与取舍理由，评审后再合入。

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。

## 安全漏洞

请勿公开提 Issue。发现安全问题请按 [SECURITY.md](./SECURITY.md) 私密报告。
