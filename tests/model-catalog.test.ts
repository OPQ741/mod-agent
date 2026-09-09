/**
 * 模型画像测试（`src/model/catalog.ts`）。
 *
 * 这里断言的是"换模型之后，窗口与价格会跟着变"这条用户可观察的承诺：
 * - 128k 的模型不能再按 200k 算压缩阈值，否则要等上游 400 才发现超限；
 * - 便宜/贵的模型不该统一按 $3/$15 记成本，否则预算门禁要么误杀要么放行。
 */

import { describe, expect, it } from "vitest"

import {
  DEFAULT_MODEL_PROFILE,
  resolveContextWindowTokens,
  resolveModelProfile,
} from "../src/model/catalog.js"

describe("model/catalog: 模型画像", () => {
  it("按前缀识别 Claude 与 GPT 系列，窗口与单价跟着模型走", () => {
    const sonnet = resolveModelProfile("claude-sonnet-4-5-20250929")
    expect(sonnet.id).toBe("claude-sonnet-4")
    expect(sonnet.contextWindowTokens).toBe(200_000)
    expect(sonnet.pricing.inputUsdPerMTok).toBe(3)

    const opus = resolveModelProfile("Claude-Opus-4-1")
    expect(opus.pricing.outputUsdPerMTok).toBe(75)

    const gpt4o = resolveModelProfile("gpt-4o")
    expect(gpt4o.contextWindowTokens).toBe(128_000)
    expect(gpt4o.pricing.inputUsdPerMTok).toBe(2.5)
  })

  it("更具体的前缀优先：gpt-4o-mini 不会被 gpt-4o 抢走", () => {
    const mini = resolveModelProfile("gpt-4o-mini-2024-07-18")
    expect(mini.id).toBe("gpt-4o-mini")
    expect(mini.pricing.inputUsdPerMTok).toBe(0.15)
  })

  it("未知模型 / 空模型名回落到默认画像，而不是报错", () => {
    expect(resolveModelProfile("my-local-qwen")).toEqual(DEFAULT_MODEL_PROFILE)
    expect(resolveModelProfile(undefined)).toEqual(DEFAULT_MODEL_PROFILE)
    expect(resolveModelProfile("  ")).toEqual(DEFAULT_MODEL_PROFILE)
  })

  it("显式配置的上下文窗口优先于画像", () => {
    expect(resolveContextWindowTokens(50_000, "gpt-4o")).toBe(50_000)
    expect(resolveContextWindowTokens(undefined, "gpt-4o")).toBe(128_000)
    expect(resolveContextWindowTokens(undefined, "unknown-model")).toBe(200_000)
  })
})
