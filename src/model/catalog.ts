/**
 * 内置模型画像（上下文窗口 + 参考价格）。
 *
 * 为什么需要它：主循环的压缩阈值、成本门禁与 `doctor` 报告都必须知道
 * "这个模型能装多少 token、每个 token 多少钱"。以前这两件事各自写死
 * （`contextWindowTokens = 200_000`、`DEFAULT_PRICING = $3/$15`），换个
 * 128k 的模型就会在上下文超限之后才由上游 400 报错，而费用预算也永远
 * 按 Claude 的价格算 —— 对便宜或更贵的后端都是错的。
 *
 * 两个刻意的取舍：
 * - **只按模型名前缀匹配**，不做精确版本表：新版本每周都在出，表越精确越快过时；
 * - 价格只是**估算参考价**，允许被 `settings.pricing` 覆盖。门禁要的是量级正确，
 *   不是账单级精确（真要核对账，请以服务商账单为准）。
 */

import { DEFAULT_PRICING, type ModelPricing } from "./types.js"

export interface ModelProfile {
  /** 命中的画像键（诊断用）。 */
  id: string
  contextWindowTokens: number
  /** 每百万 token 的参考价格。 */
  pricing: ModelPricing
}

/** 没命中任何画像时的保守默认值：与旧行为一致。 */
export const DEFAULT_MODEL_PROFILE: ModelProfile = {
  id: "default",
  contextWindowTokens: 200_000,
  pricing: DEFAULT_PRICING,
}

interface CatalogEntry extends ModelProfile {
  /** 小写前缀；按数组顺序匹配，越具体越靠前。 */
  prefix: string
}

const CATALOG: readonly CatalogEntry[] = [
  {
    id: "claude-sonnet-4",
    prefix: "claude-sonnet-4",
    contextWindowTokens: 200_000,
    pricing: {
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      cacheReadUsdPerMTok: 0.3,
      cacheWriteUsdPerMTok: 3.75,
    },
  },
  {
    id: "claude-opus-4",
    prefix: "claude-opus-4",
    contextWindowTokens: 200_000,
    pricing: {
      inputUsdPerMTok: 15,
      outputUsdPerMTok: 75,
      cacheReadUsdPerMTok: 1.5,
      cacheWriteUsdPerMTok: 18.75,
    },
  },
  {
    id: "claude-3-5-sonnet",
    prefix: "claude-3-5-sonnet",
    contextWindowTokens: 200_000,
    pricing: {
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      cacheReadUsdPerMTok: 0.3,
      cacheWriteUsdPerMTok: 3.75,
    },
  },
  {
    id: "gpt-4o-mini",
    prefix: "gpt-4o-mini",
    contextWindowTokens: 128_000,
    pricing: {
      inputUsdPerMTok: 0.15,
      outputUsdPerMTok: 0.6,
    },
  },
  {
    id: "gpt-4o",
    prefix: "gpt-4o",
    contextWindowTokens: 128_000,
    pricing: {
      inputUsdPerMTok: 2.5,
      outputUsdPerMTok: 10,
    },
  },
  {
    id: "gpt-4.1",
    prefix: "gpt-4.1",
    contextWindowTokens: 1_000_000,
    pricing: {
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 8,
    },
  },
]

/**
 * 按模型名解析画像。
 *
 * 空名 / 未命中 → `DEFAULT_MODEL_PROFILE`。注意"未命中"不是错误：
 * 本地 vLLM / Ollama 的模型名千奇百怪，硬失败会让它们没法用。
 */
export function resolveModelProfile(model: string | undefined): ModelProfile {
  const normalized = (model ?? "").trim().toLowerCase()
  if (normalized.length > 0) {
    for (const entry of CATALOG) {
      if (normalized.startsWith(entry.prefix)) {
        const { prefix: _prefix, ...profile } = entry
        return profile
      }
    }
  }
  return DEFAULT_MODEL_PROFILE
}

/**
 * 压缩阈值用的上下文窗口。
 *
 * 显式配置永远优先：用户比我们更清楚自己接的是什么端点（例如代理会截短上下文）。
 * 没配置时才回落到模型画像。
 */
export function resolveContextWindowTokens(
  configured: number | undefined,
  model: string | undefined,
): number {
  return configured ?? resolveModelProfile(model).contextWindowTokens
}
