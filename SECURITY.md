# 安全策略

mod-agent 是一个能读取、修改文件并执行命令的 AI Coding Agent。它的设计阶段就把安全边界视为一等公民，而不是事后补丁。

## 报告漏洞

如果你认为发现了本项目的安全问题，请**不要**通过公开的 Issue 或 PR 报告。

请通过私有渠道报告：在 GitHub 上对本仓库使用「Report a vulnerability」（Security → Report a vulnerability），或联系维护者私密沟通。我们会尽快确认并给出处置计划。

报告时请尽量附上：受影响版本或提交、可稳定复现的步骤、影响范围评估。

## 适用范围

本项目安全策略覆盖：Agent 主循环、工具执行层（文件 / Shell / Git / MCP）、模型适配层、任务持久化与权限判定逻辑。

不覆盖：你所使用的外部模型供应商、你在 Agent 里加载的第三方 MCP Server 自身的实现缺陷（但鼓励你把可疑行为反馈给我们）。

## 设计上坚持的边界

- 权限判断在服务端与工具执行层完成，绝不只在前端隐藏按钮，也不只靠 Prompt 要求模型「不要做危险操作」。
- 工具入参必须校验，路径解析必须防止目录穿越（拒绝经 `../` 逃出授权目录）。
- 命令执行避免把不可信字符串直接拼接进 Shell。
- 代码注释、README、网页与 MCP 返回内容一律视为不可信数据，防止提示词注入。
- API Key、Token、密码不得写入生成的源码、Git 提交或普通日志。
- 删除文件、覆盖数据、Git 推送、发布等高风险操作需要显式审批，重试前先检测是否已产生副作用。

## 版本支持

项目处于设计阶段，暂未发布稳定版本。开始发布后，我们将对最近的主版本线提供安全修复。

## 已启用的 GitHub 安全能力

维护者应在仓库 Settings 中开启：Secret scanning push protection、Dependabot alerts、Private vulnerability reporting。依赖更新由 `.github/dependabot.yml` 自动开 PR。
