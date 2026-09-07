/**
 * 共享契约层测试。
 *
 * 这一层是所有模块的底座：ID / hash / 错误码 / token 裁剪 / 脱敏 / JSON Schema。
 * 它们有两个特点决定了测试怎么写：
 * - **稳定性**：同样的输入必须永远得到同样的输出（`parameterHash` 尤其关键 ——
 *   审批按 hash 绑定，换键序就能绕过审批等于没有审批）；
 * - **确定性**：逻辑必须是纯函数，不能依赖环境。
 */

import { describe, expect, it } from "vitest"

import { newCallId, newEventId, newTaskId, shortId } from "../src/shared/ids.js"
import {
  contentHash,
  idempotencyKey,
  parameterHash,
  sha256,
  shortHash,
  stableStringify,
} from "../src/shared/hash.js"
import {
  AppError,
  ERROR_CODES,
  RETRYABLE,
  invalidInput,
  isErrorCode,
  isRetryableCode,
  toAppError,
} from "../src/shared/errors.js"
import { clipByTokens, clipLines, estimateTokens } from "../src/shared/tokens.js"
import {
  DEFAULT_ENV_ALLOWLIST,
  describeSanitize,
  filterEnv,
  isSensitiveEnvName,
  looksBinary,
  redactSecrets,
  stripAnsi,
  stripInvisibleCharacters,
} from "../src/shared/sanitize.js"
import { assertConvertible, toJsonSchema } from "../src/shared/json-schema.js"
import { normalizeCommandRequest } from "../src/shared/contracts.js"
import { z } from "zod"

describe("shared/ids", () => {
  it("ID 带语义前缀且长度稳定，便于在日志里一眼分辨对象类型", () => {
    expect(newTaskId()).toMatch(/^task_[0-9a-z]{12}$/)
    expect(newCallId()).toMatch(/^call_[0-9a-z]{12}$/)
    expect(newEventId("task_a", 7)).toBe("task_a:7")
    expect(shortId(6)).toHaveLength(6)
  })

  it("ID 不重复", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newTaskId()))
    expect(ids.size).toBe(500)
  })
})

