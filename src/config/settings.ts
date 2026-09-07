/**
 * 分层配置（ADR-9 / security.md §4.1）。
 *
 * 层级（高 → 低）：
 *   托管策略(managed) > 命令行 --settings > 团队 .mod/settings.json
 *   > 用户 ~/.mod/settings.json > 项目 settings.local.json
 *
 * 合并语义按键类型区分，这是最容易写反的地方：
 * - **数组类**（`permissions.allow` / `permissions.deny` / `permissions.ask` /
 *   `excludeDirs` / `mcpServers` 键集合）跨层取**并集**；
 * - **标量类**（`model` / `permissionMode` / `mode`）按**最 specific 层**替换。
 *
 * 直觉上"更具体的规则赢"是错的：那会让团队级 deny 被个人级精确 allow 翻掉。
 */

import { z } from "zod"
import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

export const PermissionRuleSchema = z.string().min(1)

export const SettingsSchema = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  baseUrl: z.string().url().optional(),
  /** overview.md §1.2 任务模式。 */
  mode: z.enum(["ask", "plan", "edit", "autopilot"]).optional(),
  /** security.md §4.2 权限档位。 */
  permissionMode: z
    .enum(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"])
    .optional(),
  /**
   * 是否为任务开独立 worktree。
   *
   * **当前只是占位，没有任何消费方**：`--worktree` 与这项配置都不改变执行，
   * 改动一律落在主检出。默认给 `false` 而不是 `true` —— 一个没人实现的开关
   * 声称"默认开启"，比声称"默认关闭"更容易让人误判隔离状态。
   */
  worktree: z.boolean().optional(),
  respectGitignore: z.boolean().optional(),
  permissions: z
    .object({
      allow: z.array(PermissionRuleSchema).default([]),
      ask: z.array(PermissionRuleSchema).default([]),
      deny: z.array(PermissionRuleSchema).default([]),
    })
    .default({ allow: [], ask: [], deny: [] }),
  budget: z
    .object({
      maxRounds: z.number().int().positive().optional(),
      maxToolCalls: z.number().int().positive().optional(),
      maxCostUsd: z.number().nonnegative().optional(),
      maxWallClockMs: z.number().int().positive().optional(),
      maxRepairRounds: z.number().int().nonnegative().optional(),
      maxNoProgressRounds: z.number().int().nonnegative().optional(),
    })
    .default({}),
  /** 命令执行相关硬阈值（tools-and-extensions.md §2.5 要求可查可改、一处定义）。 */
  limits: z
    .object({
      commandTimeoutMs: z.number().int().positive().default(120_000),
      commandMaxTimeoutMs: z.number().int().positive().default(600_000),
      commandMaxOutputChars: z.number().int().positive().default(30_000),
      commandMaxTotalOutputBytes: z
        .number()
        .int()
        .positive()
        .default(5 * 1024 ** 3),
      readMaxOutputTokens: z.number().int().positive().default(25_000),
      readMaxBytes: z
        .number()
        .int()
        .positive()
        .default(256 * 1024),
      searchMaxResults: z.number().int().positive().default(100),
      modelTimeoutMs: z.number().int().positive().default(600_000),
      modelMaxRetries: z.number().int().nonnegative().default(10),
      compactionThreshold: z.number().min(0.1).max(0.99).default(0.8),
      contextWindowTokens: z.number().int().positive().default(200_000),
    })
    .default({}),
  /** 沙箱：默认 fail-closed（security.md §3.1）。 */
  sandbox: z
    .object({
      enabled: z.boolean().default(false),
      failIfUnavailable: z.boolean().default(true),
      allowedDomains: z.array(z.string()).default([]),
      deniedDomains: z.array(z.string()).default([]),
      networkMode: z.enum(["full", "limited"]).default("limited"),
    })
    .default({}),
  excludeDirs: z
    .array(z.string())
    .default([
      "node_modules",
      ".git",
      "dist",
      "build",
      "coverage",
      ".next",
      ".nuxt",
      "out",
      ".workbuddy",
      "temp",
    ]),
  /** 环境变量白名单补充项。 */
  envAllowlist: z.array(z.string()).default([]),
})
export type Settings = z.infer<typeof SettingsSchema>
export type SettingsInput = z.input<typeof SettingsSchema>

