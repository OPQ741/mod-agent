import { defineConfig } from "vitepress"
import { withMermaid } from "vitepress-plugin-mermaid"

// GitHub 项目页部署在子路径 /mod-agent/ 下；本地 dev 服务器仍用根路径 /。
// VitePress 会自动给 themeConfig.logo 等主题资源加 base 前缀，
// 但 head 里的 <link> 是原样注入，需要手动拼 base。
const base = process.env.NODE_ENV === "production" ? "/mod-agent/" : "/"

export default withMermaid(
  defineConfig({
    base,
    title: "mod-agent",
    description: "AI Coding Agent 设计文档",
    lang: "zh-CN",
    lastUpdated: true,
    head: [
      // 源文件在 docs/public/favicon.svg，随构建一起产出；head 里的 href 需手动拼 base。
      ["link", { rel: "icon", type: "image/svg+xml", href: `${base}favicon.svg` }],
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
        { text: "03 · 使用说明", link: "/usage" },
        { text: "04 · 领域调研", link: "/research" },
        { text: "05 · Coding Agent 全景图鉴", link: "/coding-agents" },
        { text: "06 · Claude Code 实战教程", link: "/claude-code-guide" },
        { text: "07 · 总体架构", link: "/architecture" },
        { text: "08 · 运行时状态机", link: "/agent-loop" },
        { text: "09 · 代码库与上下文", link: "/context-engineering" },
        { text: "10 · 系统提示词工程", link: "/system-prompt" },
        { text: "11 · 工具系统与扩展", link: "/tools-and-extensions" },
        { text: "12 · 文件编辑与变更", link: "/code-editing" },
        { text: "13 · 验证与子代理", link: "/verification-and-multiagent" },
        { text: "14 · 自治与续跑", link: "/autonomy" },
        { text: "15 · 动态工作流", link: "/dynamic-workflows" },
        { text: "16 · Agent 团队", link: "/agent-teams" },
        { text: "17 · 后台舰队", link: "/background-fleet" },
        { text: "18 · 沙箱与安全", link: "/security" },
        { text: "19 · 事件流与持久化", link: "/data-and-events" },
        { text: "20 · 模型接入", link: "/model-gateway" },
        { text: "21 · 观测与评测", link: "/observability-evaluation" },
        { text: "22 · 路线图", link: "/roadmap" },
        { text: "23 · 开发实现指南", link: "/development-guide" },
        { text: "24 · 参考来源", link: "/references" },
      ],
      socialLinks: [{ icon: "github", link: "https://github.com/OPQ741/mod-agent" }],
    },
  }),
)