describe("shared/hash", () => {
  it("stableStringify 对键序不敏感，递归也稳定", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
    expect(stableStringify({ x: { d: 1, c: 2 }, y: [1, 2] })).toBe(
      stableStringify({ y: [1, 2], x: { c: 2, d: 1 } }),
    )
  })

  it("stableStringify 丢弃 undefined 键", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }))
  })

  it("参数 hash 换键序不变 —— 审批绑定的安全前提", () => {
    expect(parameterHash({ command: "npm", args: ["test"] })).toBe(
      parameterHash({ args: ["test"], command: "npm" }),
    )
  })

  it("参数 hash 对取值敏感", () => {
    expect(parameterHash({ command: "npm test" })).not.toBe(parameterHash({ command: "rm -rf /" }))
  })

  it("sha256 / contentHash / shortHash 行为符合预期", () => {
    expect(sha256("abc")).toMatch(/^[0-9a-f]{64}$/)
    expect(contentHash("abc")).toBe(contentHash("abc"))
    expect(contentHash("abc")).not.toBe(contentHash("abd"))
    expect(shortHash("abc", 8)).toHaveLength(8)
  })

  it("幂等键由任务 + 工具 + 参数共同决定", () => {
    const a = idempotencyKey({ taskId: "t1", toolName: "command.run", args: { c: "npm test" } })
    const b = idempotencyKey({ taskId: "t1", toolName: "command.run", args: { c: "npm test" } })
    const c = idempotencyKey({ taskId: "t2", toolName: "command.run", args: { c: "npm test" } })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe("shared/errors", () => {
  it("错误码不重复且可类型判定", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
    expect(isErrorCode("MODEL_TIMEOUT")).toBe(true)
    expect(isErrorCode("NOT_A_CODE")).toBe(false)
  })

  it("只有限流 / 过载 / 网络 / 超时可重试，其它重试只会重复报错", () => {
    expect(isRetryableCode("MODEL_RATE_LIMIT")).toBe(true)
    expect(isRetryableCode("MODEL_TIMEOUT")).toBe(true)
    expect(isRetryableCode("TOOL_TIMEOUT")).toBe(true)
    expect(RETRYABLE.has("MODEL_AUTH_FAILED")).toBe(false)
    expect(isRetryableCode("TOOL_SCHEMA_INVALID")).toBe(false)
  })

  it("AppError 带 code / retryable / details，且可序列化", () => {
    const err = new AppError("TOOL_TIMEOUT", "timed out", { details: { tool: "test.run" } })
    expect(err.code).toBe("TOOL_TIMEOUT")
    expect(err.retryable).toBe(true)
    const json = err.toJSON()
    expect(json.code).toBe("TOOL_TIMEOUT")
    expect(json.details).toEqual({ tool: "test.run" })
  })

  it("toAppError 把任意异常收敛成 AppError", () => {
    expect(toAppError(new Error("boom")).message).toBe("boom")
    expect(toAppError("boom", "INTERNAL_ERROR").message).toBe("boom")
    const already = new AppError("EDIT_NOT_FOUND", "nope")
    expect(toAppError(already)).toBe(already)
  })

  it("invalidInput 产出不可重试的入参错误", () => {
    const err = invalidInput("bad args", { field: "path" })
    expect(err.code).toBe("INVALID_INPUT")
    expect(err.retryable).toBe(false)
    expect(err.details).toEqual({ field: "path" })
  })
})

describe("shared/tokens", () => {
  it("中文按字符计、英文按 ~3.6 字符计", () => {
    expect(estimateTokens("你好世界")).toBeGreaterThanOrEqual(4)
    const english = "a".repeat(360)
    expect(estimateTokens(english)).toBeGreaterThan(90)
    expect(estimateTokens(english)).toBeLessThan(110)
  })

  it("clipByTokens 保留头尾并在中间留丢弃标记", () => {
    const input = Array.from({ length: 5000 }, (_, i) => `l${i}`).join("\n")
    const clipped = clipByTokens(input, 200)
    expect(clipped.text.length).toBeLessThan(input.length)
    expect(clipped.droppedChars).toBeGreaterThan(0)
    expect(clipped.text.startsWith("l0")).toBe(true)
    expect(clipped.text.includes("l4999")).toBe(true)
  })

  it("clipByTokens 预算不减 Alduin：短文本原样返回", () => {
    const input = "hello"
    const clipped = clipByTokens(input, 1000)
    expect(clipped.text).toBe(input)
    expect(clipped.droppedChars).toBe(0)
  })

  it("clipLines 分页并给出省略计数", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    const page = clipLines(lines, 10, 5)
    expect(page.lines.length).toBeLessThanOrEqual(5)
    expect(page.omittedBefore).toBe(10)
    expect(page.omittedAfter).toBeGreaterThan(0)
  })
})

