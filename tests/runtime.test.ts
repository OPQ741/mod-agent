/**
 * runtime 层的四个"纯逻辑"守卫：状态机、预算、进度守卫、验证流水线。
 *
 * 这四个模块是循环**唯一的刹车**：状态机保证任务跑不出图，预算保证不会跑飞，
 * 进度守卫保证不会原地空转烧钱，验证流水线保证交付不是靠模型口头声明。
 * 它们全是纯函数/无副作用，所以这里的用例不搭 runtime，直接打最细的边界。
 */

import { describe, expect, it } from "vitest"

import {
  assertTransition,
  IllegalTransitionError,
  isCancellable,
  isPausable,
  isResumable,
  blocksNewToolCalls,
  canTransition,
} from "../src/runtime/state-machine.js"
import { assertWithinBudget, budgetPressure, checkBudget } from "../src/runtime/budget.js"
import { ProgressGuard, fingerprintResult } from "../src/runtime/progress.js"
import {
  mapAcceptance,
  runChecks,
  summarizeReport,
  type ValidationCheck,
} from "../src/validation/runner.js"
import { AppError } from "../src/shared/errors.js"
import { DEFAULT_BUDGET, type BudgetUsage, type TaskStatus } from "../src/shared/contracts.js"
import { fakeCommandRunner } from "./helpers.js"

function usage(overrides: Partial<BudgetUsage> = {}): BudgetUsage {
  return {
    rounds: 0,
    toolCalls: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    startedAt: 1_000,
    repairRounds: 0,
    ...overrides,
  }
}

/* ------------------------------------------------------------------ *
 * 状态机
 * ------------------------------------------------------------------ */