/* ------------------------------------------------------------------ *
 * 默认值
 * ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS: Settings = {
  mode: "plan",
  permissionMode: "default",
  // 未实现的开关不声称"默认开启"（见 SettingsSchema 里 worktree 的说明）
  worktree: false,
  respectGitignore: true,
  permissions: { allow: [], ask: [], deny: [] },
  budget: {},
  limits: {
    commandTimeoutMs: 120_000,
    commandMaxTimeoutMs: 600_000,
    commandMaxOutputChars: 30_000,
    commandMaxTotalOutputBytes: 5 * 1024 ** 3,
    readMaxOutputTokens: 25_000,
    readMaxBytes: 256 * 1024,
    searchMaxResults: 100,
    modelTimeoutMs: 600_000,
    modelMaxRetries: 10,
    compactionThreshold: 0.8,
    contextWindowTokens: 200_000,
  },
  sandbox: {
    enabled: false,
    failIfUnavailable: true,
    allowedDomains: [],
    deniedDomains: [],
    networkMode: "limited",
  },
  excludeDirs: [
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
    ".next",
    ".nuxt",
    "out",
    ".workbuddy",
    "temp",
  ],
  envAllowlist: [],
}

/** 需要跨层取并集的数组键（点分路径）。 */
const ARRAY_KEYS: ReadonlySet<string> = new Set([
  "permissions.allow",
  "permissions.ask",
  "permissions.deny",
  "excludeDirs",
  "envAllowlist",
  "sandbox.allowedDomains",
  "sandbox.deniedDomains",
])

/* ------------------------------------------------------------------ *
 * 分层合并
 * ------------------------------------------------------------------ */

export type SettingsLayerName = "managed" | "cli" | "team" | "user" | "project"

export interface SettingsLayer {
  name: SettingsLayerName
  /** 该层的来源路径或说明，用于审计与错误提示。 */
  source: string
  values: SettingsInput
}

/** 层级优先级：越靠前越 specific（数值越小优先级越高）。 */
const LAYER_PRIORITY: readonly SettingsLayerName[] = ["managed", "cli", "team", "user", "project"]

export function isArrayKey(key: string): boolean {
  return ARRAY_KEYS.has(key)
}

/**
 * 按 ADR-9 合并若干层配置。
 *
 * `layers` 顺序无关，内部按 LAYER_PRIORITY 排序后再合并。
 * 数组键：所有层的值拼接去重（高层的排在前面）。
 * 标量键：取优先级最高的那层里第一个显式给出值的。
 */
export function mergeSettings(layers: readonly SettingsLayer[]): Settings {
  const ordered = [...layers].sort(
    (a, b) => LAYER_PRIORITY.indexOf(a.name) - LAYER_PRIORITY.indexOf(b.name),
  )
  const merged: Record<string, unknown> = structuredClone(DEFAULT_SETTINGS) as Record<
    string,
    unknown
  >
  applyInto(merged, ordered)
  return SettingsSchema.parse(merged)
}

function applyInto(target: Record<string, unknown>, ordered: readonly SettingsLayer[]): void {
  const topLevelKeys = collectKeys(ordered)
  for (const key of topLevelKeys) {
    const pathParts = key.split(".")
    const values = ordered
      .map((layer) => ({
        layer,
        value: readPath(layer.values as Record<string, unknown>, pathParts),
      }))
      .filter(
        (entry): entry is { layer: SettingsLayer; value: unknown } => entry.value !== undefined,
      )

    if (values.length === 0) continue

    if (isArrayKey(key)) {
      const union: unknown[] = []
      const seen = new Set<string>()
      for (const { value } of values) {
        const arr = Array.isArray(value) ? value : [value]
        for (const item of arr) {
          const marker = typeof item === "string" ? item : JSON.stringify(item)
          if (seen.has(marker)) continue
          seen.add(marker)
          union.push(item)
        }
      }
      writePath(target, pathParts, union)
      continue
    }

    // 标量：取最 specific 层（ordered 已按优先级排序）
    const winner = values[0]
    if (winner === undefined) continue
    if (isPlainObject(winner.value)) {
      // 嵌套对象：递归进一层，继续按标量/数组语义合并
      const current = readPath(target, pathParts)
      const base = isPlainObject(current) ? current : {}
      for (const nested of collectNestedKeys(ordered, pathParts)) {
        const nestedPath = [...pathParts, nested]
        const nestedValues = ordered
          .map((layer) => ({
            layer,
            value: readPath(layer.values as Record<string, unknown>, nestedPath),
          }))
          .filter((e): e is { layer: SettingsLayer; value: unknown } => e.value !== undefined)
        if (nestedValues.length === 0) continue
        if (isArrayKey(nestedPath.join("."))) {
          const union: unknown[] = []
          const seen = new Set<string>()
          for (const { value } of nestedValues) {
            for (const item of Array.isArray(value) ? value : [value]) {
              const marker = typeof item === "string" ? item : JSON.stringify(item)
              if (seen.has(marker)) continue
              seen.add(marker)
              union.push(item)
            }
          }
          writePath(base as Record<string, unknown>, [nested], union)
        } else {
          writePath(base as Record<string, unknown>, [nested], nestedValues[0]?.value)
        }
      }
      writePath(target, pathParts, base)
      continue
    }
    writePath(target, pathParts, winner.value)
  }
}

