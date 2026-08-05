# mod-agent

一个用 **TypeScript + Node.js** 从零实现的 AI Coding Agent CLI，形态类似 Claude Code：读入自然语言编程需求，自主完成「读代码 → 改文件 → 跑测试 → 迭代修复」的闭环，最终产出人可审查的 diff。

项目当前处于 **设计阶段**，仓库主体是 VitePress 文档站（`docs/`），完整设计见[文档站首页](./docs/index.md)。

## 环境要求

- Node.js >= 22
- npm >= 10

## 文档站

```bash
npm run docs          # 本地预览（默认 http://localhost:5173）
npm run docs:build    # 构建静态产物到 docs/.vitepress/dist
```

## 代码质量工具链

仓库已配置 ESLint + Prettier + markdownlint + 自定义文档链接校验，全部通过 husky / lint-staged 在提交时自动执行。

| 命令                   | 作用                                                  |
| ---------------------- | ----------------------------------------------------- |
| `npm run lint`         | 全量校验：ESLint + markdownlint + 文档链接 + Prettier |
| `npm run lint:eslint`  | 仅检查 JS/TS（ESLint flat config）                    |
| `npm run lint:md`      | 仅检查 Markdown（markdownlint）                       |
| `npm run lint:links`   | 按 VitePress 锚点规则校验文档页内/跨页链接            |
| `npm run format`       | 用 Prettier 格式化全仓库                              |
| `npm run format:check` | 仅检查格式，不修改文件                                |
| `npm run lint:fix`     | 自动修复 ESLint / markdownlint / Prettier 问题        |
| `npm run typecheck`    | TypeScript 严格模式类型检查（`tsc --noEmit`）         |

### Git 钩子

- **pre-commit**：对暂存文件运行 lint-staged
  - `*.{js,mjs,cjs,ts,mts,cts}` → `eslint --fix` + `prettier --write`
  - `*.md` → `prettier --write` + `markdownlint-cli2 --fix` + 文档链接校验
  - `*.{json,yml,yaml,css,html,svg}` → `prettier --write`
- **commit-msg**：commitlint 校验提交信息是否符合 [Conventional Commits](https://www.conventionalcommits.org/)。

如确需临时跳过钩子（不推荐）：`git commit --no-verify`。

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

GitHub Actions（`.github/workflows/ci.yml`）在推送和 PR 时自动运行：

1. ESLint / markdownlint / 文档链接 / Prettier 全套校验；
2. VitePress 文档站构建。
