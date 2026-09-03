/**
 * 权限规则解析与匹配（security.md §4.1 / §4.2，claude-code-guide §5.2–§5.4）。
 *
 * 规则形如 `Tool(pattern)`：
 * - `Bash`                      该工具的一切调用
 * - `Bash(npm run build)`       精确匹配（加了 `--watch` 就不命中）
 * - `Bash(npm run *)`           前缀匹配
 * - `Bash(ls:*) ≡ Bash(ls *)`   官方明确 `:*` 与"尾部空格 + 星号"等价
 * - `Bash(ls*)`                 前缀匹配但**不要求分隔符**，会连带命中 `lsof`
 * - `Read(~/.ssh/**)`           路径 glob（四种锚点）
 * - `WebFetch(domain:*.a.com)`  域名（子域，不含 apex）
 * - `Bash(run_in_background:true)` 参数级
 * - `mcp__server__tool`         MCP 工具（全名）
 *
 * 两个最容易写错的语义，这里显式分开实现：
 * 1. **same pattern 在 allow 与 deny 下深度语义不同**：`Edit(src/**)` 作 allow 时只覆盖
 *    `<cwd>/src`，`Read(secrets/**)` 作 deny 时匹配任意深度。两者不是同一个匹配器。
 * 2. **规则写得具体与否不参与排序**。判定序固定为 deny → ask → allow，先命中者生效。
 */

import path from "node:path"
import os from "node:os"

export type RuleEffect = "allow" | "ask" | "deny"

export type RuleKind = "all" | "exact" | "prefix" | "glob" | "domain" | "param"

export interface PermissionRule {
  raw: string
  tool: string
  kind: RuleKind
  /** glob / exact / prefix 的匹配目标（已按锚点展开为绝对路径或保留相对语义）。 */
  matcher: string
  /** 是否要求分隔符（`ls *` 要求，`ls*` 不要求）。 */
  requireSeparator: boolean
}

const RULE_RE = /^([A-Za-z0-9_\-*.]+)(?:\((.*)\))?$/

/**
 * 解析 `Tool(pattern)`。非法规则直接抛错 —— 权限规则是代码，
 * 解析不了的规则等于没写的规则，静默跳过会留下一个"我以为拦住了"的洞。
 */
export function parseRule(raw: string): PermissionRule {
  const trimmed = raw.trim()
  const match = RULE_RE.exec(trimmed)
  if (!match) {
    throw new Error(`Invalid permission rule: ${JSON.stringify(raw)}`)
  }
  const tool = match[1] ?? ""
  const pattern = match[2]

  if (tool.length === 0) {
    throw new Error(`Invalid permission rule (missing tool name): ${JSON.stringify(raw)}`)
  }
  if (pattern === undefined || pattern.length === 0) {
    return { raw: trimmed, tool, kind: "all", matcher: "*", requireSeparator: false }
  }

  // 参数级：`key:value`
  if (isParamPattern(pattern)) {
    return { raw: trimmed, tool, kind: "param", matcher: pattern, requireSeparator: false }
  }
  // 域名：`domain:...`
  if (pattern.startsWith("domain:")) {
    return {
      raw: trimmed,
      tool,
      kind: "domain",
      matcher: pattern.slice("domain:".length).trim(),
      requireSeparator: false,
    }
  }

  // `ls:*` ≡ `ls *`：把 `:*` 规范成 "空格 + 星号"
  let normalized = pattern
  if (normalized.endsWith(":*")) {
    normalized = `${normalized.slice(0, -2)} *`
  }

  if (!normalized.includes("*")) {
    return { raw: trimmed, tool, kind: "exact", matcher: normalized, requireSeparator: false }
  }

  const requireSeparator = normalized.endsWith(" *")
  let matcher = requireSeparator ? normalized.slice(0, -2) : normalized

  if (!requireSeparator) {
    // 只剥**单层**通配符 `*`，`**`（任意深度）必须原样保留。
    // 一律剥掉会让 `Write(src/**)` 退化成 `Write(src/)`,扂一层子目录都匹配不到，
    // 实际效果是"这条 deny/allow 规则完全不生效"。
    matcher = matcher.replace(/\*+$/, (stars) => (stars.length >= 2 ? stars : ""))
  }

  // `Write(**)` / `Write(*)` 的含义是"这个工具的所有调用"，等价于 `Write`。
  // 不清成空串后按"前缀匹配空串"处理 —— 那种组合会让规则匹配不到任何东西，
  // 表现为"我以为拒了整个工具，其实一条都没挡住"。
  if (matcher.length === 0 || matcher === "**") {
    return { raw: trimmed, tool, kind: "all", matcher: "*", requireSeparator: false }
  }
  return { raw: trimmed, tool, kind: "prefix", matcher, requireSeparator }
}