describe("shared/sanitize", () => {
  it("剥离零宽 / 双向 / Unicode Tag 字符并报告类别", () => {
    const result = stripInvisibleCharacters("he\u200Bllo\u202Eworld\u{FEFF}!")
    expect(result.text).toBe("helloworld!")
    expect(result.removed).toBe(3)
    expect(result.categories).toContain("zero-width")
    expect(result.categories).toContain("bidi-control")
  })

  it("保留换行与制表符 —— 剥离不等于把格式一起毁掉", () => {
    const result = stripInvisibleCharacters("a\nb\tc")
    expect(result.text).toBe("a\nb\tc")
    expect(result.removed).toBe(0)
  })

  it("describeSanitize 在干净文本时返回 undefined", () => {
    expect(describeSanitize(stripInvisibleCharacters("clean"))).toBeUndefined()
    expect(describeSanitize(stripInvisibleCharacters("a\u200Bb"))).toContain(
      "Removed 1 invisible character",
    )
  })

  it("剥离 ANSI 转义序列，防终端注入", () => {
    expect(stripAnsi("\u001B[31mred\u001B[0m")).toBe("red")
  })

  it("looksBinary 认出 NUL 与控制符密集的内容", () => {
    expect(looksBinary(Buffer.from([0x00, 0x01, 0x02]))).toBe(true)
    expect(looksBinary(Buffer.from("hello world", "utf8"))).toBe(false)
  })

  it("redactSecrets 覆盖常见密钥形状", () => {
    const cases: Array<[string, string]> = [
      ["key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA is mine", "ANTHROPIC_KEY"],
      ["token ghp_abcdefghijklmnop123456", "GITHUB_TOKEN"],
      ["aws AKIAIOSFODNN7EXAMPLE", "AWS_ACCESS_KEY"],
      ['password = "super-secret-value"', "GENERIC_ASSIGN"],
      ["Authorization: Bearer abcdefghijklmnopqrstuv", "BEARER"],
    ]
    for (const [input, expectedHit] of cases) {
      const result = redactSecrets(input)
      expect(result.hits).toContain(expectedHit)
      expect(result.text).not.toMatch(/sk-ant-api03-|ghp_|AKIAIOSFODNN7EXAMPLE|super-secret-value/)
    }
  })

  it("redactSecrets 不动普通文本", () => {
    const result = redactSecrets("export const name = 'mod-agent'")
    expect(result.text).toBe("export const name = 'mod-agent'")
    expect(result.hits).toEqual([])
  })

  it("filterEnv 只放行白名单，且大小写不敏感", () => {
    const out = filterEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-secret", path_lower: "x" }, [
      "path",
    ])
    expect(out.PATH).toBe("/bin")
    expect(out.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it("filterEnv 的 overrides 仍然生效", () => {
    const out = filterEnv({}, undefined, { FOO: "bar" })
    expect(out).toEqual({ FOO: "bar" })
  })

  it("白名单里不含任何密钥类环境变量", () => {
    for (const name of DEFAULT_ENV_ALLOWLIST) {
      expect(isSensitiveEnvName(name)).toBe(false)
    }
    expect(isSensitiveEnvName("anthropic_api_key")).toBe(true)
  })
})

describe("shared/json-schema", () => {
  it("Zod 对象转成 JSON Schema，含 required 与默认值", () => {
    const schema = toJsonSchema(
      z.object({
        path: z.string(),
        limit: z.number().int().default(10),
        optional: z.string().optional(),
        mode: z.enum(["a", "b"]),
      }),
    )
    expect(schema.type).toBe("object")
    expect(schema.properties?.path).toMatchObject({ type: "string" })
    expect(schema.properties?.limit).toMatchObject({ type: "integer" })
    expect(schema.properties?.mode).toMatchObject({ enum: ["a", "b"] })
    expect(schema.required).toContain("path")
    expect(schema.required).not.toContain("optional")
  })

  it("数组 / 联合 / record / 字面量都能转换", () => {
    expect(toJsonSchema(z.array(z.string())).type).toBe("array")
    expect(toJsonSchema(z.union([z.string(), z.number()])).anyOf).toBeDefined()
    expect(toJsonSchema(z.record(z.string())).type).toBe("object")
    expect(toJsonSchema(z.literal("x")).const).toBe("x")
  })

  it("不支持的类型显式报错，而不是静默产出错误 schema", () => {
    expect(() => assertConvertible(z.date(), "bad.tool")).toThrow()
  })

  it("assertConvertible 返回可下发的 schema", () => {
    const schema = assertConvertible(z.object({ a: z.string() }), "good.tool")
    expect(schema.type).toBe("object")
  })
})

describe("shared/contracts", () => {
  it("normalizeCommandRequest 补全默认值，网络档位由调用方按后端能力决定", () => {
    const req = normalizeCommandRequest({
      executable: "npm",
      args: ["run", "test"],
      cwd: "D:/w",
      reason: "r",
    })
    expect(req.args).toEqual(["run", "test"])
    /**
     * 不再写死 `none`：默认值必须反映后端能力。
     * 没有传 `defaults` 时回落到 `inherit` —— 宁可承认不隔离，也不假装隔离。
     */
    expect(req.networkProfile).toBe("inherit")
    expect(req.onTimeout).toBe("kill")
    expect(req.timeoutMs).toBeGreaterThan(0)

    // 后端能真断网时，默认才是 none
    expect(
      normalizeCommandRequest(
        { executable: "npm", args: ["test"], cwd: "D:/w", reason: "r" },
        { networkProfile: "none" },
      ).networkProfile,
    ).toBe("none")

    // 显式声明优先于默认
    expect(
      normalizeCommandRequest(
        { executable: "npm", args: ["test"], cwd: "D:/w", reason: "r", networkProfile: "none" },
        { networkProfile: "inherit" },
      ).networkProfile,
    ).toBe("none")
  })
})