describe("状态机：合法转换图", () => {
  it("列出的转换全部放行", () => {
    expect(canTransition("queued", "initializing").allowed).toBe(true)
    expect(canTransition("executing", "awaiting_approval").allowed).toBe(true)
    expect(canTransition("awaiting_approval", "executing").allowed).toBe(true)
    expect(canTransition("executing", "completed").allowed).toBe(true)
    expect(canTransition("paused", "queued").allowed).toBe(true)
  })

  it("未列出的转换一律拒绝，并给出可诊断的理由", () => {
    const check = canTransition("queued", "completed")
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain("queued → completed")
    expect(check.reason).toContain("Allowed:")
  })

  it("自环放行（重复写同一状态不该算非法）", () => {
    expect(canTransition("executing", "executing").allowed).toBe(true)
  })

  it("四个终态是吸收态：没有任何出边", () => {
    const terminals: TaskStatus[] = ["completed", "failed", "cancelled", "expired"]
    for (const from of terminals) {
      for (const to of terminals) {
        if (from === to) continue
        expect(canTransition(from, to).allowed).toBe(false)
      }
    }
  })

  it("终态不允许回到执行态：跑完的任务不能被悄悄复活", () => {
    expect(canTransition("completed", "executing").allowed).toBe(false)
    expect(canTransition("failed", "executing").allowed).toBe(false)
  })

  it("assertTransition 抛 IllegalTransitionError，消息带两端状态", () => {
    expect(() => assertTransition("completed", "executing")).toThrow(IllegalTransitionError)
    expect(() => assertTransition("completed", "executing")).toThrow(/completed → executing/)
  })

  it("未知状态不会返回 allowed:true（防御 unknown 数据）", () => {
    const check = canTransition("nonsense" as TaskStatus, "executing")
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain("Unknown source status")
  })

  it("isPausable / isCancellable / isResumable / blocksNewToolCalls 语义", () => {
    expect(isPausable("executing")).toBe(true)
    expect(isPausable("paused")).toBe(false)
    expect(isPausable("completed")).toBe(false)

    expect(isCancellable("executing")).toBe(true)
    expect(isCancellable("completed")).toBe(false)
    expect(isCancellable("cancelling")).toBe(false)

    expect(isResumable("paused")).toBe(true)
    expect(isResumable("awaiting_approval")).toBe(true)
    expect(isResumable("queued")).toBe(true)
    expect(isResumable("completed")).toBe(false)
    expect(isResumable("cancelled")).toBe(false)

    // 这些状态下绝不能再发起新的工具调用
    expect(blocksNewToolCalls("paused")).toBe(true)
    expect(blocksNewToolCalls("awaiting_approval")).toBe(true)
    expect(blocksNewToolCalls("executing")).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * 预算
 * ------------------------------------------------------------------ */

describe("预算门禁：六个维度各自都能独立刹车", () => {
  const base = DEFAULT_BUDGET

  it("未撞线时不返回违规", () => {
    expect(checkBudget(base, usage(), 1_000)).toBeUndefined()
    expect(() => assertWithinBudget(base, usage(), 1_000)).not.toThrow()
  })

  it("轮次撞线", () => {
    const violation = checkBudget(base, usage({ rounds: base.maxRounds }), 1_000)
    expect(violation?.dimension).toBe("rounds")
    expect(violation?.message).toContain("rounds")
  })

  it("工具调用数撞线（只跑轮次不调工具的场景照样能挡住）", () => {
    expect(checkBudget(base, usage({ toolCalls: base.maxToolCalls }), 1_000)?.dimension).toBe(
      "toolCalls",
    )
  })

  it("成本撞线", () => {
    expect(checkBudget(base, usage({ costUsd: base.maxCostUsd }), 1_000)?.dimension).toBe("costUsd")
  })

  it("墙钟撞线：用的是 now - startedAt，不是调用时刻", () => {
    const started = 5_000
    expect(
      checkBudget(base, usage({ startedAt: started }), started + base.maxWallClockMs)?.dimension,
    ).toBe("wallClockMs")
    // 同一个 usage，now 往前挪一毫秒就还没撞
    expect(
      checkBudget(base, usage({ startedAt: started }), started + base.maxWallClockMs - 1),
    ).toBeUndefined()
  })

  it("输入 token 撞线", () => {
    expect(checkBudget(base, usage({ inputTokens: base.maxInputTokens }), 1_000)?.dimension).toBe(
      "inputTokens",
    )
  })

  it("repairRounds 不是硬刹车：它由 Repair Loop 自己管，这里不提前掐断", () => {
    // 否则任务会以 expired/error_max_turns 收场，看起来像超时，实际是验证没过
    expect(checkBudget(base, usage({ repairRounds: base.maxRepairRounds }), 1_000)).toBeUndefined()
  })

  it("assertWithinBudget 抛 AppError 且带 details（调用方据此决定 expired 还是 failed）", () => {
    try {
      assertWithinBudget(base, usage({ costUsd: base.maxCostUsd }), 1_000)
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      const appError = err as AppError
      expect(appError.code).toBe("BUDGET_EXCEEDED")
      expect(appError.details?.dimension).toBe("costUsd")
      expect(appError.details?.limit).toBe(base.maxCostUsd)
    }
  })

  it("多个维度同时撞线时只报第一个（诊断只要最先撞的那个就够）", () => {
    const violation = checkBudget(base, usage({ rounds: 999, toolCalls: 999 }), 1_000)
    expect(violation?.dimension).toBe("rounds")
  })

  it("budgetPressure 取各维度占比的最大值，且封顶在 1", () => {
    const half = budgetPressure(
      {
        ...base,
        maxRounds: 10,
        maxToolCalls: 100,
        maxCostUsd: 10,
        maxWallClockMs: 1_000,
        maxInputTokens: 1_000,
      },
      usage({ rounds: 5, toolCalls: 1, costUsd: 0, inputTokens: 0, startedAt: 0 }),
      0,
    )
    expect(half).toBeCloseTo(0.5, 5)

    const capped = budgetPressure(base, usage({ rounds: 999_999, startedAt: 0 }), 999_999_999)
    expect(capped).toBe(1)
  })

  it("budgetPressure 对 0 上限的维度不做除零（maxCostUsd=0 表示不在乎钱）", () => {
    const pressure = budgetPressure(
      { ...base, maxCostUsd: 0, maxInputTokens: 0 },
      usage({ costUsd: 5, inputTokens: 500, startedAt: 0 }),
      0,
    )
    expect(Number.isFinite(pressure)).toBe(true)
    expect(pressure).toBe(0)
  })
})

/* ------------------------------------------------------------------ *
 * 进度守卫
 * ------------------------------------------------------------------ */

describe("进度守卫：识别空转", () => {
  const guard = () => new ProgressGuard({ maxNoProgressRounds: 3 })

  const obs = (overrides: Partial<Parameters<ProgressGuard["record"]>[0]> = {}) => ({
    toolName: "test.run",
    argsFingerprint: "args",
    resultFingerprint: "res",
    ok: true,
    changedFiles: [] as string[],
    ...overrides,
  })

  it("正常进展放行", () => {
    expect(guard().record(obs()).action).toBe("continue")
  })

  it("连续 3 次同参数同结果 → compress-and-replan", () => {
    const g = guard()
    g.record(obs())
    g.record(obs())
    expect(g.record(obs()).action).toBe("compress-and-replan")
  })

  it("结果变了就不算重复（同一条命令跑出不同报错是真进展）", () => {
    const g = guard()
    g.record(obs({ resultFingerprint: "a" }))
    g.record(obs({ resultFingerprint: "b" }))
    expect(g.record(obs({ resultFingerprint: "c" })).action).toBe("continue")
  })

  it("参数变了也不算重复", () => {
    const g = guard()
    g.record(obs({ argsFingerprint: "a" }))
    g.record(obs({ argsFingerprint: "b" }))
    expect(g.record(obs({ argsFingerprint: "c" })).action).toBe("continue")
  })

  it("反复重写同一文件 4 次 → compress-and-replan，且点名该文件", () => {
    const g = guard()
    for (let i = 0; i < 3; i += 1) {
      g.record(
        obs({
          ok: true,
          changedFiles: ["src/a.ts"],
          argsFingerprint: `a${i}`,
          resultFingerprint: `r${i}`,
        }),
      )
    }
    const verdict = g.record(
      obs({ ok: true, changedFiles: ["src/a.ts"], argsFingerprint: "a3", resultFingerprint: "r3" }),
    )
    expect(verdict.action).toBe("compress-and-replan")
    expect(verdict.reason).toContain("src/a.ts")
  })

  it("同一错误码复发 3 次 → stop-and-escalate（不该再让模型自己试）", () => {
    const g = guard()
    g.record(
      obs({ ok: false, errorCode: "TEST_FAILED", argsFingerprint: "a", resultFingerprint: "r1" }),
    )
    const verdict = g.record(
      obs({ ok: false, errorCode: "TEST_FAILED", argsFingerprint: "b", resultFingerprint: "r2" }),
    )
    // 第二次就该停：errorCounts 累计到 2 尚未触发，第三次触发
    expect(verdict.action).toBe("continue")
    const third = g.record(
      obs({ ok: false, errorCode: "TEST_FAILED", argsFingerprint: "c", resultFingerprint: "r3" }),
    )
    expect(third.action).toBe("stop-and-escalate")
    expect(third.reason).toContain("TEST_FAILED")
  })

  it("连续无进展轮次达标（无 errorCode，避免被错误复发规则抢先）", () => {
    const g = new ProgressGuard({ maxNoProgressRounds: 3 })
    for (let i = 0; i < 2; i += 1) {
      expect(
        g.record(obs({ ok: false, argsFingerprint: `a${i}`, resultFingerprint: `r${i}` })).action,
      ).toBe("continue")
    }
    const third = g.record(obs({ ok: false, argsFingerprint: "a2", resultFingerprint: "r2" }))
    expect(third.action).toBe("compress-and-replan")
    expect(third.reason).toContain("consecutive rounds without progress")
  })

  it("只要有一次 ok 就重置无进展计数", () => {
    const g = new ProgressGuard({ maxNoProgressRounds: 3 })
    g.record(obs({ ok: false, argsFingerprint: "a", resultFingerprint: "r1" }))
    g.record(obs({ ok: false, argsFingerprint: "b", resultFingerprint: "r2" }))
    g.record(obs({ ok: true, argsFingerprint: "c", resultFingerprint: "r3" }))
    expect(g.record(obs({ ok: false, argsFingerprint: "d", resultFingerprint: "r4" })).action).toBe(
      "continue",
    )
  })

  it("assertProgress 抛 AppError，details 带 action 供循环分流", () => {
    const g = new ProgressGuard({ maxNoProgressRounds: 1 })
    try {
      g.assertProgress(obs({ ok: false }))
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe("NO_PROGRESS")
      expect((err as AppError).details?.action).toBe("compress-and-replan")
    }
  })

  it("buildDiagnosis 列出最近步骤与复发错误", () => {
    const g = guard()
    g.record(
      obs({ ok: false, errorCode: "TEST_FAILED", argsFingerprint: "a", resultFingerprint: "r1" }),
    )
    g.record(
      obs({ ok: true, changedFiles: ["x.ts"], argsFingerprint: "b", resultFingerprint: "r2" }),
    )
    const diagnosis = g.buildDiagnosis()
    expect(diagnosis).toContain("Recent steps:")
    expect(diagnosis).toContain("test.run → failed(TEST_FAILED)")
    expect(diagnosis).toContain("[changed 1 file(s)]")
    expect(diagnosis).toContain("Recurring errors: TEST_FAILED×1")
  })

  it("空守卫的诊断不撒谎", () => {
    expect(guard().buildDiagnosis()).toBe("No observations recorded.")
  })

  it("reset 后一切归零（压缩回喂后必须能重新计数）", () => {
    const g = new ProgressGuard({ maxNoProgressRounds: 3 })
    g.record(obs({ ok: false }))
    g.record(obs({ ok: false }))
    g.reset()
    expect(g.history.length).toBe(0)
    expect(g.record(obs({ ok: false })).action).toBe("continue")
  })

  it("fingerprintResult：undefined/null 归一为 empty；相同内容同指纹；只取前 2000 字符", () => {
    expect(fingerprintResult(undefined)).toBe("empty")
    expect(fingerprintResult(null)).toBe("empty")
    expect(fingerprintResult("abc")).toBe(fingerprintResult("abc"))
    expect(fingerprintResult("abc")).not.toBe(fingerprintResult("abd"))
    const long = "x".repeat(5_000)
    expect(fingerprintResult(long)).toBe(fingerprintResult(long.slice(0, 2_000)))
  })
})

/* ------------------------------------------------------------------ *
 * 验证流水线
 * ------------------------------------------------------------------ */

describe("验证流水线：按成本递增、按退出码判定", () => {
  const check = (overrides: Partial<ValidationCheck> & { id: string }): ValidationCheck => ({
    kind: "test",
    command: ["node", "-e", "0"],
    required: true,
    cwd: process.cwd(),
    ...overrides,
  })

  it("严格按成本从低到高跑：build 不会被排在 typecheck 前面", () => {
    const calls: string[] = []
    const runner = fakeCommandRunner((req) => {
      calls.push(req.executable)
      return { exitCode: 0, stdout: "ok" }
    })
    const checks = [
      check({ id: "build", kind: "build" }),
      check({ id: "lint", kind: "lint" }),
      check({ id: "typecheck", kind: "typecheck" }),
      check({ id: "fmt", kind: "format" }),
      check({ id: "test", kind: "test" }),
    ]
    return runChecks(checks, {
      runCommand: runner,
      persistArtifact: async () => ({ uri: "u", sha256: "s" }),
    }).then((report) => {
      expect(calls).toEqual(["fmt", "typecheck", "lint", "test", "build"].map(() => "node"))
      expect(report.checks.map((c) => c.id)).toEqual(["fmt", "typecheck", "lint", "test", "build"])
      expect(report.status).toBe("passed")
    })
  })

  it("全部通过 → passed，且每条 check 都带真实退出码", async () => {
    const report = await runChecks([check({ id: "t1" }), check({ id: "t2" })], {
      runCommand: fakeCommandRunner({ exitCode: 0, stdout: "ok" }),
      persistArtifact: async () => ({ uri: "u", sha256: "s" }),
    })
    expect(report.status).toBe("passed")
    expect(report.checks.every((c) => c.exitCode === 0)).toBe(true)
  })

  it("必过检查失败 → 立即停止流水线，不再烧更贵的检查", async () => {
    const seen: string[] = []
    const report = await runChecks(
      [check({ id: "typecheck", kind: "typecheck" }), check({ id: "build", kind: "build" })],
      {
        runCommand: fakeCommandRunner((req) => {
          seen.push(req.args?.[0] ?? "")
          return { exitCode: 1, stdout: "", stderr: "error TS2345: nope" }
        }),
        persistArtifact: async () => ({ uri: "/tmp/artifact.txt", sha256: "s" }),
      },
    )
    expect(report.status).toBe("failed")
    expect(report.checks.length).toBe(1)
    expect(report.checks[0]?.status).toBe("failed")
    expect(report.checks[0]?.artifactUri).toBe("/tmp/artifact.txt")
    expect(report.checks[0]?.summary).toContain("TS2345")
    expect(seen.length).toBe(1)
  })

  it("非必过检查失败 → partial（验证过一部分，不等于全绿），并继续跑必过的那条", async () => {
    const report = await runChecks(
      [
        check({ id: "lint", kind: "lint", required: false, command: ["node", "-e", "lint"] }),
        check({ id: "test", kind: "test", required: true, command: ["node", "-e", "test"] }),
      ],
      {
        runCommand: fakeCommandRunner((req) =>
          req.args?.includes("lint") ? { exitCode: 1, stderr: "lint warn" } : { exitCode: 0 },
        ),
        persistArtifact: async () => ({ uri: "u", sha256: "s" }),
      },
    )
    expect(report.status).toBe("partial")
    expect(report.checks.map((c) => c.status)).toEqual(["failed", "passed"])
  })

  it("必过检查被策略挡住 → 记 blocked 且不判代码失败，但整体也不算 passed", async () => {
    const report = await runChecks(
      [
        check({ id: "test", kind: "test", required: true, command: ["node", "-e", "test"] }),
        check({ id: "build", kind: "build", required: false, command: ["node", "-e", "build"] }),
      ],
      {
        runCommand: fakeCommandRunner((req) => {
          if (req.args?.includes("test")) throw new AppError("TOOL_PERMISSION_DENIED", "denied")
          return { exitCode: 0 }
        }),
        persistArtifact: async () => ({ uri: "u", sha256: "s" }),
      },
    )
    expect(report.checks.map((c) => c.status)).toEqual(["blocked", "passed"])
    expect(report.status).toBe("partial")
  })

  it("空命令 → skipped，不调用运行器，整体是 not_run", async () => {
    let called = 0
    const report = await runChecks([check({ id: "empty", command: [] })], {
      runCommand: fakeCommandRunner(() => {
        called += 1
        return { exitCode: 0 }
      }),
      persistArtifact: async () => ({ uri: "u", sha256: "s" }),
    })
    expect(called).toBe(0)
    expect(report.checks[0]?.status).toBe("skipped")
    expect(report.status).toBe("not_run")
  })

  it("检查列表为空 → not_run（明确是没验证，不是验证通过）", async () => {
    const report = await runChecks([], {
      runCommand: fakeCommandRunner({}),
      persistArtifact: async () => ({ uri: "u", sha256: "s" }),
    })
    expect(report.status).toBe("not_run")
    expect(report.checks).toEqual([])
  })

  it("运行器抛错 → blocked；权限被拒不算'任务失败'，不该让模型换命令绕过", async () => {
    const denied = new AppError("TOOL_PERMISSION_DENIED", "command not allowed")
    const report = await runChecks([check({ id: "t" })], {
      runCommand: async () => {
        throw denied
      },
      persistArtifact: async () => ({ uri: "u", sha256: "s" }),
    })
    expect(report.checks[0]?.status).toBe("blocked")
    expect(report.checks[0]?.summary).toContain("TOOL_PERMISSION_DENIED")
    // 权限挡住 ≠ 代码有问题：required 也不判 failed
    expect(report.status).toBe("not_run")
  })

  it("非权限类异常（如沙箱不可用）判 failed", async () => {
    const report = await runChecks([check({ id: "t" })], {
      runCommand: async () => {
        throw new AppError("SANDBOX_UNAVAILABLE", "no sandbox")
      },
      persistArtifact: async () => ({ uri: "u", sha256: "s" }),
    })
    expect(report.status).toBe("failed")
  })

  it("mapAcceptance：通过才标 verified，并附上证据；没过一律 not_verified", async () => {
    const passed = await runChecks([check({ id: "test" })], {
      runCommand: fakeCommandRunner({ exitCode: 0 }),
      persistArtifact: async () => ({ uri: "u", sha256: "s" }),
    })
    const ok = mapAcceptance([{ id: "a1", description: "does it work" }], passed)
    expect(ok.acceptance).toEqual([
      { criterionId: "a1", status: "verified", evidence: [expect.stringContaining("test:")] },
    ])

    const failedReport = await runChecks([check({ id: "test" })], {
      runCommand: fakeCommandRunner({ exitCode: 1, stderr: "boom" }),
      persistArtifact: async () => ({ uri: "u", sha256: "s" }),
    })
    const notOk = mapAcceptance([{ id: "a1", description: "does it work" }], failedReport)
    expect(notOk.acceptance).toEqual([{ criterionId: "a1", status: "not_verified" }])
  })

  it("summarizeReport 给出人读摘要，含状态与退出码", async () => {
    const report = await runChecks([check({ id: "test" })], {
      runCommand: fakeCommandRunner({ exitCode: 0 }),
      persistArtifact: async () => ({ uri: "u", sha256: "s" }),
    })
    const text = summarizeReport(report)
    expect(text).toContain("Validation: passed")
    expect(text).toContain("[passed] test")
    expect(text).toContain("exit=0")
  })
})