function isParamPattern(pattern: string): boolean {
  // `run_in_background:true` / `timeout:60000` 这类；域名前缀已单独处理
  if (pattern.startsWith("domain:")) return false
  if (pattern.includes("*") || pattern.includes("/") || pattern.includes(".")) return false
  const idx = pattern.indexOf(":")
  return idx > 0 && idx < pattern.length - 1
}

/* ------------------------------------------------------------------ *
 * 命令匹配
 * ------------------------------------------------------------------ */

/**
 * 命令文本匹配。输入是**剥离 wrapper 后的单段命令文本**（`executable args...`）。
 */
export function matchCommand(rule: PermissionRule, segmentText: string): boolean {
  const text = segmentText.trim()
  switch (rule.kind) {
    case "all":
      return true
    case "exact":
      return text === rule.matcher
    case "prefix": {
      if (rule.requireSeparator) {
        return text === rule.matcher || text.startsWith(`${rule.matcher} `)
      }
      return text.startsWith(rule.matcher)
    }
    default:
      // glob / domain / param 规则不用于命令文本匹配
      return false
  }
}

/* ------------------------------------------------------------------ *
 * 路径匹配
 * ------------------------------------------------------------------ */

export interface PathMatchContext {
  /** 当前工作目录（规则里 `/x` 与裸相对路径的锚点）。 */
  cwd: string
  homeDir: string
}

/**
 * 路径规则匹配。
 *
 * `effect` 决定深度语义 —— 这是本函数最关键的分支：
 * - `allow`：`src/**` 只匹配 `<cwd>/src` 下的内容（收权可以偷懒，放权不行）；
 * - `deny` / `ask`：`secrets/**` 匹配任意深度（写收权规则可以偷懒）。
 */
export function matchPath(
  rule: PermissionRule,
  absolutePath: string,
  effect: RuleEffect,
  ctx: PathMatchContext,
): boolean {
  if (rule.kind === "all") return true

  const resolved = path.resolve(absolutePath)
  const pattern = rule.matcher

  // 四种锚点
  let anchored: string
  if (pattern.startsWith("//")) {
    // 文件系统绝对路径
    anchored = pattern.slice(1)
  } else if (pattern.startsWith("~/")) {
    anchored = path.join(ctx.homeDir, pattern.slice(2))
  } else if (pattern.startsWith("/")) {
    // 相对"含这条规则的 settings 文件所在目录"，这里取 cwd
    anchored = path.join(ctx.cwd, pattern.slice(1))
  } else if (!pattern.includes("/")) {
    // 裸文件名等同 `**/<name>`
    const name = pattern.replace(/^\*\*\//, "")
    return matchAnyDepth(resolved, `**/${name}`)
  } else {
    anchored = path.join(ctx.cwd, pattern)
  }

  if (effect === "allow") {
    // 放权：锚定在展开后的目录下，不做任意深度匹配
    return matchGlob(resolved, anchored, { anyDepth: false })
  }
  // 收权：任意深度
  return matchAnyDepth(resolved, anchored)
}

function matchAnyDepth(resolved: string, anchoredPattern: string): boolean {
  if (matchGlob(resolved, anchoredPattern, { anyDepth: true })) return true
  // `Read(secrets/**)` 作 deny 时匹配任意深度：路径中任意位置出现该目录即命中
  const normalized = anchoredPattern.replace(/\\/g, "/").replace(/\/\*\*$/, "")
  const parts = normalized.split("/").filter((p) => p.length > 0)
  const leaf = parts[parts.length - 1]
  if (leaf && !leaf.includes("*")) {
    const resolvedParts = path.resolve(resolved).replace(/\\/g, "/").split("/")
    return resolvedParts.includes(leaf)
  }
  return false
}

/** 极简 glob：`*` 不跨目录、`**` 跨目录、`?` 单字符。 */
export function matchGlob(
  target: string,
  pattern: string,
  options: { anyDepth?: boolean } = {},
): boolean {
  // 只统一分隔符与盘符大小写，**不用 path.resolve 重新定根**：
  // Windows 上 `path.resolve("/etc/shadow")` 会变成 `D:\etc\shadow`，
  // 于是以 POSIX 绝对路径书写的规则（列表里大部分就是这样写的）全部失效。
  const t = normalizePath(target)
  let p = normalizePath(pattern)
  if (options.anyDepth && !p.includes("**")) {
    // 收权语义：允许前缀路径任意深度
    p = p.replace(/\/\*$/, "/**")
  }
  const regex = globToRegExp(p)
  return regex.test(t)
}

/** 统一分隔符与盘符大小写，供纯字符串匹配使用。 */
export function normalizePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^([A-Za-z]):\//, (_all, drive: string) => `${drive.toLowerCase()}:/`)
}

