/**
 * 输入净化与输出脱敏。
 *
 * 三条来自文档的硬要求：
 * 1. security.md §1 —— 从网页 / issue / 聊天复制粘贴的文本可能携带不可见字符
 *    （零宽空格 U+200B/U+200D、双向控制符 U+202A–U+202E、Unicode Tag 段 U+E0000+），
 *    肉眼看不到但会改变模型对文本结构的解析。剥离时必须告诉用户剥离了多少。
 * 2. security.md §5 —— 密钥只在需要的服务端工具中短暂使用；日志与模型上下文做脱敏。
 * 3. security.md §3 —— 对输出中的 ANSI 控制符、二进制、超长日志做处理，
 *    防终端 / UI 注入与资源耗尽。
 */

/**
 * 不可见 / 双向 / Unicode Tag 字符。
 *
 * 星号位必须写成 `\u{E0000}-\u{E007F}`：JavaScript 的 `\uXXXX` 只吃 4 位十六进制，
 * `\uE0000` 会被切成 `\uE000` 加一个 `0`，字符类里于是剩下 `0-\uE007`
 * —— 那是个几乎覆盖全部可见字符的巨大区间，会把用户输入的正文整段剥没。
 * 这里的坑只在 5 位以上码位出现，所以 Unicode Tag 段用 `\u{...}` 语法。
 */
const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu

/** 保留换行、制表符与常见宽字符，其余控制字符一律剥离。 */
export interface SanitizeResult {
  text: string
  removed: number
  /** 被剥离字符的 Unicode 码位，用于提示用户"review"。 */
  categories: string[]
}

export function stripInvisibleCharacters(input: string): SanitizeResult {
  let removed = 0
  const seen = new Set<string>()
  const text = input.replace(INVISIBLE, (ch) => {
    removed += 1
    const cp = ch.codePointAt(0)
    if (cp === undefined) return ""
    if (cp === 0x200b || cp === 0x200c || cp === 0x200d) seen.add("zero-width")
    else if (cp >= 0x202a && cp <= 0x202e) seen.add("bidi-control")
    else if (cp >= 0xe0000 && cp <= 0xe007f) seen.add("unicode-tag")
    else if (cp === 0xfeff) seen.add("bom")
    else seen.add("control")
    return ""
  })
  return { text, removed, categories: [...seen].sort() }
}

/** 给用户看的提示文案（对齐 Claude Code 的 "Removed N invisible characters"）。 */
export function describeSanitize(result: SanitizeResult): string | undefined {
  if (result.removed === 0) return undefined
  return `Removed ${result.removed} invisible character${
    result.removed === 1 ? "" : "s"
  } (${result.categories.join(", ")}) · review before sending`
}

/** ANSI 转义序列（终端注入与日志污染）。 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;]*[A-Za-z]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/gu

export function stripAnsi(input: string): string {
  return input.replace(ANSI, "")
}

/** 判断一段文本是否像二进制（含大量 NUL 或不可打印字符）。 */
export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  let suspicious = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1
  }
  return suspicious / Math.max(1, sample.length) > 0.3
}

const REDACTIONS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // 顺序有意义：先匹配更具体的形状。`sk-ant-...` 同样满足 OpenAI 的 `sk-...` 模式，
  // 若把通用规则排在前，Anthropic 的密钥会被错报成 OPENAI_KEY。
  { name: "ANTHROPIC_KEY", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "OPENAI_KEY", pattern: /sk-(?!ant-)[A-Za-z0-9_-]{16,}/g },
  { name: "GITHUB_TOKEN", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: "AWS_ACCESS_KEY", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    name: "PRIVATE_KEY",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { name: "BEARER", pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/g },
  {
    name: "GENERIC_ASSIGN",
    pattern: /\b(api[_-]?key|apikey|secret|token|password|passwd|pwd)\s*[:=]\s*["']?[^"'\s]{8,}/gi,
  },
]

export interface RedactResult {
  text: string
  /** 命中的密钥类别，便于审计（不记录密钥本身）。 */
  hits: string[]
}

/** 脱敏：把疑似密钥替换成占位符，只保留类别名。 */
export function redactSecrets(input: string): RedactResult {
  const hits = new Set<string>()
  let text = input
  for (const { name, pattern } of REDACTIONS) {
    const re = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    )
    text = text.replace(re, (_match) => {
      hits.add(name)
      return `[REDACTED:${name}]`
    })
  }
  return { text, hits: [...hits].sort() }
}

/** 环境变量白名单：只有这些变量允许透传给命令执行层（security.md §4）。 */
export const DEFAULT_ENV_ALLOWLIST: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "USER",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SHELL",
  "TERM",
  "COLORTERM",
  "CI",
  "NODE_ENV",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
]

export function filterEnv(
  env: NodeJS.ProcessEnv,
  allowlist: ReadonlyArray<string> = DEFAULT_ENV_ALLOWLIST,
  overrides?: Record<string, string>,
): Record<string, string> {
  const allowed = new Set(allowlist.map((k) => k.toUpperCase()))
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (allowed.has(key.toUpperCase())) out[key] = value
  }
  if (overrides) Object.assign(out, overrides)
  return out
}

/**
 * 可疑密钥环境变量名（即使被显式放进 overrides 也拒绝透传）。
 * 与 tools-and-extensions.md §1.1 的"凭据名模板变量例外"同源。
 */
export const SENSITIVE_ENV_NAMES: ReadonlyArray<string> = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "HTTPS_PROXY",
  "HTTP_PROXY",
]

export function isSensitiveEnvName(name: string): boolean {
  const upper = name.toUpperCase()
  return SENSITIVE_ENV_NAMES.some((n) => n.toUpperCase() === upper)
}
