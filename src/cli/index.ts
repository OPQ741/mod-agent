/**
 * CLI 入口（ADR-7：CLI-first）。
 *
 * 这里是唯一把"命令行参数 → 配置 → runtime"串起来的地方，业务逻辑一律不写在本文件：
 * 参数解析归 commander，装配归 `session.ts`，推进归 `runtime/driver.ts`。
 * 这样同一套内核既能被 CLI 用，也能被 SDK 直接调（ADR-10）。
 *
 * 退出码（usage.md §4 / agent-loop.md §6.3）：0 成功、1 失败、2 被人打断或挡在审批上。
 */

import os from "node:os"
import path from "node:path"
import { promises as fs } from "node:fs"
import { Command } from "commander"

import { loadSettings } from "../config/settings.js"
import {
  PermissionModeSchema,
  TaskModeSchema,
  type Budget,
  type TaskMode,
} from "../shared/contracts.js"
import { AppError } from "../shared/errors.js"
import { EXIT_ERROR, EXIT_OK } from "../runtime/driver.js"
import { createProcessIo, type CliIo } from "./io.js"
import { CREDENTIAL_ENV, loadScriptFile, resolveProvider } from "./provider.js"
import { parseOutputFormat } from "./render.js"
import { CliSession } from "./session.js"
import { runRepl } from "./repl.js"
import { createInteractivePrompter } from "./approval.js"
import { resolveContextWindowTokens, resolveModelProfile } from "../model/catalog.js"
import {
  createWorktree,
  findRepoRoot,
  listWorktrees,
  removeWorktree,
  worktreeDiff,
  worktreeStatus,
  type WorktreeInfo,
} from "../worktree/index.js"

export interface CliContext {
  env?: NodeJS.ProcessEnv
  io?: CliIo
  cwd?: string
  homeDir?: string
  now?: () => Date
  /** Ctrl-C 用的中断信号；由 `main()` 注入，测试里可以自己控。 */
  signal?: AbortSignal
}

interface GlobalOptions {
  print?: string
  outputFormat?: string
  mode?: string
  permissionMode?: string
  model?: string
  settings?: string
  script?: string
  bare?: boolean
  cwd?: string
  resume?: string
  continue?: boolean
  worktree?: boolean
  noValidation?: boolean
  maxRounds?: string
  maxCost?: string
  /** `--no-stream` 时为 false；默认 true（provider 支持就流式）。 */
  stream?: boolean
  verbose?: boolean
}

