# mod-agent

[![CI](https://github.com/OPQ741/mod-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/OPQ741/mod-agent/actions/workflows/ci.yml)
[![Docs](https://github.com/OPQ741/mod-agent/actions/workflows/deploy-docs.yml/badge.svg)](https://opq741.github.io/mod-agent/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D22.5-brightgreen.svg)](./.nvmrc)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/OPQ741/mod-agent/badge)](https://api.securityscorecards.dev/projects/github.com/OPQ741/mod-agent)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/OPQ741/mod-agent)

一个用 **TypeScript + Node.js** 从零实现的 AI Coding Agent CLI，形态类似 Claude Code：读入自然语言编程需求，自主完成「读代码 → 改文件 → 跑测试 → 迭代修复」的闭环，最终产出人可审查的 diff。

项目当前处于 **代码阶段**：`src/` 下已经是一个可运行的 Agent Runtime（主循环、工具执行、权限策略、SQLite 持久化、沙箱），VitePress 文档站（`docs/`）与实现并行维护 —— 文档描述目标架构，代码是它的落地。在线文档见 <https://opq741.github.io/mod-agent/>，仓库内入口见 [docs/index.md](./docs/index.md)。

## 从源码运行

```bash
npm install
npm run build                    # tsc -p tsconfig.build.json → dist/
node dist/cli/main.js --version  # 冒烟：入口可启动
node dist/cli/main.js doctor     # 只读自检：配置 / 存储 / 沙箱 / 工具 / 凭证
```

不接真实模型也能跑：`--script <file>` 按文件里的决策序列离线回放，测试全部依赖这条通道，所以 `npm test` 不需要网络与 API Key。

```bash
npm test          # vitest run，497 条用例，离线
npm run typecheck # tsc --noEmit（strict）
npm run build     # 编译到 dist/
```

`package.json` 目前是 `private: true`（尚未作为 npm 包发布）；`bin` 已声明 `mod` / `mod-agent` 两个入口，指向同一个 `dist/cli/main.js`。本地试用可先 `npm link` 再敲 `mod`。

## 环境要求

- Node.js >= 22.5（`node:sqlite` 自 22.5 提供；见 `.nvmrc` 与 `package.json` 的 `engines`）
- npm >= 10

## 文档站

```bash
npm install         # 首次拉仓；触发 husky prepare 装 Git 钩子
npm run docs        # 本地预览（默认 http://localhost:5173）
npm run docs:build  # 构建静态产物到 docs/.vitepress/dist
```

也可以不装本地环境，点上面 Codespaces 徽章一键起云端工作区。

## 代码质量工具链

仓库已配置 ESLint + Prettier + markdownlint + 自定义文档链接校验 + AGENTS.md 命令校验，全部通过 husky / lint-staged 在提交时自动执行。跨语言协作者可用 `make help` 查看统一入口。

| 命令                   | 作用                                                  |
| ---------------------- | ----------------------------------------------------- |
| `npm run lint`         | 全量校验：ESLint + markdownlint + 文档链接 + Prettier |
| `npm run lint:eslint`  | 仅检查 JS/TS（ESLint flat config）                    |
| `npm run lint:md`      | 仅检查 Markdown（markdownlint）                       |
| `npm run lint:links`   | 按 VitePress 锚点规则校验文档页内/跨页链接            |
| `npm run lint:agents`  | 校验 `AGENTS.md` 里引用的 `npm run` 命令真实存在      |
| `npm run format`       | 用 Prettier 格式化全仓库                              |
| `npm run format:check` | 仅检查格式，不修改文件                                |
| `npm run lint:fix`     | 自动修复 ESLint / markdownlint / Prettier 问题        |
| `npm run typecheck`    | TypeScript 严格模式类型检查（`tsc --noEmit`）         |

### Git 钩子

- **pre-commit**：对暂存文件运行 lint-staged
  - `*.{js,mjs,cjs,ts,mts,cts}` → `eslint --fix` + `prettier --write`
  - `*.md` → `prettier --write` + `markdownlint-cli2 --fix` + 文档链接校验
  - `*.{json,jsonc,yml,yaml,css,scss,html,xml}` → `prettier --write`
  - SVG 不在格式化范围内：Prettier 没有 SVG parser，显式传路径会报 `No parser could be inferred`
- **commit-msg**：commitlint 校验提交信息是否符合 [Conventional Commits](https://www.conventionalcommits.org/)。

`--no-verify` 属于硬边界，禁止使用（见 `AGENTS.md` §5）。如果确实需要临时跳过（例如紧急回滚），在 PR 描述里显式说明原因。

### 提交信息规范

格式：`type(scope): 中文或英文描述`

常用 type：

| type       | 说明                   |
| ---------- | ---------------------- |
| `feat`     | 新功能                 |
| `fix`      | 缺陷修复               |
| `docs`     | 文档变更               |
| `style`    | 格式调整（不影响逻辑） |
| `refactor` | 重构                   |
| `perf`     | 性能优化               |
| `test`     | 测试相关               |
| `build`    | 构建/依赖调整          |
| `ci`       | CI 配置                |
| `chore`    | 杂项                   |
| `revert`   | 回滚提交               |

示例：

```text
feat(runtime): 新增任务状态机与预算守卫
docs: 修订 security 章节的沙箱基线描述
fix(tools): 修复并行工具执行的结果顺序错乱
```

### 换行符

仓库通过 `.gitattributes` 统一文本文件为 LF（Windows 脚本除外），请勿修改 git 的 `core.autocrlf` 设置。

## 持续集成

GitHub Actions 在推送和 PR 时自动运行：

| Workflow                | 作用                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                | lint / typecheck / markdown / 链接 / AGENTS / Prettier / **test（Linux + Windows）** / **build + CLI 冒烟** / 文档构建 |
| `deploy-docs.yml`       | `master` 分支 push 时构建并发布 VitePress 站点到 GitHub Pages                                                          |
| `codeql.yml`            | JS/TS 静态安全分析（security-extended）                                                                                |
| `scorecard.yml`         | OpenSSF Scorecard 周扫描 + 每次主干 push                                                                               |
| `dependency-review.yml` | PR 里拦截含已知 CVE 的新依赖、非白名单许可证                                                                           |
| `secret-scan.yml`       | gitleaks 扫 commit 历史与 diff                                                                                         |
| `stale.yml`             | 60/45 天无活动的 Issue / PR 自动 stale，再 14 天关闭                                                                   |
| `release-please.yml`    | 合入 `master` 的 Conventional Commits 累积成 release PR                                                                |

## 分支与合并策略

- 默认分支：`master`（不是 `main`）。所有 PR 目标为 `master`。
- 只允许 **squash merge**，保持主干线性、每条 commit 对应一次可回滚变更。
- 禁止向 `master` 直接 push、禁止 `force push`。
- 必须通过 CI 全部必需检查；由 `CODEOWNERS` 指派的 reviewer 批准。
- 单人阶段可临时自审通过；引入协作者后强制外部 review。

上述策略由仓库 Settings → Branches → Branch protection rule 配置。文件层面无法完全强制，PR 模板与 `AGENTS.md` 已提醒贡献者不要试图绕过。

## 项目治理

| 文件                                       | 作用                                       |
| ------------------------------------------ | ------------------------------------------ |
| [AGENTS.md](./AGENTS.md)                   | 给 AI 编码代理看的项目操作手册（跨工具）   |
| [CONTRIBUTING.md](./CONTRIBUTING.md)       | 从本地跑起到提交 PR 的完整流程             |
| [SECURITY.md](./SECURITY.md)               | 安全漏洞私密报告方式与设计边界             |
| [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) | 社区行为准则                               |
| [CHANGELOG.md](./CHANGELOG.md)             | 版本变更日志（由 release-please 自动维护） |
| [.github/CODEOWNERS](./.github/CODEOWNERS) | 路径到 review 责任人的映射                 |
| [LICENSE](./LICENSE)                       | ISC 许可证                                 |

依赖更新由 `.github/dependabot.yml` 自动开 PR；Issue / PR 模板位于 `.github/`；`.github/copilot-instructions.md` 是给 GitHub Copilot 的项目入口（指向 `AGENTS.md`，不重复内容）。
