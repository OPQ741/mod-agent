/**
 * 测试辅助：临时工作区 + 可注入的 runtime。
 *
 * 三条原则：
 * 1. 全部离线。模型侧用 ScriptedProvider 回放固定决策，命令侧只跑任何机器都存在的命令；
 *    这样"测试红了"永远意味着代码有问题，不会是网络抖动。
 * 2. 真实文件系统。临时目录 + 真实 Git 仓库，而不是 mock fs —— 因为 read-before-edit、
 *    mtime 检测、realpath 路径守卫这些逻辑，mock 掉 fs 等于把被测逻辑一起 mock 掉。
 * 3. Windows / POSIX 都能过。命令测试用 node 自身作为可执行文件（`process.execPath`）。
 */

import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { AgentRuntime } from "../src/runtime/runtime.js"
import { MemoryStore } from "../src/store/memory.js"
import { ScriptedProvider, type ScriptStep } from "../src/model/scripted.js"
import { Logger, Metrics, noopLogger } from "../src/observability/logger.js"
import { PathGuard } from "../src/policy/pathguard.js"
import { EditEngine } from "../src/patch/edit.js"
import { ToolRegistry } from "../src/tools/registry.js"
import { ToolExecutor } from "../src/tools/executor.js"
import { PolicyEngine } from "../src/policy/engine.js"
import { ModelGateway } from "../src/model/gateway.js"
import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  type Settings,
  type SettingsInput,
} from "../src/config/settings.js"
import type { CommandResult } from "../src/shared/contracts.js"
import type { ToolExecutionContext } from "../src/shared/contracts.js"
import type { ModelRequest } from "../src/model/types.js"
import { AppError } from "../src/shared/errors.js"

/* ------------------------------------------------------------------ *
 * 临时工作区
 * ------------------------------------------------------------------ */

export interface TempWorkspace {
  root: string
  cleanup(): Promise<void>
  /** 相对工作区根目录建文件（父目录自动创建）。 */
  write(relPath: string, content: string): Promise<string>
  read(relPath: string): Promise<string>
  exists(relPath: string): Promise<boolean>
  /** 绝对路径。Windows 盘符大小写会被 realpath 统一，测试里一律用它。 */
  abs(relPath: string): string
}

export async function createTempWorkspace(prefix = "mod-test-"): Promise<TempWorkspace> {
  // 先 realpath 一次：macOS 的 /var → /private/var 会让后面的路径断言随机失败
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const root = await fs.realpath(raw)

  return {
    root,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true })
    },
    async write(relPath, content) {
      const target = path.join(root, relPath)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, content, "utf8")
      return target
    },
    async read(relPath) {
      return fs.readFile(path.join(root, relPath), "utf8")
    },
    async exists(relPath) {
      try {
        await fs.access(path.join(root, relPath))
        return true
      } catch {
        return false
      }
    },
    abs(relPath) {
      return path.join(root, relPath)
    },
  }
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

export function settingsWith(overrides: SettingsInput): Settings {
  return SettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    ...overrides,
    permissions: {
      ...DEFAULT_SETTINGS.permissions,
      ...(overrides.permissions ?? {}),
    },
    limits: { ...DEFAULT_SETTINGS.limits, ...(overrides.limits ?? {}) },
    budget: { ...DEFAULT_SETTINGS.budget, ...(overrides.budget ?? {}) },
    sandbox: { ...DEFAULT_SETTINGS.sandbox, ...(overrides.sandbox ?? {}) },
  })
}

/* ------------------------------------------------------------------ *
 * Runtime
 * ------------------------------------------------------------------ */

export interface TestRuntime extends AgentRuntime {
  provider: ScriptedProvider
  tempDir: TempWorkspace
  metrics: Metrics
  logger: Logger
}

