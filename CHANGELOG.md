# 更新日志

本项目所有值得记录的版本变更都写在这里，由 `release-please` 自动维护。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

机制：合入 `master` 的 Conventional Commits 会累积到一条 release PR，评审合入后自动生成版本 tag、GitHub Release 以及本文件里对应的段落。段落标题由 release-please 按 Conventional Commits 分组生成（`### Features`、`### Bug Fixes` 等，英文），维护者不需要手写 changelog，也不需要手工 bump 版本号。

首次发布时 release-please 会在文件顶部写入它自己的 `# Changelog` 头，本段人工说明会被保留在其下方。

## 当前状态

尚未发布任何版本。项目处于设计阶段，仓库主体是 VitePress 文档站，尚无 CLI 运行时，因此 `package.json` 与 `.release-please-manifest.json` 的版本基线定为 `0.0.0`：第一条带 `feat` 的提交合入后，release-please 会开出 `v0.1.0` 的 release PR。
