# Changelog

## 1.0.0 (2026-11-28)


### Features

* 实现 worktree 隔离与按模型解析上下文和价格 ([3f5115a](https://github.com/OPQ741/mod-agent/commit/3f5115ac8b1ddd74f58d0291fb3073274b64da1f))
* 实现模型流式输出与 SSE 解析 ([a54f046](https://github.com/OPQ741/mod-agent/commit/a54f04656e79776e56c9297fd313a25528700da6))
* 引入工具钩子与按类型区分的失败语义 ([a7ddaf2](https://github.com/OPQ741/mod-agent/commit/a7ddaf2de2281f04c74b05cb31274e76629f32ae))
* 按请求路径加载就近的 AGENTS.md 规则 ([94cc831](https://github.com/OPQ741/mod-agent/commit/94cc83129f6aa467048dd369dd2c6113ed79362d))
* 接入项目技能与 MCP 工具并落地计划文件 ([cd56871](https://github.com/OPQ741/mod-agent/commit/cd56871a2756f381e0dda1559948364fc6153da2))
* 支持 MCP HTTP 传输与只读工具并行执行 ([6755ed6](https://github.com/OPQ741/mod-agent/commit/6755ed6b177069157a5506ae61acf4194b4577fc))
* 支持断流恢复与工具进度流式输出 ([a509201](https://github.com/OPQ741/mod-agent/commit/a5092017933437beafeb638f2a46cf9c93c5de9d))
* 新增核心实现代码与单元测试 ([8fec343](https://github.com/OPQ741/mod-agent/commit/8fec343a474bf98f1594a2861cc8b2d7c29332f7))


### Bug Fixes

* 修复压缩丢失环境块并遵守服务端 Retry-After ([3cddfa5](https://github.com/OPQ741/mod-agent/commit/3cddfa5d2714294beaf68b25f20e22432acd844a))
* 修复取消落库、编辑规范化等 8 处缺陷 ([f82c03d](https://github.com/OPQ741/mod-agent/commit/f82c03de97ac024b0dc09cb582075a4a3f5c2eb7))
* 修复审计发现的策略绕过与状态机缺陷并补齐回归测试 ([97ee36c](https://github.com/OPQ741/mod-agent/commit/97ee36cd3eb72f63af66de8587aacecbccdefbb8))
* 加固审批过期与恢复校验并完善 worktree 管理 ([1b57d0e](https://github.com/OPQ741/mod-agent/commit/1b57d0efc0c2ed6dc3fecaa05b7cf93e76a46c4f))
* 加固符号链接校验与取消响应并同步代码阶段文档 ([9c196c1](https://github.com/OPQ741/mod-agent/commit/9c196c1c2efe04e9b018e3fa76614e78c0b4932b))
* 封堵 .exe 绕过判定并消除测试环境依赖 ([cd5307e](https://github.com/OPQ741/mod-agent/commit/cd5307e4c4003d73845a740f73eeceb44a51d1a2))
* 引入任务写入重试与 Windows 可执行文件解析 ([ff062c6](https://github.com/OPQ741/mod-agent/commit/ff062c67dda1db0068dbf57f3e758a49c824fe8d))
* 隔离任务级状态并加固存储与沙箱解析 ([74176ab](https://github.com/OPQ741/mod-agent/commit/74176ab8d40a2b4f5bb6b4199919cf7cf2675e43))

## 更新日志

本项目所有值得记录的版本变更都写在这里，由 `release-please` 自动维护。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

机制：合入 `master` 的 Conventional Commits 会累积到一条 release PR，评审合入后自动生成版本 tag、GitHub Release 以及本文件里对应的段落。段落标题由 release-please 按 Conventional Commits 分组生成（`### Features`、`### Bug Fixes` 等，英文），维护者不需要手写 changelog，也不需要手工 bump 版本号。

首次发布时 release-please 会在文件顶部写入它自己的 `# Changelog` 头，本段人工说明会被保留在其下方。

## 当前状态

尚未发布任何版本。项目已进入代码阶段（`src/` 下有可运行的 Agent Runtime，`npm test` 可在离线环境跑全量用例），但还没有对外发布，因此 `package.json` 与 `.release-please-manifest.json` 的版本基线定为 `0.0.0`：第一条带 `feat` 的提交合入后，release-please 会开出 `v0.1.0` 的 release PR。
