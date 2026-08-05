# mod-agent · GitHub Copilot 项目指令

这份文件只给 GitHub Copilot Chat 与 Copilot Coding Agent 看，不重复 `AGENTS.md` 的内容。
先读根目录 `AGENTS.md`，它才是这个仓库对 AI 编码代理的统一操作手册。

## 补充要点

- 仓库当前处于**设计阶段**：`docs/` 是 VitePress 文档站正文，`src/` 与运行时代码尚未存在。判断你面对的是"文档站阶段的仓库"还是"代码阶段的仓库"再决定改法。
- 分支：默认分支是 `master`（非 `main`），PR 目标始终为 `master`。
- 编辑 `docs/*.md` 时，标题文字必须逐字不动（站内锚点由标题文本生成），技术并列里的 `/` 保留原样，不得改成 `、` 或加空格。详见 `AGENTS.md` §2 与 §5。
- 提交前顺序：若改文档，先 `npm run lint:links`，再 `npm run lint`。
- 不做的事：不擅自升级依赖、不注释掉失败的检查、不用 `--no-verify` 跳过 Git 钩子、不向 `master` 直接推送、不在源码 / commit message / 日志 / 测试报告中输出密钥或 Token。
