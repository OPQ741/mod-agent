#!/usr/bin/env node
/**
 * 校验 AGENTS.md 中引用的 npm run 脚本真实存在于 package.json。
 *
 * 为什么需要这个脚本：
 * AGENTS.md 是给 AI 编码代理看的操作手册，里面的命令必须可照抄运行。
 * 一旦某个脚本被重命名或删除而 AGENTS.md 忘记同步，代理会照着旧命令执行并报错。
 * 本脚本把「命令保持有效」从软约定变成 CI 可发现的硬约束（跳过围栏代码块，
 * 只校验行内 `npm run xxx` 形式的命令引用）。
 *
 * 用法：node scripts/verify-agents-md-commands.mjs
 * 退出码：存在失效命令引用时为 1。
 */

import { readFileSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "..")
const agentsPath = resolve(repoRoot, "AGENTS.md")
const pkgPath = resolve(repoRoot, "package.json")

if (!existsSync(agentsPath)) {
  console.error("✗ 找不到 AGENTS.md，无法校验命令引用")
  process.exit(1)
}

const scripts = Object.keys(JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {})
const scriptSet = new Set(scripts)

// 逐行扫描，跳过 ``` / ~~~ 围栏代码块，只在正文里抓 `npm run <name>` 行内命令
const lines = readFileSync(agentsPath, "utf8").split(/\r?\n/)
let inFence = false
let fenceMarker = ""

const refs = [] // { line, name }
lines.forEach((rawLine, idx) => {
  const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(rawLine)
  if (fenceMatch) {
    const marker = fenceMatch[1][0]
    if (!inFence) {
      inFence = true
      fenceMarker = marker
    } else if (marker === fenceMarker) {
      inFence = false
      fenceMarker = ""
    }
    return
  }
  if (inFence) return

  // 只统计反引号包裹的命令，避免误伤普通叙述
  const codeSpans = rawLine.matchAll(/`([^`]+)`/g)
  for (const span of codeSpans) {
    const m = /^\s*npm\s+run\s+([A-Za-z0-9._:-]+)\b/.exec(span[1])
    if (m) refs.push({ line: idx + 1, name: m[1] })
  }
})

const errors = []
const uniqueNames = new Set(refs.map((ref) => ref.name))
const reported = new Set()
for (const ref of refs) {
  if (scriptSet.has(ref.name) || reported.has(ref.name)) continue
  reported.add(ref.name)
  errors.push(`AGENTS.md:${ref.line} 引用了不存在的脚本 npm run ${ref.name}`)
}

if (errors.length > 0) {
  console.error(`\nAGENTS.md 命令校验失败，发现 ${errors.length} 处失效引用：\n`)
  for (const e of errors) console.error(`  ✗ ${e}`)
  console.error(`\n可用脚本：${scripts.join(", ")}`)
  process.exit(1)
}

console.log(`✓ 校验 AGENTS.md 中 ${uniqueNames.size} 个唯一命令引用，均存在于 package.json scripts`)
