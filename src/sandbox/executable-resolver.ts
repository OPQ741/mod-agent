/**
 * 可执行文件解析：解决 Windows 上 `npm` / `npx` / `yarn` 这类 `.cmd` shim 无法 spawn 的问题。
 *
 * 症状：`spawn("npm", [], { shell: false })` 在 Windows 上直接 `ENOENT` ——
 * `npm` 不是 .exe，而是 `npm.cmd`，而 `shell: false` 不会做 PATHEXT 解析。
 *
 * 更麻烦的第二层：**不能**"拼出 `npm.cmd` 绝对路径再直接 spawn"。
 * Node ≥ 18.20 / 20.12 起对 `.cmd`/`.bat` 有安全修复（CVE-2024-27980），
 * 不经 shell 执行批处理会抛 `EINVAL`。所以必须显式经 `cmd.exe` 包装 ——
 * 但**仍然不许 `shell: true`**：`shell: true` 会把整段命令字符串交给 shell，
 * 参数边界消失，注入面从"参数"变成"任意命令"。
 *
 * 参数安全策略：**只拒绝，不转义**。
 * `cmd.exe` 的引号规则（`/s` 剥引号、`%VAR%` 预处理展开、`!` 延迟展开、`^` 转义）
 * 不存在可靠的正向转义方案；"我觉得我转义对了"正是这一类 CVE 的来源。
 * 命中 `& | < > ^ " ! % ( )` 或换行的参数一律 `COMMAND_DENIED`，
 * 并提示改用非 shim 入口或 Docker 后端。
 */

import path from "node:path"
import { promises as fs } from "node:fs"
import { AppError } from "../shared/errors.js"

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD"

/**
 * `cmd.exe` 里有特殊含义、且无法可靠转义的字符。
 * 注意 `(` `)` 也在内：`cmd /c` 会把它当成命令块起始，普通命令里出现就说明参数不该走这条路。
 */
const CMD_HOSTILE = /[&|<>^"!%()\r\n]/

/** 需要经 `cmd.exe` 包装的扩展名。 */
const BATCH_EXTENSIONS = new Set([".bat", ".cmd"])

export interface ExecutableResolution {
  /** 真正交给 `spawn` 的可执行文件。 */
  command: string
  /** 真正交给 `spawn` 的参数（`.cmd` 时是 `cmd.exe` 的开关 + 完整命令行）。 */
  args: readonly string[]
  /** 是否经 `cmd.exe` 包装；`spawn` 时需配 `windowsVerbatimArguments: true`。 */
  viaCmdHost: boolean
  /** 命中的 shim 绝对路径（诊断与日志用）。 */
  shimPath?: string
}

export interface ResolveOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** 解析相对可执行文件名的基准目录（默认当前进程 cwd）。 */
  cwd?: string
}

/**
 * 解析可执行文件。非 Windows 平台原样返回（不做 PATHEXT 查找，保留原有 PATH 语义）。
 * 找不到时不抛错：让 `spawn` 自然报 ENOENT，报错信息更贴近用户实际环境。
 */
export async function resolveExecutable(
  executable: string,
  args: readonly string[],
  options: ResolveOptions = {},
): Promise<ExecutableResolution> {
  const platform = options.platform ?? process.platform
  if (platform !== "win32") {
    return { command: executable, args, viaCmdHost: false }
  }

  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const shim = await findWindowsExecutable(executable, { env, cwd })
  if (!shim) return { command: executable, args, viaCmdHost: false }

  const ext = path.extname(shim).toLowerCase()
  if (!BATCH_EXTENSIONS.has(ext)) {
    return { command: shim, args, viaCmdHost: false, shimPath: shim }
  }

  return buildCmdHostInvocation(shim, args, env)
}

async function findWindowsExecutable(
  executable: string,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<string | undefined> {
  const { env, cwd } = context
  const pathext = (env.PATHEXT ?? DEFAULT_PATHEXT)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)

  const bases: string[] = []
  if (/[\\/]/.test(executable)) {
    bases.push(path.resolve(cwd, executable))
  } else {
    for (const dir of (env.PATH ?? "").split(";")) {
      if (dir.trim().length > 0) bases.push(path.join(dir.trim(), executable))
    }
    // Windows 的查找顺序里当前目录优先于 PATH；显式补上，避免与 shell 行为不一致
    bases.push(path.join(cwd, executable))
  }

  for (const base of bases) {
    if (path.extname(base).length > 0) {
      // 显式带扩展名：直接验证该文件存在（避免把 `npm.cmd` 变成 `npm.cmd.exe`）
      if (await isFile(base)) return base
      continue
    }

    // 无扩展名：Windows 上只有 PATHEXT 里的后缀才是真正可 spawn 的。
    // 不能先 `isFile(base)` 就返回 —— PATH 里可能存在无后缀的 POSIX shim
    // （Git Bash / nvm 的 `npm`），`spawn(..., shell: false)` 直接起它会失败，
    // 而同目录下的 `npm.cmd` 才是 Windows 可用的入口。
    for (const ext of pathext) {
      const candidate = `${base}${ext}`
      if (await isFile(candidate)) return candidate
    }
  }
  return undefined
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate)
    return stat.isFile()
  } catch {
    return false
  }
}

/**
 * 构造 `cmd.exe /d /s /c ""shim" "arg1" "arg2""`。
 *
 * `/d` 跳过 AutoRun，`/s` 要求剥离最外层引号后按原样解释，
 * 最外层的双引号是为了让含空格的 shim 路径整段被当作一个 token（标准写法）。
 */
function buildCmdHostInvocation(
  shim: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ExecutableResolution {
  for (const arg of args) {
    if (CMD_HOSTILE.test(arg)) {
      throw new AppError(
        "COMMAND_DENIED",
        `Refusing to pass argument containing cmd.exe metacharacters to the batch shim "${path.basename(shim)}": ${arg}. ` +
          "Batch files cannot receive such arguments without a shell, and escaping them reliably is not possible. " +
          "Use a non-batch entry point, or run this command in the Docker sandbox backend.",
        { details: { shim, argument: arg } },
      )
    }
  }

  const inner = [`"${shim}"`, ...args.map((arg) => `"${arg}"`)].join(" ")
  const commandLine = `"${inner}"`
  return {
    command: env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
    viaCmdHost: true,
    shimPath: shim,
  }
}
