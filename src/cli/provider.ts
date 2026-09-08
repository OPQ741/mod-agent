/**
 * 模型 Provider 装配。
 *
 * 一条硬规矩（security.md §5）：**凭证只从配置或环境变量读，绝不做命令行参数** ——
 * 否则密钥会直接出现在进程列表和 shell history 里。所以这里没有 `--api-key` 这种东西，
 * `doctor` 也只报告"有 / 没有"，从不回显内容。
 */

import { promises as fs } from "node:fs"
import { AnthropicProvider } from "../model/anthropic.js"
import { OpenAICompatProvider } from "../model/openai-compat.js"
import { ScriptedProvider } from "../model/scripted.js"
import type { ModelProvider } from "../model/types.js"
import type { ScriptStep } from "../model/scripted.js"
import type { Settings } from "../config/settings.js"
import { DecisionSchema } from "../shared/contracts.js"

export type ProviderId = "anthropic" | "openai-compat" | "scripted"

export interface ProviderResolution {
  provider: ModelProvider
  id: ProviderId
  /** 是否拿到了该后端需要的凭证（只报有无，不含内容）。 */
  credentialsPresent: boolean
  /** 诊断信息：缺什么、为什么退回某个后端。 */
  notes: string[]
}

export interface ResolveProviderOptions {
  settings: Settings
  env: NodeJS.ProcessEnv
  /** 离线脚本（回放用）：给了就优先走 scripted。 */
  script?: readonly ScriptStep[]
}

/** 环境变量里的凭证名，集中一处，避免散落到各命令里。 */
export const CREDENTIAL_ENV = {
  anthropicKey: "ANTHROPIC_API_KEY",
  anthropicBaseUrl: "ANTHROPIC_BASE_URL",
  openaiKey: "OPENAI_API_KEY",
  openaiBaseUrl: "OPENAI_BASE_URL",
  providerOverride: "MOD_AGENT_PROVIDER",
} as const

export async function resolveProvider(
  options: ResolveProviderOptions,
): Promise<ProviderResolution> {
  const { settings, env } = options
  const notes: string[] = []

  if (options.script && options.script.length > 0) {
    notes.push("scripted provider: 回放固定决策，不联网")
    return {
      provider: new ScriptedProvider(options.script, {
        model: settings.model ?? "scripted",
        // 回放也走流式：否则 CLI 的流式渲染路径只能用真实端点验证，离线测试覆盖不到
        streaming: true,
      }),
      id: "scripted",
      credentialsPresent: true,
      notes,
    }
  }

  const id = inferProviderId(settings, env, notes)
  if (id === "anthropic") {
    const apiKey = env[CREDENTIAL_ENV.anthropicKey]
    const baseUrl = settings.baseUrl ?? env[CREDENTIAL_ENV.anthropicBaseUrl]
    if (!apiKey)
      notes.push(`缺少环境变量 ${CREDENTIAL_ENV.anthropicKey}：调用模型前请先在配置或环境里配好`)
    return {
      provider: new AnthropicProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}) }),
      id,
      credentialsPresent: Boolean(apiKey),
      notes,
    }
  }

  const apiKey = env[CREDENTIAL_ENV.openaiKey]
  const baseUrl =
    settings.baseUrl ?? env[CREDENTIAL_ENV.openaiBaseUrl] ?? "https://api.openai.com/v1"
  if (!apiKey) notes.push(`缺少环境变量 ${CREDENTIAL_ENV.openaiKey}（部分兼容端点允许为空）`)
  return {
    provider: new OpenAICompatProvider({ baseUrl, ...(apiKey ? { apiKey } : {}) }),
    id,
    credentialsPresent: Boolean(apiKey),
    notes,
  }
}

function inferProviderId(
  settings: Settings,
  env: NodeJS.ProcessEnv,
  notes: string[],
): Exclude<ProviderId, "scripted"> {
  const explicit = settings.provider ?? env[CREDENTIAL_ENV.providerOverride]
  if (explicit) {
    const normalized = explicit.toLowerCase()
    if (normalized.startsWith("anthropic")) return "anthropic"
    if (normalized.startsWith("openai") || normalized.startsWith("openai-compat"))
      return "openai-compat"
    notes.push(`未知 provider "${explicit}"，按模型名推断`)
  }
  // 没有显式 provider 时按模型名前缀推断，猜不出来退回 anthropic
  const model = (settings.model ?? "").toLowerCase()
  if (
    model.startsWith("gpt") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("deepseek")
  ) {
    return "openai-compat"
  }
  return "anthropic"
}

/**
 * 读取离线脚本文件（回放模式）。
 *
 * 文件内容是一串 `Decision`（tool_use / final / ask）。用它可以在完全不联网、
 * 不花一分钱的前提下把 CLI 与循环端到端跑一遍，CI 里尤其重要。
 */
export async function loadScriptFile(file: string): Promise<ScriptStep[]> {
  const raw = await fs.readFile(file, "utf8")
  const parsed: unknown = JSON.parse(raw)
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.map((item, index) => {
    const result = DecisionSchema.safeParse(item)
    if (!result.success) {
      throw new Error(`Invalid decision at index ${index} in ${file}: ${result.error.message}`)
    }
    return result.data
  })
}