export function globToRegExp(pattern: string): RegExp {
  let out = "^"
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === undefined) break
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**` 跨目录
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?"
          i += 3
          continue
        }
        out += ".*"
        i += 2
        continue
      }
      out += "[^/]*"
      i += 1
      continue
    }
    if (ch === "?") {
      out += "[^/]"
      i += 1
      continue
    }
    if (ch === "[") {
      const close = pattern.indexOf("]", i)
      if (close > i) {
        out += pattern.slice(i, close + 1)
        i = close + 1
        continue
      }
    }
    out += escapeRegExp(ch)
    i += 1
  }
  return new RegExp(`${out}$`, "i")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/* ------------------------------------------------------------------ *
 * 域名匹配
 * ------------------------------------------------------------------ */

/**
 * 域名匹配（security.md §3.1 / claude-code-guide §5.3）：
 * - `example.com`        精确
 * - `*.example.com`      任意子域，**不含 apex**
 * - `.example.com`       apex + 任意子域
 * - `*`                  全域
 */
export function matchDomain(rule: PermissionRule, host: string): boolean {
  const target = host.toLowerCase().replace(/\.$/, "")
  const pattern = rule.matcher.toLowerCase()
  if (rule.kind === "all") return true
  if (pattern === "*" || pattern === "") return true
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2)
    return target.endsWith(`.${base}`)
  }
  if (pattern.startsWith(".")) {
    const base = pattern.slice(1)
    return target === base || target.endsWith(`.${base}`)
  }
  return target === pattern
}

/* ------------------------------------------------------------------ *
 * 参数级匹配
 * ------------------------------------------------------------------ */

/** `Bash(run_in_background:true)`：对参数对象做单键等值匹配。 */
export function matchParam(rule: PermissionRule, args: Record<string, unknown>): boolean {
  if (rule.kind !== "param") return false
  const idx = rule.matcher.indexOf(":")
  const key = rule.matcher.slice(0, idx)
  const expected: string = rule.matcher.slice(idx + 1)
  const actual = args[key]
  return String(actual) === expected
}

/* ------------------------------------------------------------------ *
 * bypass-immune：任何模式都不自动批准
 * ------------------------------------------------------------------ */

/**
 * bypass-immune 高危路径（security.md §4.2 的最高一档）。
 * 即便会话以 `bypassPermissions` 启动也不豁免。
 */
export const BYPASS_IMMUNE_PATH_GLOBS: ReadonlyArray<string> = [
  "**/.env",
  "**/.env.*",
  "**/id_rsa",
  "**/id_ed25519",
  "**/*.pem",
  "**/*.key",
  "**/.aws/**",
  "**/.ssh/**",
  "**/.gnupg/**",
  "**/.kube/**",
  "**/.docker/config.json",
  "**/.npmrc",
  "**/.netrc",
  "**/.git-credentials",
  "**/credentials.json",
  "**/service-account*.json",
  "**/.mod/settings.json",
  "**/.mod/credentials*",
  "/proc/self/environ",
  "/proc/*/environ",
  "/etc/shadow",
  "/etc/passwd",
]

export function matchesBypassImmunePath(absolutePath: string): boolean {
  // 同时按"原始写法"与"平台原生绝对路径"两副形态匹配：
  // 免疫清单以 POSIX 绝对路径书写（`/etc/shadow`、`/proc/self/environ`），
  // 只用 win32 解析结果比对会在 Windows 上整份清单失效。
  const resolved = normalizePath(path.resolve(absolutePath))
  const asWritten = normalizePath(absolutePath)
  const candidates = asWritten === resolved ? [resolved] : [asWritten, resolved]

  for (const glob of BYPASS_IMMUNE_PATH_GLOBS) {
    for (const candidate of candidates) {
      if (glob.startsWith("/")) {
        if (matchGlob(candidate, glob, { anyDepth: true })) return true
        if (candidate === glob || candidate.startsWith(`${glob}/`)) return true
        continue
      }
      if (matchGlob(candidate, `**/${glob}`, { anyDepth: true })) return true
    }
  }
  return false
}

/** bypass-immune 命令前缀：`bypassPermissions` 也拦。 */
export const BYPASS_IMMUNE_COMMANDS: ReadonlyArray<string> = [
  "sudo",
  "su",
  "rm",
  "rmdir",
  "mkfs",
  "dd",
  "shutdown",
  "reboot",
  "chown",
  "chmod",
  "passwd",
  "visudo",
]

export function matchesBypassImmuneCommand(executable: string): boolean {
  return BYPASS_IMMUNE_COMMANDS.includes(executable)
}

export function homeDir(): string {
  return os.homedir()
}
