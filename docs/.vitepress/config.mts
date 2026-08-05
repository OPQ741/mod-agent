import { defineConfig } from "vitepress"
import { withMermaid } from "vitepress-plugin-mermaid"

export default withMermaid(
  defineConfig({
    title: "mod-agent",
    description: "AI Coding Agent 设计文档",
    lang: "zh-CN",
    lastUpdated: true,
    head: [
      // 自定义 favicon（可选）
      ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ],
    themeConfig: {
      logo: "/logo.svg",
      search: { provider: "local" },
      outline: { level: [2, 3], label: "本页目录" },
      docFooter: { prev: "上一篇", next: "下一篇" },
      returnToTopLabel: "返回顶部",
      sidebar: [
        { text: "01 · 首页", link: "/" },
        { text: "02 · 目标与边界", link: "/overview" },
        { text: "03 · 领域调研", link: "/research" },
        { text: "03-1 · Coding Agent 全景图鉴", link: "/coding-agents" },
        { text: "04 · 总体架构", link: "/architecture" },
        { text: "05 · 运行时状态机", link: "/agent-loop" },
        { text: "06 · 代码库与上下文", link: "/context-engineering" },
        { text: "06-1 · 系统提示词工程", link: "/system-prompt" },
        { text: "07 · 工具系统与扩展", link: "/tools-and-extensions" },
        { text: "08 · 文件编辑与变更", link: "/code-editing" },
        { text: "09 · 验证与子代理", link: "/verification-and-multiagent" },
        { text: "09-1 · 自治与续跑", link: "/autonomy" },
        { text: "09-2 · 动态工作流", link: "/dynamic-workflows" },
        { text: "09-3 · Agent 团队", link: "/agent-teams" },
        { text: "09-4 · 后台舰队", link: "/background-fleet" },
        { text: "10 · 沙箱与安全", link: "/security" },
        { text: "11 · 事件流与持久化", link: "/data-and-events" },
        { text: "12 · 模型接入", link: "/model-gateway" },
        { text: "13 · 观测与评测", link: "/observability-evaluation" },
        { text: "14 · 路线图", link: "/roadmap" },
        { text: "15 · 参考来源", link: "/references" },
      ],
      socialLinks: [{ icon: "github", link: "https://github.com/OPQ741/mod-agent" }],
    },
  }),
)