export async function createTestRuntime(options: {
  workspace: TempWorkspace
  script: readonly ScriptStep[]
  settings?: Settings
  hasTty?: boolean
  now?: () => Date
  /** 录制模型收到的请求，用于断言"第二轮能看到上一轮的工具结果"。 */
  onRequest?: (request: ModelRequest, stepIndex: number) => void
}): Promise<TestRuntime> {
  const provider = new ScriptedProvider(options.script, {
    ...(options.onRequest ? { onRequest: options.onRequest } : {}),
  })
  const logger = noopLogger()
  const metrics = new Metrics()
  const runtime = await AgentRuntime.create({
    workspaceRoot: options.workspace.root,
    settings: options.settings ?? settingsWith({}),
    provider,
    store: new MemoryStore(),
    logger,
    metrics,
    ...(options.hasTty !== undefined ? { hasTty: options.hasTty } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  return Object.assign(runtime, {
    provider,
    tempDir: options.workspace,
    metrics,
    logger,
  }) as TestRuntime
}

/** 收集生成器事件，返回 [事件列表, LoopOutcome]。 */
export async function collect<E, T>(
  gen: AsyncGenerator<E, T, void>,
): Promise<{ events: E[]; outcome: T }> {
  const events: E[] = []
  const iterator = gen[Symbol.asyncIterator]()
  let step = await iterator.next()
  while (!step.done) {
    events.push(step.value)
    step = await iterator.next()
  }
  return { events, outcome: step.value }
}

export function eventTypes(events: ReadonlyArray<{ type: string }>): string[] {
  return events.map((e) => e.type)
}

/* ------------------------------------------------------------------ *
 * 工具层测试脚手架
 * ------------------------------------------------------------------ */

/** 一个把结果记进内存的"命令运行器"，替代真实沙箱。 */
export function fakeCommandRunner(
  result:
    | Partial<CommandResult>
    | ((req: { executable: string; args: string[] }) => Partial<CommandResult>),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): (req: any) => Promise<CommandResult> {
  const calls: Array<{ executable: string; args: string[] }> = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = async (req: any): Promise<CommandResult> => {
    calls.push({ executable: req.executable, args: req.args ?? [] })
    const partial = typeof result === "function" ? result(req) : result
    const base: CommandResult = {
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
      truncated: false,
      cancelled: false,
      outputLimitExceeded: false,
    }
    return { ...base, ...partial }
  }
  ;(fn as unknown as { calls: typeof calls }).calls = calls
  return fn
}

export function makeToolContext(options: {
  workspace: TempWorkspace
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runCommand?: (req: any) => Promise<CommandResult>
  signal?: AbortSignal
  readTracker?: EditEngine
}): ToolExecutionContext {
  const tracker = options.readTracker ?? new EditEngine()
  return {
    callId: "call_test",
    taskId: "task_test",
    workspaceRoot: options.workspace.root,
    cwd: options.workspace.root,
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: 10_000,
    budgetTokens: 25_000,
    runCommand: options.runCommand ?? fakeCommandRunner({ stdout: "ok", exitCode: 0 }),
    logger: noopLogger(),
    trackRead: (p, mtimeMs) => tracker.recordRead(p, mtimeMs, ""),
    readState: (p) => {
      const record = tracker.readRecord(p)
      if (!record) return undefined
      return { read: true, mtimeMs: record.mtimeMs }
    },
    trackWrite: (p) => {
      void p
    },
    persistArtifact: async (content, kind) => ({
      uri: `mod://artifact/${kind}/${content.length}`,
      sha256: "test",
    }),
  }
}

export function makeToolRuntime(options: { workspace: TempWorkspace; policyVersion?: string }) {
  const registry = new ToolRegistry()
  const executor = new ToolExecutor({
    registry,
    policyVersion: options.policyVersion ?? "test-policy",
  })
  return { registry, executor }
}

export function makePathGuard(workspace: TempWorkspace, respectGitignore = false): PathGuard {
  return new PathGuard({ workspaceRoot: workspace.root, respectGitignore })
}

export function makePolicyEngine(
  workspace: TempWorkspace,
  overrides: SettingsInput = {},
  extra: Partial<ConstructorParameters<typeof PolicyEngine>[0]> = {},
): PolicyEngine {
  return new PolicyEngine({
    settings: settingsWith(overrides),
    cwd: workspace.root,
    hasTty: true,
    ...extra,
  })
}

export function makeGateway(
  provider: unknown,
  overrides: Partial<ConstructorParameters<typeof ModelGateway>[0]> = {},
) {
  return new ModelGateway({
    provider: provider as never,
    sleep: async () => undefined,
    random: () => 0,
    ...overrides,
  })
}

/* ------------------------------------------------------------------ *
 * 其它
 * ------------------------------------------------------------------ */

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 当前文件所在目录，测试里用来定位 fixture。 */
export function currentDir(): string {
  return path.dirname(fileURLToPath(import.meta.url))
}

export { MemoryStore, ScriptedProvider, noopLogger, Metrics, AppError, DEFAULT_SETTINGS }