export async function runCli(argv: string[], context: CliContext = {}): Promise<number> {
  const env = context.env ?? process.env
  const io =
    context.io ??
    createProcessIo({
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      input: process.stdin,
      isTty: Boolean(process.stdin.isTTY),
    })
  const cwd = context.cwd ?? process.cwd()

  let exitCode: number = EXIT_OK
  const program = new Command()

  program
    .name("mod")
    .description("mod-agent：人在环上的 AI Coding Agent CLI")
    .version(await readVersion(), "-V, --version", "输出版本号")
    .argument("[prompt...]", "需求；不给则进入交互模式")
    .option("-p, --print <prompt>", "headless：单次跑到底，结果打到 stdout")
    .option("-o, --output-format <fmt>", "text | json | stream-json（默认 text）", "text")
    .option("-m, --mode <mode>", "任务模式：ask | plan | edit | autopilot")
    .option(
      "--permission-mode <mode>",
      "权限档位：default | acceptEdits | plan | auto | dontAsk | bypassPermissions",
    )
    .option("--model <id>", "指定模型")
    .option("--settings <file|json>", "额外一层配置（文件或内联 JSON）")
    .option("--script <file>", "离线回放：按文件里的决策序列跑，不联网")
    .option("--bare", "无人值守最小面：不加载项目规则、不自动发现验证命令")
    .option("-C, --cwd <dir>", "工作区目录")
    .option("--resume <id>", "从检查点恢复指定任务")
    .option("--continue", "接着本工作区最近一个任务跑")
    .option("--worktree / --no-worktree", "在独立 git worktree 中执行任务，改动不落在主检出")
    .option("--no-validation", "交付前不跑验证命令")
    /**
     * 只注册否定形式。commander 里 `--no-stream` 会自动把 `stream` 字段声明为
     * 默认 `true` 的布尔值；再额外注册一个 `--stream` 会与它争同一个字段，
     * 得不偿失。"能流就流"本来就是默认，不需要一个显式开启的开关。
     */
    .option("--no-stream", "关闭流式：等完整响应再输出（回放、排查不认 SSE 的兼容端点时用）")
    .option("--max-rounds <n>", "覆盖预算：最大轮次")
    .option("--max-cost <usd>", "覆盖预算：最大花费")
    .option("-v, --verbose", "输出调试日志")
    .exitOverride()
    .configureOutput({ writeOut: (text) => io.out(text), writeErr: (text) => io.err(text) })
    .action(async (promptArgs: string[], options: GlobalOptions) => {
      /**
       * 只有用户**显式**写了 `--worktree` / `--no-worktree` 才把它当作用户意图；
       * 没写时交给配置里的 `worktree` 决定。用 `getOptionValueSource` 区分两者，
       * 否则"默认值 false"会覆盖项目配置里打开的 worktree。
       */
      const worktreeExplicit =
        program.getOptionValueSource("worktree") === "cli" ? options.worktree === true : undefined
      exitCode = await executeMain({
        promptArgs,
        options,
        io,
        env,
        cwd,
        ...(worktreeExplicit !== undefined ? { worktreeExplicit } : {}),
        ...(context.homeDir ? { homeDir: context.homeDir } : {}),
        ...(context.now ? { now: context.now } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      })
    })

  program
    .command("doctor")
    .description("只读诊断：配置、存储、沙箱、工具、凭证")
    .option("--json", "输出 JSON")
    .action(async (options: { json?: boolean }) => {
      exitCode = await executeDoctor({
        io,
        env,
        cwd: resolveCwd(options, program, cwd),
        // `--settings` 与 `-C` 一样会被子命令吞掉，得回 program 上取
        cliSettings: (program.opts() as { settings?: string }).settings,
        homeDir: context.homeDir,
        asJson: Boolean(options.json),
      })
    })

  const config = program.command("config").description("查看生效配置与分层来源")
  config
    .command("show")
    .description("打印合并后的生效配置")
    .option("--json", "输出 JSON")
    .action(async (options: { json?: boolean }) => {
      exitCode = await executeConfig({
        io,
        env,
        cwd: resolveCwd(options, program, cwd),
        cliSettings: (program.opts() as { settings?: string }).settings,
        homeDir: context.homeDir,
        asJson: Boolean(options.json),
      })
    })

  const worktree = program
    .command("worktree")
    .description("管理 --worktree 创建的独立检出（只清理 .mod-worktrees 下的托管目录）")
  worktree
    .command("diff <task>")
    .description("查看某个托管检出里的未提交改动（任务 id / 分支名 / 目录名任选其一）")
    .option("--stat", "只看改动统计，不输出完整 diff")
    .option("-C, --cwd <dir>", "工作区目录")
    .action(async (task: string, options: { stat?: boolean; cwd?: string }) => {
      exitCode = await executeWorktreeDiff({
        io,
        cwd: resolveCwd(options, program, cwd),
        target: task,
        stat: Boolean(options.stat),
      })
    })
  worktree
    .command("list")
    .description("列出当前仓库托管的所有 worktree")
    .option("--json", "输出 JSON")
    .option("-C, --cwd <dir>", "工作区目录")
    .action(async (options: { json?: boolean; cwd?: string }) => {
      exitCode = await executeWorktreeList({
        io,
        cwd: resolveCwd(options, program, cwd),
        asJson: Boolean(options.json),
      })
    })
  worktree
    .command("clean")
    .description("删除托管 worktree；有未提交改动 / 未合并提交时默认跳过")
    .option("--force", "连同未提交改动、未合并分支一起删除（会丢工作）")
    .option("-C, --cwd <dir>", "工作区目录")
    .action(async (options: { force?: boolean; cwd?: string }) => {
      exitCode = await executeWorktreeClean({
        io,
        cwd: resolveCwd(options, program, cwd),
        force: Boolean(options.force),
      })
    })

  try {
    await program.parseAsync(argv, { from: "user" })
    return exitCode
  } catch (err) {
    if (isCommanderError(err)) {
      // --help / --version 走的是"正常退出"，不该报成失败
      return typeof err.exitCode === "number" ? err.exitCode : EXIT_ERROR
    }
    return reportFailure(io, err)
  }
}

/* ------------------------------------------------------------------ *
 * 主命令
 * ------------------------------------------------------------------ */

interface ExecuteMainInput {
  promptArgs: string[]
  options: GlobalOptions
  io: CliIo
  env: NodeJS.ProcessEnv
  cwd: string
  /** 用户显式给了 `--worktree` / `--no-worktree`；undefined 表示交给配置。 */
  worktreeExplicit?: boolean
  homeDir?: string
  now?: () => Date
  signal?: AbortSignal
}

async function executeMain(input: ExecuteMainInput): Promise<number> {
  const { io, env, options } = input
  /** 用户所在的主检出：配置、状态文件、worktree 的基准都以它为准。 */
  const baseWorkspaceRoot = path.resolve(options.cwd ?? input.cwd)
  const format = parseOutputFormat(options.outputFormat)

  const loaded = await loadSettings({
    cwd: baseWorkspaceRoot,
    ...(options.settings ? { cliSettings: options.settings } : {}),
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
  })
  for (const warning of loaded.warnings) io.err(`[配置] ${warning}\n`)

  let settings = loaded.settings
  if (options.model) settings = { ...settings, model: options.model }
  if (options.permissionMode) {
    const parsed = PermissionModeSchema.safeParse(options.permissionMode)
    if (!parsed.success) {
      io.err(`--permission-mode 非法：${options.permissionMode}\n`)
      return EXIT_ERROR
    }
    settings = { ...settings, permissionMode: parsed.data }
  }

  let mode: TaskMode | undefined
  if (options.mode) {
    const parsed = TaskModeSchema.safeParse(options.mode)
    if (!parsed.success) {
      io.err(`--mode 非法：${options.mode}（可选 ask | plan | edit | autopilot）\n`)
      return EXIT_ERROR
    }
    mode = parsed.data
  }

  /**
   * 独立 worktree：CLI 显式开关优先，其次读项目配置。
   *
   * 会话与任务都跑在 worktree 里，但**状态文件留在主检出**：
   * worktree 随时可能被删除，把任务历史写进去等于把历史一起删掉。
   */
  let workspaceRoot = baseWorkspaceRoot
  let worktree: WorktreeInfo | undefined
  const wantWorktree = input.worktreeExplicit ?? settings.worktree ?? false
  if (wantWorktree && (options.resume || options.continue)) {
    io.err("--worktree 不能与 --resume / --continue 组合：恢复的任务属于它原本的工作区。\n")
    return EXIT_ERROR
  }

  const script = options.script ? await loadScriptFile(options.script) : undefined
  const resolution = await resolveProvider({
    settings,
    env,
    ...(script ? { script } : {}),
  })
  for (const note of resolution.notes) io.err(`[模型] ${note}\n`)

  // 模型解析成功后再建 worktree：前面的失败不该在仓库旁边留下一个空检出
  if (wantWorktree) {
    try {
      worktree = await createWorktree({ cwd: baseWorkspaceRoot })
    } catch (err) {
      io.err(`${err instanceof Error ? err.message : String(err)}\n`)
      return EXIT_ERROR
    }
    workspaceRoot = worktree.path
    io.err(`[worktree] 独立工作区：${worktree.path}\n`)
    io.err(`[worktree] 分支 ${worktree.branch}（基于 ${worktree.baseCommit.slice(0, 12)}）\n`)
  }

  const session = await CliSession.open({
    workspaceRoot,
    settings,
    provider: resolution.provider,
    io,
    format,
    sqliteFile: defaultStateFile(baseWorkspaceRoot, env, input.homeDir),
    logLevel: options.verbose ? "debug" : "warn",
    hasTty: io.isTty,
    ...(options.stream === false ? { streaming: false } : {}),
    ...(input.now ? { now: input.now } : {}),
  })

  try {
    const budget = buildBudgetOverride(options)
    // --bare：无人值守最小面 —— 不读仓库规则、不自动跑验证
    const bare = options.bare === true
    const runOptions = {
      ...(mode ? { mode } : {}),
      ...(budget ? { budget } : {}),
      ...(bare || options.noValidation ? { noValidation: true } : {}),
      ...(bare ? { skipProjectRules: true } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      resolveApproval: createInteractivePrompter(io),
    }

    if (options.resume) {
      return (await session.resumeTask(options.resume, runOptions)).exitCode
    }

    if (options.continue) {
      const taskId = await findResumableTask(session, workspaceRoot)
      if (!taskId) {
        io.err("没有找到可继续的任务。\n")
        return EXIT_ERROR
      }
      io.err(`[恢复] 继续任务 ${taskId}\n`)
      return (await session.resumeTask(taskId, runOptions)).exitCode
    }

    const prompt = options.print ?? input.promptArgs.join(" ").trim()
    const headless = options.print !== undefined || input.promptArgs.length > 0

    if (headless) {
      if (prompt.length === 0) {
        io.err('缺少需求：用 --print "<需求>" 或直接把需求作为参数传入。\n')
        return EXIT_ERROR
      }
      return (await session.runOnce({ prompt, ...runOptions })).exitCode
    }

    return await runRepl({
      session,
      io,
      mode: mode ?? settings.mode ?? "plan",
      ...(input.signal ? { signal: input.signal } : {}),
    })
  } finally {
    await session.close()
    if (worktree) {
      io.err(`[worktree] 改动保留在 ${worktree.path}；用 git -C "${worktree.path}" diff 查看。\n`)
    }
  }
}

/* ------------------------------------------------------------------ *
 * worktree
 * ------------------------------------------------------------------ */

async function executeWorktreeList(input: {
  io: CliIo
  cwd: string
  asJson: boolean
}): Promise<number> {
  let repoRoot: string
  try {
    repoRoot = await findRepoRoot(input.cwd)
  } catch (err) {
    input.io.err(`${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT_ERROR
  }

  try {
    const items = await listWorktrees(repoRoot)
    /**
     * 列表要带上"敢不敢删"的信息：只有路径和分支的话，用户还得逐个 cd 进去
     * 跑 git status 才知道这个检出能不能清掉。
     */
    const enriched = await Promise.all(
      items.map(async (item) => ({ ...item, status: await worktreeStatus(item) })),
    )
    if (input.asJson) {
      input.io.out(`${JSON.stringify(enriched, null, 2)}\n`)
      return EXIT_OK
    }
    if (enriched.length === 0) {
      input.io.out("（没有由 mod-agent 创建的 worktree）\n")
      return EXIT_OK
    }
    for (const item of enriched) {
      input.io.out(`${item.path}\n`)
      const state: string[] = []
      if (item.status.dirty) state.push(`${item.status.changedFiles} 个未提交改动`)
      if (item.status.unmergedCommits > 0) state.push(`${item.status.unmergedCommits} 个未合并提交`)
      input.io.out(
        `  分支 ${item.branch} · HEAD ${item.baseCommit.slice(0, 12)}` +
          ` · ${state.length > 0 ? state.join(" / ") : "干净"}\n`,
      )
    }
    return EXIT_OK
  } catch (err) {
    input.io.err(`${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT_ERROR
  }
}

async function executeWorktreeDiff(input: {
  io: CliIo
  cwd: string
  target: string
  stat: boolean
}): Promise<number> {
  let repoRoot: string
  try {
    repoRoot = await findRepoRoot(input.cwd)
    const target = input.target.trim()
    const candidates = (await listWorktrees(repoRoot)).filter(
      (info) =>
        info.branch === target ||
        info.branch.endsWith(`/${target}`) ||
        path.basename(info.path).endsWith(`-${target}`) ||
        path.resolve(info.path) === path.resolve(input.cwd, target),
    )
    if (candidates.length === 0) {
      input.io.err(`没有找到匹配 "${target}" 的托管检出（用 worktree list 查看）。\n`)
      return EXIT_ERROR
    }
    if (candidates.length > 1) {
      input.io.err(`"${target}" 匹配到多个检出，请改用完整分支名或目录：\n`)
      for (const info of candidates) input.io.err(`  ${info.branch} · ${info.path}\n`)
      return EXIT_ERROR
    }
    const info = candidates[0] as WorktreeInfo
    const diff = await worktreeDiff(info, { stat: input.stat })
    input.io.out(diff.length > 0 ? `${diff}\n` : "(没有未提交改动)\n")
    return EXIT_OK
  } catch (err) {
    input.io.err(`${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT_ERROR
  }
}

async function executeWorktreeClean(input: {
  io: CliIo
  cwd: string
  force: boolean
}): Promise<number> {
  let repoRoot: string
  try {
    repoRoot = await findRepoRoot(input.cwd)
  } catch (err) {
    input.io.err(`${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT_ERROR
  }

  try {
    const items = await listWorktrees(repoRoot)
    if (items.length === 0) {
      input.io.out("（没有需要清理的 worktree）\n")
      return EXIT_OK
    }

    let skipped = 0
    for (const info of items) {
      const status = await worktreeStatus(info)
      if ((status.dirty || status.unmergedCommits > 0) && !input.force) {
        skipped += 1
        const reasons: string[] = []
        if (status.dirty) reasons.push(`${status.changedFiles} 个未提交改动`)
        if (status.unmergedCommits > 0) reasons.push(`${status.unmergedCommits} 个未合并提交`)
        input.io.err(
          `[跳过] ${info.path}：${reasons.join("，")}。确认丢弃请加 --force（分支上已提交的内容会保留）。\n`,
        )
        continue
      }
      /** 有未合并提交时保留分支：删 checkout 可以，删提交不行。 */
      const removeBranch = status.unmergedCommits === 0
      await removeWorktree(info, { removeBranch })
      input.io.out(
        `已删除 ${info.path}${removeBranch ? `（分支 ${info.branch}）` : `（分支 ${info.branch} 保留，含未合并提交）`}\n`,
      )
    }

    if (skipped > 0) {
      input.io.err(`${skipped} 个 worktree 仍有改动，未删除。\n`)
      return EXIT_ERROR
    }
    return EXIT_OK
  } catch (err) {
    input.io.err(`${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT_ERROR
  }
}

/* ------------------------------------------------------------------ *
 * doctor / config
 * ------------------------------------------------------------------ */

async function executeDoctor(input: {
  io: CliIo
  env: NodeJS.ProcessEnv
  cwd: string
  cliSettings?: string
  homeDir?: string
  asJson: boolean
}): Promise<number> {
  const { io, env } = input
  const workspaceRoot = path.resolve(input.cwd)
  const loaded = await loadSettings({
    cwd: workspaceRoot,
    ...(input.cliSettings ? { cliSettings: input.cliSettings } : {}),
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
  })
  // doctor 只诊断，不真的去调模型：给一个不带凭证的 provider，避免误触发网络请求
  const resolution = await resolveProvider({ settings: loaded.settings, env })
  const session = await CliSession.open({
    workspaceRoot,
    settings: loaded.settings,
    provider: resolution.provider,
    io,
    format: "text",
    // doctor 要报告**真实**会用到的存储，所以指向与正式运行同一个状态文件
    sqliteFile: defaultStateFile(workspaceRoot, env, input.homeDir),
  })
  try {
    const report = await session.doctor()
    const credentials = {
      provider: resolution.id,
      credentialsPresent: resolution.credentialsPresent,
      notes: resolution.notes,
    }
    /**
     * 实际生效的窗口与单价：压缩阈值与预算门禁都按这两个值算。
     * doctor 必须把"用的是配置还是画像"说清楚，否则用户看到 128k 的模型
     * 却以为还在按 200k 压缩，就无从判断该不该改配置。
     */
    const profile = resolveModelProfile(loaded.settings.model)
    const contextWindowTokens = resolveContextWindowTokens(
      loaded.settings.limits.contextWindowTokens,
      loaded.settings.model,
    )
    const pricing = loaded.settings.pricing ?? profile.pricing
    const model = {
      name: loaded.settings.model ?? "(provider default)",
      contextWindowTokens,
      windowSource: loaded.settings.limits.contextWindowTokens
        ? "settings"
        : `profile:${profile.id}`,
      pricing,
      pricingSource: loaded.settings.pricing ? "settings" : `profile:${profile.id}`,
    }
    if (input.asJson) {
      io.out(
        `${JSON.stringify({ ...report, credentials, model, warnings: loaded.warnings }, null, 2)}\n`,
      )
    } else {
      io.out(`工作区      ${report.workspaceRoot}\n`)
      io.out(`运行时      node ${report.node} · ${report.platform}\n`)
      io.out(
        `存储        ${report.storeKind}${report.storeDegradedReason ? `（降级：${report.storeDegradedReason}）` : ""}\n`,
      )
      io.out(`沙箱        ${report.sandbox.backend}${report.sandbox.degraded ? "（降级）" : ""}\n`)
      for (const line of report.sandbox.coverage) io.out(`            ${line}\n`)
      io.out(
        `模型后端    ${credentials.provider} · 凭证 ${credentials.credentialsPresent ? "已配置" : "缺失"}\n`,
      )
      for (const note of credentials.notes) io.out(`            ${note}\n`)
      io.out(
        `模型窗口    ${model.name} · ${contextWindowTokens} tokens（${model.windowSource === "settings" ? "配置覆盖" : `画像 ${profile.id}`}）\n`,
      )
      io.out(
        `计费单价    $${pricing.inputUsdPerMTok}/M 输入 · $${pricing.outputUsdPerMTok}/M 输出（${model.pricingSource === "settings" ? "配置覆盖" : "参考价"}）\n`,
      )
      io.out(`工具        ${report.tools.join(", ")}\n`)
      io.out(
        `验证命令    ${report.discoveredChecks.length > 0 ? report.discoveredChecks.map((c) => `${c.id}(${c.command.join(" ")})`).join(" · ") : "(未发现)"}\n`,
      )
      io.out(`策略版本    ${report.policyVersion}\n`)
      for (const warning of loaded.warnings) io.out(`[配置] ${warning}\n`)
    }
    return EXIT_OK
  } finally {
    await session.close()
  }
}

async function executeConfig(input: {
  io: CliIo
  env: NodeJS.ProcessEnv
  cwd: string
  cliSettings?: string
  homeDir?: string
  asJson: boolean
}): Promise<number> {
  const workspaceRoot = path.resolve(input.cwd)
  const loaded = await loadSettings({
    cwd: workspaceRoot,
    ...(input.cliSettings ? { cliSettings: input.cliSettings } : {}),
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
  })
  if (input.asJson) {
    input.io.out(
      `${JSON.stringify({ settings: loaded.settings, layers: loaded.layers, warnings: loaded.warnings }, null, 2)}\n`,
    )
  } else {
    input.io.out("生效分层（优先级从高到低）：\n")
    for (const layer of loaded.layers) input.io.out(`  ${layer.name.padEnd(8)} ${layer.source}\n`)
    if (loaded.layers.length === 0) input.io.out("  （没有找到任何配置层，全部使用默认值）\n")
    input.io.out("\n生效值：\n")
    input.io.out(`${JSON.stringify(loaded.settings, null, 2)}\n`)
    for (const warning of loaded.warnings) input.io.err(`[配置] ${warning}\n`)
  }
  return EXIT_OK
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

/**
 * 解析子命令真正该用的工作区目录。
 *
 * commander 的一个坑：`-C` 声明在 program 上时，写 `mod doctor -C <dir>` 会**被子命令
 * 吞掉** —— 子命令的 options 里是空的，值跑到 `program.opts()` 里去了。
 * 于是 doctor/config 会一直诊断当前目录：看起来在查工作区 A，实际查的是 B，
 * 而输出里那行"工作区"还会让人误以为生效了。两处都取一遍才不会漏。
 */
function resolveCwd(
  subOptions: { cwd?: string } | object,
  program: Command,
  fallback: string,
): string {
  const own = (subOptions as { cwd?: string }).cwd
  const global = (program.opts() as { cwd?: string }).cwd
  return own ?? global ?? fallback
}

/** 状态文件落在工作区外：不要把会话数据库写进用户的仓库。 */
function defaultStateFile(
  _workspaceRoot: string,
  env: NodeJS.ProcessEnv,
  homeDir?: string,
): string {
  const home = homeDir ?? env.HOME ?? env.USERPROFILE ?? os.homedir()
  return path.join(home, ".mod", "state.sqlite")
}

async function findResumableTask(
  session: CliSession,
  workspaceRoot: string,
): Promise<string | undefined> {
  const tasks = await session.runtime.store.listTasks()
  const candidates = tasks
    .filter((task) => path.resolve(task.workspaceRoot) === path.resolve(workspaceRoot))
    .filter((task) => !["completed", "failed", "cancelled", "expired"].includes(task.status))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return candidates[0]?.id
}

function buildBudgetOverride(options: GlobalOptions): Partial<Budget> | undefined {
  const budget: Partial<Budget> = {}
  if (options.maxRounds !== undefined) {
    const parsed = Number(options.maxRounds)
    if (!Number.isFinite(parsed) || parsed <= 0)
      throw new Error(`--max-rounds 非法：${options.maxRounds}`)
    budget.maxRounds = Math.floor(parsed)
  }
  if (options.maxCost !== undefined) {
    const parsed = Number(options.maxCost)
    if (!Number.isFinite(parsed) || parsed < 0)
      throw new Error(`--max-cost 非法：${options.maxCost}`)
    budget.maxCostUsd = parsed
  }
  return Object.keys(budget).length > 0 ? budget : undefined
}

function reportFailure(io: CliIo, err: unknown): number {
  const appError = err instanceof AppError ? err : undefined
  const message = err instanceof Error ? err.message : String(err)
  io.err(`[失败]${appError ? ` ${appError.code}` : ""} ${message}\n`)
  return EXIT_ERROR
}

function isCommanderError(err: unknown): err is { exitCode: number; code: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "exitCode" in err &&
    typeof (err as { exitCode: unknown }).exitCode === "number"
  )
}

/** 版本号从仓库 package.json 读，不另写一份常量（避免升级时忘记同步）。 */
async function readVersion(): Promise<string> {
  try {
    const url = new URL("../../package.json", import.meta.url)
    const raw = await fs.readFile(url, "utf8")
    const parsed: unknown = JSON.parse(raw)
    const version = (parsed as { version?: unknown }).version
    return typeof version === "string" ? version : "0.0.0-dev"
  } catch {
    return "0.0.0-dev"
  }
}

/** 进程入口：只在真正作为 CLI 运行时注册信号与退出。 */
/**
 * 进程入口。
 *
 * 注意 argv 要去掉 node 与脚本路径两位：`runCli` 内部用的是 commander 的
 * `from: "user"` 模式，多传这两位会把 node 的路径当成子命令名，
 * 结果是 `mod doctor` 落到默认分支去跑任务 —— 症状很怪，但原因就在这两位上。
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<never> {
  const controller = new AbortController()
  let interrupted = false
  const onSignal = (): void => {
    if (interrupted) process.exit(130)
    interrupted = true
    controller.abort()
  }
  process.on("SIGINT", onSignal)

  const code = await runCli(argv, { signal: controller.signal }).catch((err: unknown) =>
    reportFailure(createProcessIo(), err),
  )
  process.off("SIGINT", onSignal)
  process.exit(code)
}

export { CREDENTIAL_ENV }
