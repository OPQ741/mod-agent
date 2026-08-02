import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(defineConfig({
  title: 'mod-agent',
  description: 'AI Coding Agent 设计文档',
  lang: 'zh-CN',
  lastUpdated: true,
  themeConfig: {
    search: { provider: 'local' },
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    sidebar: [
      { text: '01 · 首页', link: '/' },
      { text: '02 · Overview', link: '/overview' },
      { text: '03 · Research', link: '/research' },
      { text: '04 · Architecture', link: '/architecture' },
      { text: '05 · Agent Loop', link: '/agent-loop' },
      { text: '06 · Context Engineering', link: '/context-engineering' },
      { text: '07 · Tools & Extensions', link: '/tools-and-extensions' },
      { text: '08 · Code Editing', link: '/code-editing' },
      { text: '09 · Verification & Multi-Agent', link: '/verification-and-multiagent' },
      { text: '10 · Security', link: '/security' },
      { text: '11 · Data & Events', link: '/data-and-events' },
      { text: '12 · Model Gateway', link: '/model-gateway' },
      { text: '13 · Observability & Evaluation', link: '/observability-evaluation' },
      { text: '14 · Roadmap', link: '/roadmap' },
      { text: '15 · References', link: '/references' },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/' }
    ],
  },
}))
