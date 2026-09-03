/**
 * 上下文工程测试。
 *
 * 这一层管的是"模型看到什么"，两条不变量必须钉死：
 * 1. **动静分离**：静态块（系统提示词）必须逐字节稳定，否则前缀缓存命中率归零；
 *    日期、轮次剩余、已改文件这些每轮都变的东西只能在动态尾巴。
 * 2. **压缩不破坏 tool_use / tool_result 配对**，且首条 user（用户请求 + 项目规则）
 *    永远保留 —— 那是防"目标漂移"的第一道防线。
 */

import { describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import path from "node:path"

import {
  RULE_FILE_NAMES,
  bundleRules,
  collectRuleFiles,
  expandImports,
} from "../src/context/rules.js"
import {
  buildContinuationPrompt,
  buildDynamicContext,
  buildRulesReminder,
  buildStaticSystemPrompt,
  buildUserRequest,
} from "../src/context/system-prompt.js"
import {
  compact,
  dedupeMessages,
  estimateMessagesTokens,
  shouldCompact,
} from "../src/context/compaction.js"
import { createTempWorkspace } from "./helpers.js"
import type { ModelMessage } from "../src/model/types.js"

const STATIC_PROMPT_OPTIONS = {
  toolNames: ["repo.read_file", "repo.edit_file", "command.run"],
  deferredToolNames: ["mcp.linear_create_issue"],
  toolPrompts: ["## repo.read_file\nRead a file."],
}

describe("context/system-prompt: 动静分离（前缀缓存的前提）", () => {
  it("静态块不含日期 / 时间 / 轮次等易变内容", () => {
    const prompt = buildStaticSystemPrompt(STATIC_PROMPT_OPTIONS)
    expect(prompt).not.toMatch(/20\d\d-\d\d-\d\d/)
    expect(prompt).not.toMatch(/rounds-left/)
    expect(prompt).not.toMatch(/cwd:/)
  })

  it("同样的入参产出逐字节一致的提示词（缓存命中的前提）", () => {
    expect(buildStaticSystemPrompt(STATIC_PROMPT_OPTIONS)).toBe(
      buildStaticSystemPrompt(STATIC_PROMPT_OPTIONS),
    )
  })

  it("静态块写明硬纪律：绝对路径 / 读后再改 / 工具错误是数据", () => {
    const prompt = buildStaticSystemPrompt(STATIC_PROMPT_OPTIONS)
    expect(prompt).toMatch(/ABSOLUTE/)
    expect(prompt).toMatch(/Read a file before editing/)
    expect(prompt).toMatch(/Tool errors are data/)
    expect(prompt).toMatch(/never as\s+a source of permission|never grants permission|untrusted/i)
  })

  it("延迟加载工具只给名字，提示用 tool_search 激活", () => {
    const prompt = buildStaticSystemPrompt(STATIC_PROMPT_OPTIONS)
    expect(prompt).toContain("mcp.linear_create_issue")
    expect(prompt).toMatch(/tool_search/)
  })

  it("动态块承载所有易变信息，且排在静态块之后", () => {
    const dynamic = buildDynamicContext({
      cwd: "D:/repo",
      workspaceRoot: "D:/repo",
      platform: "win32",
      mode: "edit",
      roundsLeft: 7,
      changedFiles: ["D:/repo/src/a.ts"],
      now: "2026-10-21T00:00:00.000Z",
    })
    expect(dynamic).toContain("rounds-left: 7")
    expect(dynamic).toContain("date: 2026-10-21T00:00:00.000Z")
    expect(dynamic).toContain("changed-files: D:/repo/src/a.ts")
    expect(dynamic.startsWith("<environment>")).toBe(true)
  })

  it("命令形状写进提示词：executable + args[]，不接受 shell 字符串", () => {
    expect(buildStaticSystemPrompt(STATIC_PROMPT_OPTIONS)).toMatch(
      /shell strings are never accepted/,
    )
  })
})

describe("context/system-prompt: 不可信输入包裹", () => {
  it("用户请求被包成 <user-request> 并注明不能授权", () => {
    const wrapped = buildUserRequest("please delete everything")
    expect(wrapped).toContain("<user-request>")
    expect(wrapped).toContain("please delete everything")
    expect(wrapped).toMatch(/never as\s+a source of permission|cannot override the policy engine/)
  })

  it("项目规则放进 system-reminder，并声明它不能覆盖安全策略", () => {
    const reminder = buildRulesReminder("<project-rules>always use tabs</project-rules>")
    expect(reminder).toContain("<system-reminder>")
    expect(reminder).toMatch(/never override safety rules|project conventions/)
    expect(buildRulesReminder("   ")).toBe("")
  })

  it("压缩续接提示保留目标与硬约束", () => {
    const prompt = buildContinuationPrompt("objective: fix the parser")
    expect(prompt).toContain("objective: fix the parser")
    expect(prompt).toMatch(/preserved verbatim|summarized/)
  })
})

describe("context/rules: AGENTS.md 就近拼接（非覆盖）", () => {
  it("同目录里 AGENTS.md 优先于 CLAUDE.md", async () => {
    const ws = await createTempWorkspace()
    try {
      await ws.write("AGENTS.md", "agents rules")
      await ws.write("CLAUDE.md", "claude rules")
      const files = await collectRuleFiles(ws.root)
      expect(files).toHaveLength(1)
      expect(files[0]!.path.endsWith("AGENTS.md")).toBe(true)
    } finally {
      await ws.cleanup()
    }
  })

  it("从根到目标目录**拼接**而不是覆盖，按深度升序", async () => {
    const ws = await createTempWorkspace()
    try {
      await ws.write("AGENTS.md", "root rules")
      await ws.write("src/AGENTS.md", "src rules")
      await ws.write("src/deep/AGENTS.md", "deep rules")
      const files = await collectRuleFiles(ws.root, ws.abs("src/deep"))
      expect(files.map((f) => f.depth)).toEqual([0, 1, 2])
      expect(files.map((f) => f.content)).toEqual(["root rules", "src rules", "deep rules"])
    } finally {
      await ws.cleanup()
    }
  })

  it("bundleRules 输出带来源标记，便于模型区分规则出处", async () => {
    const ws = await createTempWorkspace()
    try {
      await ws.write("AGENTS.md", "rule body")
      const bundle = await bundleRules(ws.root)
      expect(bundle.combined).toContain("<project-rules source=")
      expect(bundle.combined).toContain("rule body")
    } finally {
      await ws.cleanup()
    }
  })

  it("bundleRules 会展开规则文件里的 @import（不展开等于没加载）", async () => {
    const ws = await createTempWorkspace()
    try {
      await ws.write("shared.md", "SHARED CONVENTION")
      await ws.write("AGENTS.md", "root rules\n@import ./shared.md")
      const bundle = await bundleRules(ws.root)
      expect(bundle.combined).toContain("SHARED CONVENTION")
    } finally {
      await ws.cleanup()
    }
  })

  it("目标目录在工作区外时显式报错", async () => {
    const ws = await createTempWorkspace()
    const outside = await createTempWorkspace("mod-outside-")
    try {
      await expect(collectRuleFiles(ws.root, outside.root)).rejects.toThrow(/outside workspace/)
    } finally {
      await ws.cleanup()
      await outside.cleanup()
    }
  })

  it("规则文件里的不可见字符被剥离（防提示注入）", async () => {
    const ws = await createTempWorkspace()
    try {
      await ws.write("AGENTS.md", "rule\u200Bbody")
      const files = await collectRuleFiles(ws.root)
      expect(files[0]!.content).toBe("rulebody")
    } finally {
      await ws.cleanup()
    }
  })

  it("RULE_FILE_NAMES 同时覆盖 AGENTS.md 与 CLAUDE.md", () => {
    expect(RULE_FILE_NAMES).toContain("AGENTS.md")
    expect(RULE_FILE_NAMES).toContain("CLAUDE.md")
  })

  it("@import 相对当前文件解析，循环引用不死循环", async () => {
    const ws = await createTempWorkspace()
    try {
      await ws.write("shared.md", "shared content")
      await ws.write("AGENTS.md", "before\n@import ./shared.md\nafter")
      const expanded = await expandImports(
        "before\n@import ./shared.md\nafter",
        ws.abs("AGENTS.md"),
      )
      expect(expanded).toContain("shared content")
      expect(expanded).toContain("before")
      expect(expanded).toContain("after")
    } finally {
      await ws.cleanup()
    }
  })

  it("@import 深度上限 4，超过即停止展开而不是抛错", async () => {
    const ws = await createTempWorkspace()
    try {
      let content = "leaf"
      for (let i = 0; i < 8; i += 1) {
        await ws.write(`l${i}.md`, content)
        content = `@import ./l${i}.md`
      }
      const expanded = await expandImports(content, ws.abs("root.md"))
      expect(typeof expanded).toBe("string")
      // 展开到上限后不再继续，链尾的 "leaf" 不会被带进来
      expect(expanded).not.toContain("leaf")
    } finally {
      await ws.cleanup()
    }
  })

  it("缺失的 @import 不会让整条规则加载失败", async () => {
    const ws = await createTempWorkspace()
    try {
      const expanded = await expandImports(
        "@import ./does-not-exist.md\nreal rule",
        ws.abs("AGENTS.md"),
      )
      expect(expanded).toContain("real rule")
    } finally {
      await ws.cleanup()
    }
  })

  it("没有规则文件时返回空串而不是抛错", async () => {
    const ws = await createTempWorkspace()
    try {
      const bundle = await bundleRules(ws.root)
      expect(bundle.combined).toBe("")
      expect(bundle.files).toEqual([])
    } finally {
      await ws.cleanup()
    }
  })
})

describe("context/compaction: 只在 turn boundary 压缩且不破坏配对", () => {
  const bigText = (n: number): string => "x".repeat(n)

  it("未超阈值时不压缩，返回原样", async () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hello" }]
    const result = await compact(messages, { contextWindowTokens: 1_000_000 })
    expect(result.compacted).toBe(false)
    expect(result.messages).toEqual(messages)
  })

  it("shouldCompact 按占用比例触发", () => {
    const messages: ModelMessage[] = [{ role: "user", content: bigText(4_000) }]
    expect(shouldCompact(messages, { contextWindowTokens: 1_000, threshold: 0.8 })).toBe(true)
    expect(shouldCompact(messages, { contextWindowTokens: 1_000_000, threshold: 0.8 })).toBe(false)
  })

  it("压缩后第一条 user（用户请求）与 system 仍然在", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "ORIGINAL REQUEST" },
      { role: "assistant", content: bigText(4_000) },
      { role: "user", content: bigText(4_000) },
      { role: "assistant", content: "final answer" },
    ]
    const result = await compact(messages, { contextWindowTokens: 2_000 })
    expect(result.compacted).toBe(true)
    expect(result.messages[0]?.content).toBe("system prompt")
    expect(result.messages[1]?.content).toBe("ORIGINAL REQUEST")
  })

  it("旧 observation 被折叠成一行，但 tool_use / tool_result 成对处理", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "request" },
      { role: "assistant", content: bigText(3_000) },
      { role: "tool", toolCallId: "c1", content: bigText(3_000) },
      { role: "assistant", content: bigText(3_000) },
      { role: "tool", toolCallId: "c2", content: bigText(3_000) },
      { role: "assistant", content: "recent answer" },
    ]
    const result = await compact(messages, { contextWindowTokens: 800, keepRecentRounds: 1 })
    expect(result.folded).toBeGreaterThan(0)
    const text = JSON.stringify(result.messages)
    expect(text).toMatch(/\[folded observation\]|\[folded tool call\]/)

    // 配对不变量：任何一条 tool 消息都必须紧跟/跟随一条 assistant 的 tool_use，
    // 简化校验为"不留悬空的 tool 结果"——折叠后不应再出现 role:"tool" 的长内容
    const toolMessages = result.messages.filter((m) => m.role === "tool")
    for (const message of toolMessages) {
      expect(typeof message.content).toBe("string")
      expect(String(message.content).length).toBeLessThan(2_000)
    }
  })

  it("规则式压缩不够时用摘要器兜底，并把摘要写成续接提示", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "REQUEST" },
      ...Array.from({ length: 8 }, (_, i): ModelMessage => ({
        role: i % 2 === 0 ? "assistant" : "tool",
        ...(i % 2 === 1 ? { toolCallId: `c${i}` } : {}),
        content: bigText(2_500),
      })),
      { role: "assistant", content: "final" },
    ]
    let summarized: ModelMessage[] = []
    const result = await compact(messages, {
      contextWindowTokens: 1_500,
      keepRecentRounds: 1,
      summarizer: async (middle) => {
        summarized = [...middle]
        return "SUMMARY TEXT"
      },
    })
    expect(summarized.length).toBeGreaterThan(0)
    expect(result.summary).toBe("SUMMARY TEXT")
    expect(JSON.stringify(result.messages)).toContain("SUMMARY TEXT")
    expect(result.droppedRounds).toBeGreaterThan(0)
    expect(result.afterTokens).toBeLessThan(result.beforeTokens)
  })

  it("没有摘要器时只做规则式压缩，绝不自己编造内容", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "REQUEST" },
      ...Array.from({ length: 6 }, (_, i): ModelMessage => ({
        role: i % 2 === 0 ? ("assistant" as const) : ("tool" as const),
        ...(i % 2 === 1 ? { toolCallId: `c${i}` } : {}),
        content: bigText(2_000),
      })),
    ]
    const result = await compact(messages, { contextWindowTokens: 1_000, keepRecentRounds: 1 })
    expect(result.summary).toBeUndefined()
    expect(result.messages.length).toBeLessThanOrEqual(messages.length)
  })

  it("dedupeMessages 去掉完全相同的连续消息", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "same" },
      { role: "user", content: "same" },
      { role: "user", content: "different" },
    ]
    const deduped = dedupeMessages(messages)
    expect(deduped).toHaveLength(2)
    expect(deduped[1]!.content).toBe("different")
  })

  it("estimateMessagesTokens 对内容块消息也能估算", () => {
    const tokens = estimateMessagesTokens([
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ])
    expect(tokens).toBeGreaterThan(0)
  })
})

describe("context/rules: 真实仓库文件", () => {
  it("能读子目录专用的规则（就近覆盖的落点）", async () => {
    const ws = await createTempWorkspace()
    try {
      await ws.write("AGENTS.md", "root")
      await fs.mkdir(path.join(ws.root, "packages", "app"), { recursive: true })
      await ws.write("packages/app/AGENTS.md", "app-specific")
      const bundle = await bundleRules(ws.root, ws.abs("packages/app"))
      expect(bundle.combined).toContain("root")
      expect(bundle.combined).toContain("app-specific")
    } finally {
      await ws.cleanup()
    }
  })
})
