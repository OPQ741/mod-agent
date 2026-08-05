#!/usr/bin/env node
/**
 * 校验 docs/ 下 Markdown 文档的页内/跨页锚点链接。
 *
 * 为什么需要这个脚本：
 * VitePress 没有使用 GitHub 的 heading slug 算法，而是自带 slugify
 * （数字开头加下划线、标点转横线、NFKD 归一化），markdownlint 的 MD051
 * 会误报这些链接。本脚本按 VitePress 1.x 的真实 slug 规则计算锚点，
 * 校验「#fragment」「./xxx.md#fragment」「/xxx#fragment」三类链接。
 *
 * 用法：node scripts/verify-doc-links.mjs
 * 退出码：存在失效链接时为 1。
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const docsRoot = resolve(scriptDir, "..", "docs")

// ---- 与 VitePress 1.x 完全一致的 slugify 实现 ----
// 来源：vitepress/dist/node chunk 中的 slugify（rControl / rSpecial / rCombining）
// 与 VitePress 源码完全一致，控制字符范围需要显式保留
// eslint-disable-next-line no-control-regex
const rControl = /[\u0000-\u001f]/g
const rSpecial = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g
const rCombining = /[\u0300-\u036f]/g

function vitePressSlugify(str) {
  return str
    .normalize("NFKD")
    .replace(rCombining, "")
    .replace(rControl, "")
    .replace(rSpecial, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "_$1")
    .toLowerCase()
}

// ---- Markdown 解析辅助 ----

/** 去掉行内代码片段，避免把代码里的内容当链接 */
function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, "")
}

/**
 * 提取标题纯文本（对应 markdown-it getTokensText 的行为：
 * 只保留 text/code_inline 内容，去掉强调标记与链接语法）
 */
function headingText(raw) {
  return raw
    .replace(/`/g, "") // 行内代码：内容保留、反引号去掉（getTokensText 行为）
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // 图片 -> alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // 链接 -> 文字
    .replace(/<[^>]+>/g, "") // HTML 标签
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **粗体**
    .replace(/__([^_]+)__/g, "$1") // __粗体__
    .replace(/\*([^*]+)\*/g, "$1") // *斜体*
    .replace(/(^|[^\w])_([^_]+)_(?![\w])/g, "$1$2") // _斜体_（不动词中的下划线）
    .replace(/~~([^~]+)~~/g, "$1") // ~~删除线~~
    .trim()
}

/** 收集一个文档内的全部标题 slug（含重复标题的 -1/-2 后缀） */
function collectSlugs(lines) {
  const slugs = new Set()
  const used = new Map()
  let inFence = false
  let fenceMarker = ""

  for (const line of lines) {
    const fenceMatch = /^(\s*)(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[2][0]
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (marker === fenceMarker) {
        inFence = false
        fenceMarker = ""
      }
      continue
    }
    if (inFence) continue

    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (!m) continue

    // 支持显式锚点 {#custom-id}
    const explicit = /\{#([^}]+)\}\s*$/.exec(m[1])
    const slug = explicit ? explicit[1] : vitePressSlugify(headingText(m[1]))
    let finalSlug = slug
    // 与 markdown-it-anchor 的 uniqueSlugStartIndex=1 行为一致
    if (used.has(slug)) {
      const i = used.get(slug)
      finalSlug = `${slug}-${i}`
      used.set(slug, i + 1)
    } else {
      used.set(slug, 1)
    }
    slugs.add(finalSlug)
  }
  return slugs
}

const LINK_RE = /(?<!!)\[(?<text>[^\]]*)\]\(<?(?<url>[^)>\s]+)(?:\s+["'][^"']*["'])?>?\)/g

/** 提取文件中需要校验的链接（排除代码块、行内代码、外部协议） */
function collectLinks(lines) {
  const links = []
  let inFence = false
  let fenceMarker = ""

  lines.forEach((line, idx) => {
    const fenceMatch = /^(\s*)(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[2][0]
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

    const content = stripInlineCode(line)
    let m
    while ((m = LINK_RE.exec(content)) !== null) {
      links.push({ line: idx + 1, url: m.groups.url, text: m.groups.text })
    }
  })
  return links
}

function walkMd(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "cache" || name === "dist") continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walkMd(full))
    else if (name.endsWith(".md")) out.push(full)
  }
  return out.sort()
}

// VitePress 的「整洁链接」：/foo -> docs/foo.md，/foo/ -> docs/foo/index.md
function resolvePage(base, fromFile) {
  if (base.startsWith("/")) {
    const clean = base.slice(1)
    const candidates = [
      join(docsRoot, `${clean}.md`),
      join(docsRoot, clean, "index.md"),
      join(docsRoot, clean),
    ]
    return candidates.find((p) => existsSync(p)) ?? null
  }
  const rel = base.startsWith("./") || base.startsWith("../") ? base : `./${base}`
  const target = resolve(dirname(fromFile), rel)
  const candidates = [
    target,
    target.endsWith(".md") ? target : `${target}.md`,
    join(target, "index.md"),
  ]
  return candidates.find((p) => existsSync(p) && statSync(p).isFile()) ?? null
}

// ---- 主流程 ----
const files = walkMd(docsRoot)
const slugCache = new Map()
const getSlugs = (file) => {
  if (!slugCache.has(file)) {
    slugCache.set(file, collectSlugs(readFileSync(file, "utf8").split(/\r?\n/)))
  }
  return slugCache.get(file)
}

const errors = []
const EXTERNAL = /^(https?:|mailto:|tel:|vscode:|#$)/

for (const file of files) {
  const rel = file.replace(docsRoot, "docs").replace(/\\/g, "/")
  const lines = readFileSync(file, "utf8").split(/\r?\n/)
  for (const link of collectLinks(lines)) {
    const rawUrl = link.url
    if (EXTERNAL.test(rawUrl)) continue
    if (/\.(png|jpe?g|gif|svg|webp|ico|pdf|zip)$/i.test(rawUrl)) continue

    const hashIdx = rawUrl.indexOf("#")
    const base = hashIdx === -1 ? rawUrl : rawUrl.slice(0, hashIdx)
    const fragment = hashIdx === -1 ? "" : decodeURIComponent(rawUrl.slice(hashIdx + 1))

    if (!base) {
      // 纯页内锚点
      if (fragment && !getSlugs(file).has(fragment)) {
        errors.push(`${rel}:${link.line} 页内锚点不存在 #${fragment}（[${link.text}]）`)
      }
      continue
    }

    const targetFile = resolvePage(base, file)
    if (!targetFile) {
      errors.push(`${rel}:${link.line} 目标页面不存在 ${base}（[${link.text}]）`)
      continue
    }
    if (fragment && !getSlugs(targetFile).has(fragment)) {
      const targetRel = targetFile.replace(docsRoot, "docs").replace(/\\/g, "/")
      errors.push(`${rel}:${link.line} 锚点不存在于 ${targetRel}：#${fragment}（[${link.text}]）`)
    }
  }
}

if (errors.length > 0) {
  console.error(`\n发现 ${errors.length} 个失效链接：\n`)
  for (const e of errors) console.error(`  ✗ ${e}`)
  process.exit(1)
}

console.log(`✓ 校验 ${files.length} 个文档，页面链接与锚点全部有效`)