function collectKeys(ordered: readonly SettingsLayer[]): string[] {
  const keys = new Set<string>()
  for (const layer of ordered) {
    for (const key of Object.keys(layer.values as Record<string, unknown>)) {
      keys.add(key)
    }
  }
  return [...keys]
}

function collectNestedKeys(
  ordered: readonly SettingsLayer[],
  basePath: readonly string[],
): string[] {
  const keys = new Set<string>()
  for (const layer of ordered) {
    const node = readPath(layer.values as Record<string, unknown>, basePath)
    if (!isPlainObject(node)) continue
    for (const key of Object.keys(node)) keys.add(key)
  }
  return [...keys]
}

function readPath(root: Record<string, unknown>, parts: readonly string[]): unknown {
  let current: unknown = root
  for (const part of parts) {
    if (!isPlainObject(current)) return undefined
    current = current[part]
  }
  return current
}

function writePath(root: Record<string, unknown>, parts: readonly string[], value: unknown): void {
  if (parts.length === 0) return
  let current = root
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]
    if (key === undefined) return
    const next = current[key]
    if (!isPlainObject(next)) {
      const created: Record<string, unknown> = {}
      current[key] = created
      current = created
    } else {
      current = next
    }
  }
  const last = parts[parts.length - 1]
  if (last !== undefined) current[last] = value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/* ------------------------------------------------------------------ *
 * 加载
 * ------------------------------------------------------------------ */

export interface LoadSettingsOptions {
  cwd: string
  /** 命令行 --settings，可以是文件路径或内联 JSON。 */
  cliSettings?: string
  homeDir?: string
}

export interface LoadedSettings {
  settings: Settings
  layers: SettingsLayer[]
  /** 加载过程中被跳过或解析失败的文件（fail-closed 只针对 managed 层）。 */
  warnings: string[]
}

/**
 * 从磁盘加载分层配置。
 *
 * fail-closed 规则（security.md §6）：**managed 层解析失败时拒绝启动**，
 * 而不是"当作没有策略继续跑"。其余层解析失败只记警告。
 */
export async function loadSettings(options: LoadSettingsOptions): Promise<LoadedSettings> {
  const homeDir = options.homeDir ?? os.homedir()
  const layers: SettingsLayer[] = []
  const warnings: string[] = []

  const managedPath = process.env.MOD_AGENT_MANAGED_SETTINGS
  if (managedPath) {
    const parsed = await readSettingsFile(managedPath)
    if (parsed.ok) {
      layers.push({ name: "managed", source: managedPath, values: parsed.value })
    } else {
      // managed 是硬失败：没有它就没有组织策略，宁可拒绝启动
      throw new Error(
        `Managed settings could not be parsed (${managedPath}): ${parsed.error}. Refusing to start.`,
      )
    }
  }

  if (options.cliSettings) {
    const parsed = await readSettingsInput(options.cliSettings)
    if (parsed.ok) layers.push({ name: "cli", source: "--settings", values: parsed.value })
    else warnings.push(`--settings could not be parsed: ${parsed.error}`)
  }

  const candidates: Array<{ name: SettingsLayerName; file: string }> = [
    { name: "team", file: path.join(options.cwd, ".mod", "settings.json") },
    { name: "user", file: path.join(homeDir, ".mod", "settings.json") },
    { name: "project", file: path.join(options.cwd, "settings.local.json") },
  ]
  for (const { name, file } of candidates) {
    if (!existsSync(file)) continue
    const parsed = await readSettingsFile(file)
    if (parsed.ok) layers.push({ name, source: file, values: parsed.value })
    else warnings.push(`Skipped ${file}: ${parsed.error}`)
  }

  return { settings: mergeSettings(layers), layers, warnings }
}

async function readSettingsFile(
  file: string,
): Promise<{ ok: true; value: SettingsInput } | { ok: false; error: string }> {
  try {
    const raw = await readFile(file, "utf8")
    return parseSettingsJson(raw)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** `--settings` 既接受文件路径，也接受内联 JSON。 */
async function readSettingsInput(
  input: string,
): Promise<{ ok: true; value: SettingsInput } | { ok: false; error: string }> {
  const trimmed = input.trim()
  if (trimmed.startsWith("{")) return parseSettingsJson(trimmed)
  return readSettingsFile(trimmed)
}

function parseSettingsJson(
  raw: string,
): { ok: true; value: SettingsInput } | { ok: false; error: string } {
  try {
    const json: unknown = JSON.parse(raw)
    if (!isPlainObject(json)) return { ok: false, error: "settings must be a JSON object" }
    return { ok: true, value: json as SettingsInput }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
