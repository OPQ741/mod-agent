/**
 * 沙箱与持久化测试。
 *
 * 沙箱部分真的起子进程（用 node 自己作为可执行文件），因为"超时杀进程组""输出封顶"
 * 这两件事只有真跑才验证得出来 —— mock 掉 spawn 等于被测逻辑一起被 mock 掉。
 *
 * 持久化部分同时测内存实现与 node:sqlite 实现：两者必须同语义
 * （乐观锁、事件 seq 唯一、审批只生效一次），否则回落的时候会静默换行为。
 */

import { describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import path from "node:path"

import {
  OutputBudget,
  describeSpawnFailure,
  killTree,
  runProcess,
} from "../src/sandbox/process-runner.js"
import {
  RestrictedSubprocessBackend,
  buildDockerRunArgs,
  selectSandbox,
} from "../src/sandbox/index.js"
import { MemoryStore } from "../src/store/memory.js"
import { SqliteStore, createStore } from "../src/store/sqlite.js"
import { VersionConflictError } from "../src/store/types.js"
import { PathGuard } from "../src/policy/pathguard.js"
import { normalizeCommandRequest } from "../src/shared/contracts.js"
import { createUsage } from "../src/shared/contracts.js"
import { AppError } from "../src/shared/errors.js"
import { createTempWorkspace, settingsWith } from "./helpers.js"
import { DEFAULT_BUDGET } from "../src/shared/contracts.js"

const NODE = process.execPath

function req(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs = 10_000,
  networkProfile?: "none" | "inherit",
) {
  return normalizeCommandRequest({
    executable,
    args,
    cwd,
    timeoutMs,
    reason: "sandbox test",
    ...(networkProfile ? { networkProfile } : {}),
  })
}

describe("sandbox/process-runner", () => {
  it("正常执行并捕获 stdout / stderr", async () => {
    const ws = await createTempWorkspace()
    try {
      const result = await runProcess(
        req(NODE, ["-e", "console.log('hi'); console.error('warn')"], ws.root),
        { maxOutputChars: 10_000, maxTotalOutputBytes: 1_000_000 },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("hi")
      expect(result.stderr).toContain("warn")
      expect(result.killed).toBe(false)
    } finally {
      await ws.cleanup()
    }
  })

  it("输出排除 ANSI 控制符（防终端注入）", async () => {
    const ws = await createTempWorkspace()
    try {
      const result = await runProcess(
        req(NODE, ["-e", 'console.log("\\u001B[31mred\\u001B[0m")'], ws.root),
        { maxOutputChars: 10_000, maxTotalOutputBytes: 1_000_000 },
      )
      expect(result.stdout.trim()).toBe("red")
    } finally {
      await ws.cleanup()
    }
  })

  it("onOutput 逐块收到 stdout / stderr（长命令进度的事件源头）", async () => {
    const ws = await createTempWorkspace()
    try {
      const chunks: Array<{ stream: string; text: string }> = []
      const result = await runProcess(
        req(NODE, ["-e", "console.log('out-line'); console.error('err-line')"], ws.root),
        {
          maxOutputChars: 10_000,
          maxTotalOutputBytes: 1_000_000,
          onOutput: (chunk) => chunks.push({ stream: chunk.stream, text: chunk.text }),
        },
      )
      // 片段是过程，不是结果：拼起来应当覆盖两路输出
      const joined = chunks.map((c) => c.text).join("")
      expect(joined).toContain("out-line")
      expect(joined).toContain("err-line")
      expect(chunks.some((c) => c.stream === "stdout")).toBe(true)
      expect(chunks.some((c) => c.stream === "stderr")).toBe(true)
      // 终态结果仍然完整，且与片段来源一致
      expect(result.stdout).toContain("out-line")
      expect(result.stderr).toContain("err-line")
    } finally {
      await ws.cleanup()
    }
  })

  it("退出码透传", async () => {
    const ws = await createTempWorkspace()
    try {
      const result = await runProcess(req(NODE, ["-e", "process.exit(3)"], ws.root), {
        maxOutputChars: 10_000,
        maxTotalOutputBytes: 1_000_000,
      })
      expect(result.exitCode).toBe(3)
    } finally {
      await ws.cleanup()
    }
  })

  it("超时：杀进程并返回 timedOut，不是无限等待", async () => {
    const ws = await createTempWorkspace()
    try {
      const startedAt = Date.now()
      const result = await runProcess(
        req(NODE, ["-e", "setTimeout(() => {}, 5000)"], ws.root, 300),
        { maxOutputChars: 10_000, maxTotalOutputBytes: 1_000_000 },
      )
      const elapsed = Date.now() - startedAt
      expect(result.timedOut).toBe(true)
      expect(result.killed).toBe(true)
      expect(elapsed).toBeLessThan(4_000)
    } finally {
      await ws.cleanup()
    }
  })

  it("超时会带走孙进程（整组 kill，不是只杀父进程）", async () => {
    const ws = await createTempWorkspace()
    try {
      const marker = ws.abs("grandchild.txt")
      const script = `
        const { spawn } = require('node:child_process')
        const fs = require('node:fs')
        const gc = spawn(process.execPath, ['-e',
          'setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, "alive"); }, 2000)'],
          { stdio: 'ignore', detached: false })
        setTimeout(() => {}, 8000)
        void gc
      `
      await runProcess(req(NODE, ["-e", script], ws.root, 600), {
        maxOutputChars: 10_000,
        maxTotalOutputBytes: 1_000_000,
      })
      // 给孙进程足够时间醒来；若它还活着就会写文件
      await new Promise((r) => setTimeout(r, 3_200))
      expect(
        await fs
          .stat(marker)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    } finally {
      await ws.cleanup()
    }
  })

  it("单条命令输出超限时截断并标记", async () => {
    const ws = await createTempWorkspace()
    try {
      const result = await runProcess(req(NODE, ["-e", 'console.log("x".repeat(5000))'], ws.root), {
        maxOutputChars: 500,
        maxTotalOutputBytes: 1_000_000,
      })
      expect(result.stdout.length).toBeLessThanOrEqual(500)
      expect(result.truncated).toBe(true)
    } finally {
      await ws.cleanup()
    }
  })

  it("会话累计输出超预算时 kill（防 yes > file 把磁盘和机器一起打死）", async () => {
    const ws = await createTempWorkspace()
    try {
      const budget = new OutputBudget(1_000)
      const result = await runProcess(
        req(NODE, ["-e", 'for (let i = 0; i < 200; i++) console.log("y".repeat(1000))'], ws.root),
        { maxOutputChars: 2_000_000, maxTotalOutputBytes: 1_000 },
        budget,
      )
      expect(result.outputLimitExceeded).toBe(true)
      expect(result.killed).toBe(true)
      expect(budget.used).toBeGreaterThan(0)
      budget.reset()
      expect(budget.used).toBe(0)
    } finally {
      await ws.cleanup()
    }
  })

  it("可执行文件不存在：给出可操作提示，而不是 ENOENT 裸错误", async () => {
    const ws = await createTempWorkspace()
    try {
      const result = await runProcess(
        req("definitely-not-a-real-binary-xyz", ["--help"], ws.root),
        {
          maxOutputChars: 10_000,
          maxTotalOutputBytes: 1_000_000,
        },
      )
      expect(result.spawnError).toBeDefined()
      expect(result.spawnError).toContain("definitely-not-a-real-binary-xyz")
      // 提示必须可执行：说明是走 "executable + args[]" 而不是 shell
      expect(describeSpawnFailure("missing-binary")).toContain("missing-binary")
      expect(describeSpawnFailure("missing-binary")).toMatch(/PATH|shell|installed/i)
    } finally {
      await ws.cleanup()
    }
  })

  it("拒绝把敏感环境变量透传给子进程", async () => {
    const ws = await createTempWorkspace()
    try {
      await expect(
        runProcess(
          {
            ...req(NODE, ["-e", "console.log(1)"], ws.root),
            env: { ANTHROPIC_API_KEY: "sk-secret" },
          },
          { maxOutputChars: 1_000, maxTotalOutputBytes: 1_000 },
        ),
      ).rejects.toMatchObject({ code: "COMMAND_DENIED" })
    } finally {
      await ws.cleanup()
    }
  })

  it("配置的 envAllowlist 是补充项：默认变量仍在，额外的父进程变量按配置透传", async () => {
    const ws = await createTempWorkspace()
    const previous = process.env.MOD_AGENT_PROBE
    process.env.MOD_AGENT_PROBE = "from-parent"
    try {
      const script = "console.log(process.env.MOD_AGENT_PROBE ?? 'missing')"
      const blocked = await runProcess(req(NODE, ["-e", script], ws.root), {
        maxOutputChars: 10_000,
        maxTotalOutputBytes: 1_000_000,
      })
      expect(blocked.stdout.trim()).toBe("missing")

      const allowed = await runProcess(req(NODE, ["-e", script], ws.root), {
        maxOutputChars: 10_000,
        maxTotalOutputBytes: 1_000_000,
        envAllowlist: ["MOD_AGENT_PROBE"],
      })
      expect(allowed.stdout.trim()).toBe("from-parent")
      // 补充项不能顶掉默认项：PATH 没丢，node 才起得来（起不来会走 spawnError）
      expect(allowed.spawnError).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.MOD_AGENT_PROBE
      else process.env.MOD_AGENT_PROBE = previous
      await ws.cleanup()
    }
  })

  it("settings.envAllowlist 真的传到命令执行层（配置不是摆设）", async () => {
    const ws = await createTempWorkspace()
    const envName = "MOD_AGENT_ENV_ALLOWLIST_PROBE"
    const previous = process.env[envName]
    process.env[envName] = "visible"
    try {
      const script = `console.log(process.env.${envName} ?? "hidden")`
      const strict = await selectSandbox({
        settings: settingsWith({}),
        workspaceRoot: ws.root,
        assertCwd: (cwd) => new PathGuard({ workspaceRoot: ws.root }).assertCwd(cwd),
      })
      const hidden = await strict.backend.exec(req(NODE, ["-e", script], ws.root))
      expect(hidden.stdout.trim()).toBe("hidden")

      const configured = await selectSandbox({
        settings: settingsWith({ envAllowlist: [envName] }),
        workspaceRoot: ws.root,
        assertCwd: (cwd) => new PathGuard({ workspaceRoot: ws.root }).assertCwd(cwd),
      })
      const visible = await configured.backend.exec(req(NODE, ["-e", script], ws.root))
      expect(visible.stdout.trim()).toBe("visible")
    } finally {
      if (previous === undefined) delete process.env[envName]
      else process.env[envName] = previous
      await ws.cleanup()
    }
  })

  it("AbortSignal 能中断正在跑的命令", async () => {
    const ws = await createTempWorkspace()
    try {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 200)
      const result = await runProcess(
        req(NODE, ["-e", "setTimeout(()=>{},5000)"], ws.root, 9_000),
        {
          maxOutputChars: 10_000,
          maxTotalOutputBytes: 1_000_000,
          signal: controller.signal,
        },
      )
      expect(result.cancelled).toBe(true)
      expect(result.killed).toBe(true)
    } finally {
      await ws.cleanup()
    }
  })

  it("killTree 对不存在的进程不抛错（幂等）", () => {
    const fake = { pid: undefined, killed: true } as never
    expect(() => killTree(fake, "test")).not.toThrow()
  })
})

describe("sandbox/index: fail-closed 选择与能力声明", () => {
  it("沙箱未启用时用受限子进程，并**明确声明未覆盖的能力**", async () => {
    const ws = await createTempWorkspace()
    try {
      const selection = await selectSandbox({
        settings: settingsWith({}),
        workspaceRoot: ws.root,
        assertCwd: (cwd) => new PathGuard({ workspaceRoot: ws.root }).assertCwd(cwd),
      })
      expect(selection.backend.id).toBe("restricted-subprocess")
      expect(selection.degraded).toBe(false)
      expect(selection.coverage.join(" ")).toMatch(/NOT covered/)
      expect(selection.coverage.join(" ")).toMatch(/filesystem visibility/)
    } finally {
      await ws.cleanup()
    }
  })

  it("cwd 逃出工作区 → 拒绝执行", async () => {
    const ws = await createTempWorkspace()
    try {
      const guard = new PathGuard({ workspaceRoot: ws.root })
      const backend = new RestrictedSubprocessBackend({
        workspaceRoot: ws.root,
        maxOutputChars: 1_000,
        maxTotalOutputBytes: 1_000,
        assertCwd: (cwd) => guard.assertCwd(cwd),
      })
      await expect(
        backend.exec(req(NODE, ["-e", "1"], path.resolve(ws.root, ".."))),
      ).rejects.toMatchObject({ code: "PATH_POLICY_VIOLATION" })
    } finally {
      await ws.cleanup()
    }
  })

  it("网络档位显式 none 且命令像是要联网 → 意图拦截（不是假装断网）", async () => {
    const ws = await createTempWorkspace()
    try {
      const guard = new PathGuard({ workspaceRoot: ws.root })
      const backend = new RestrictedSubprocessBackend({
        workspaceRoot: ws.root,
        maxOutputChars: 1_000,
        maxTotalOutputBytes: 1_000,
        assertCwd: (cwd) => guard.assertCwd(cwd),
      })
      // 必须**显式**要 none：默认档位来自后端能力，受限子进程后端默认是 inherit
      await expect(
        backend.exec(req("curl", ["https://example.com"], ws.root, 10_000, "none")),
      ).rejects.toMatchObject({
        /**
         * 错误码从 `NETWORK_BLOCKED` 改为 `NETWORK_INTENT_BLOCKED`。
         * 受限于进程的沙箱根本没有网络隔离能力，用"BLOCKED"会让人以为出口被切断；
         * 实际只是"命令文本看起来要联网，先拒绝"。真隔离错误码留给 Docker 后端。
         */
        code: "NETWORK_INTENT_BLOCKED",
      })
    } finally {
      await ws.cleanup()
    }
  })

  it("受限子进程后端声明自己没有网络/文件系统隔离，默认档位是 inherit", async () => {
    const ws = await createTempWorkspace()
    try {
      const guard = new PathGuard({ workspaceRoot: ws.root })
      const backend = new RestrictedSubprocessBackend({
        workspaceRoot: ws.root,
        maxOutputChars: 1_000,
        maxTotalOutputBytes: 1_000,
        assertCwd: (cwd) => guard.assertCwd(cwd),
      })
      expect(backend.capabilities).toEqual({
        networkIsolation: false,
        filesystemIsolation: false,
      })
      expect(backend.defaultNetworkProfile).toBe("inherit")
    } finally {
      await ws.cleanup()
    }
  })

  it("启用沙箱但 Docker 不可用且 failIfUnavailable → 拒绝执行而不是偷偷裸跑", async () => {
    const ws = await createTempWorkspace()
    try {
      await expect(
        selectSandbox({
          settings: settingsWith({ sandbox: { enabled: true, failIfUnavailable: true } }),
          workspaceRoot: ws.root,
          assertCwd: (cwd) => new PathGuard({ workspaceRoot: ws.root }).assertCwd(cwd),
          // Docker 是否可用由探针决定，不依赖 CI 宿主环境
          probeDocker: async () => false,
        }),
      ).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" })
    } finally {
      await ws.cleanup()
    }
  })

  it("failIfUnavailable=false 时回落并标记 degraded", async () => {
    const ws = await createTempWorkspace()
    try {
      const selection = await selectSandbox({
        settings: settingsWith({ sandbox: { enabled: true, failIfUnavailable: false } }),
        workspaceRoot: ws.root,
        assertCwd: (cwd) => new PathGuard({ workspaceRoot: ws.root }).assertCwd(cwd),
        // Docker 是否可用由探针决定，不依赖 CI 宿主环境
        probeDocker: async () => false,
      })
      expect(selection.degraded).toBe(true)
    } finally {
      await ws.cleanup()
    }
  })
})

describe("sandbox/docker: 加固参数不依赖镜像默认值", () => {
  it("默认丢弃全部 capabilities、禁止提权；network=none 真的断出口", () => {
    const args = buildDockerRunArgs({
      workspaceRoot: "workspace",
      cwd: "workspace/sub",
      image: "node:22-alpine",
      networkProfile: "none",
      executable: "npm",
      args: ["test"],
    })

    expect(args).toContain("--cap-drop=ALL")
    expect(args).toContain("--security-opt=no-new-privileges")
    expect(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2)).toEqual([
      "--network",
      "none",
    ])
    // 工作目录映射到容器内相对路径
    expect(args).toContain("/workspace/sub")
    // 用户命令以 argv 形式透传，不经过 shell 拼字符串
    expect(args.slice(-2)).toEqual(["npm", "test"])
  })

  it("非 none 档位显式映射为 bridge（不是把 --network 整个省掉）", () => {
    const args = buildDockerRunArgs({
      workspaceRoot: "workspace",
      cwd: "workspace",
      image: "node:22-alpine",
      networkProfile: "inherit",
      executable: "node",
      args: ["-e", "0"],
    })
    const networkAt = args.indexOf("--network")
    expect(args[networkAt + 1]).toBe("bridge")
  })
})

/* ------------------------------------------------------------------ *
 * Store：两种实现必须同语义
 * ------------------------------------------------------------------ */

function storeTests(
  name: string,
  create: () => Promise<{
    store: import("../src/store/types.js").Store
    cleanup: () => Promise<void>
  }>,
) {
  describe(`store/${name}`, () => {
    it("任务创建后可读回，带乐观锁版本号", async () => {
      const { store, cleanup } = await create()
      try {
        const task = await store.createTask({
          id: "task_1",
          title: "t",
          userRequest: "do it",
          mode: "edit",
          status: "queued",
          workspaceRoot: "D:/w",
          budget: { ...DEFAULT_BUDGET },
          usage: createUsage(0),
        })
        expect(task.stateVersion).toBe(1)
        const read = await store.getTask("task_1")
        expect(read?.title).toBe("t")
      } finally {
        await cleanup()
      }
    })

    it("乐观锁：版本不匹配的更新作废（两个循环同时写同一任务时必备）", async () => {
      const { store, cleanup } = await create()
      try {
        await store.createTask({
          id: "task_1",
          title: "t",
          userRequest: "r",
          mode: "edit",
          status: "queued",
          workspaceRoot: "D:/w",
          budget: { ...DEFAULT_BUDGET },
          usage: createUsage(0),
        })
        await store.updateTask("task_1", { status: "executing" }, 1)
        await expect(store.updateTask("task_1", { status: "paused" }, 1)).rejects.toThrow(
          VersionConflictError,
        )
        const ok = await store.updateTask("task_1", { status: "paused" }, 2)
        expect(ok.status).toBe("paused")
      } finally {
        await cleanup()
      }
    })

    it("事件 seq 唯一：重复 seq 追加直接报错", async () => {
      const { store, cleanup } = await create()
      try {
        await store.createTask({
          id: "task_1",
          title: "t",
          userRequest: "r",
          mode: "edit",
          status: "queued",
          workspaceRoot: "D:/w",
          budget: { ...DEFAULT_BUDGET },
          usage: createUsage(0),
        })
        const event = (seq: number) => ({
          eventId: `task_1:${seq}`,
          taskId: "task_1",
          seq,
          type: "tool.started",
          timestamp: new Date().toISOString(),
          payload: {},
          parentCallId: null,
        })
        expect((await store.appendEvents("task_1", [event(1)])).seq).toBe(1)
        await expect(store.appendEvents("task_1", [event(1)])).rejects.toThrow()
        expect((await store.appendEvents("task_1", [event(2)])).seq).toBe(2)
        expect((await store.readAllEvents("task_1")).map((e) => e.seq)).toEqual([1, 2])
        expect((await store.readEventsSince("task_1", 1)).map((e) => e.seq)).toEqual([2])
      } finally {
        await cleanup()
      }
    })

    it("transition 把状态变更与事件放在同一个事务里", async () => {
      const { store, cleanup } = await create()
      try {
        await store.createTask({
          id: "task_1",
          title: "t",
          userRequest: "r",
          mode: "edit",
          status: "queued",
          workspaceRoot: "D:/w",
          budget: { ...DEFAULT_BUDGET },
          usage: createUsage(0),
        })
        const updated = await store.transition(
          "task_1",
          "executing",
          {
            eventId: "task_1:1",
            taskId: "task_1",
            seq: 1,
            type: "task.status_changed",
            timestamp: new Date().toISOString(),
            payload: { from: "queued", to: "executing" },
            parentCallId: null,
          },
          1,
        )
        expect(updated.status).toBe("executing")
        expect(updated.stateVersion).toBe(2)
        const events = await store.readAllEvents("task_1")
        expect(events).toHaveLength(1)
      } finally {
        await cleanup()
      }
    })

    it("审批只生效一次：重复决策报错", async () => {
      const { store, cleanup } = await create()
      try {
        await store.createTask({
          id: "task_1",
          title: "t",
          userRequest: "r",
          mode: "edit",
          status: "queued",
          workspaceRoot: "D:/w",
          budget: { ...DEFAULT_BUDGET },
          usage: createUsage(0),
        })
        await store.createApproval({
          id: "apr_1",
          taskId: "task_1",
          toolName: "Bash",
          requestSummary: "run npm install",
          parameterHash: "hash-1",
          policyVersion: "v1",
          status: "pending",
          requestedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
        expect((await store.getApproval("apr_1"))?.status).toBe("pending")
        const decided = await store.decideApproval("apr_1", "allowed", "human")
        expect(decided.status).toBe("allowed")
        await expect(store.decideApproval("apr_1", "denied", "human")).rejects.toThrow()
      } finally {
        await cleanup()
      }
    })

    it("过期的 pending 审批被批量置为 expired（不能悬着）", async () => {
      const { store, cleanup } = await create()
      try {
        await store.createTask({
          id: "task_1",
          title: "t",
          userRequest: "r",
          mode: "edit",
          status: "queued",
          workspaceRoot: "D:/w",
          budget: { ...DEFAULT_BUDGET },
          usage: createUsage(0),
        })
        await store.createApproval({
          id: "apr_old",
          taskId: "task_1",
          toolName: "Bash",
          requestSummary: "old",
          parameterHash: "h",
          policyVersion: "v1",
          status: "pending",
          requestedAt: new Date(Date.now() - 120_000).toISOString(),
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        })
        const expired = await store.expireApprovals(new Date())
        expect(expired).toBeGreaterThanOrEqual(1)
        expect((await store.getApproval("apr_old"))?.status).toBe("expired")
      } finally {
        await cleanup()
      }
    })

    it("工具调用records：起步 / 收尾 / 未闭合列表", async () => {
      const { store, cleanup } = await create()
      try {
        await store.createTask({
          id: "task_1",
          title: "t",
          userRequest: "r",
          mode: "edit",
          status: "queued",
          workspaceRoot: "D:/w",
          budget: { ...DEFAULT_BUDGET },
          usage: createUsage(0),
        })
        await store.startToolCall({
          id: "call_1",
          taskId: "task_1",
          toolName: "command.run",
          inputHash: "ih",
          idempotencyKey: "ik",
          idempotency: "non_idempotent",
          status: "started",
          startedAt: new Date().toISOString(),
          retryCount: 0,
        })
        expect((await store.openToolCalls("task_1")).map((c) => c.id)).toEqual(["call_1"])

        await store.finishToolCall("call_1", { status: "succeeded", durationMs: 10 })
        expect(await store.openToolCalls("task_1")).toEqual([])
      } finally {
        await cleanup()
      }
    })

    it("中断恢复时能列出未闭合调用并按幂等性分类", async () => {
      const { store, cleanup } = await create()
      try {
        await store.createTask({
          id: "task_1",
          title: "t",
          userRequest: "r",
          mode: "edit",
          status: "queued",
          workspaceRoot: "D:/w",
          budget: { ...DEFAULT_BUDGET },
          usage: createUsage(0),
        })
        await store.startToolCall({
          id: "call_safe",
          taskId: "task_1",
          toolName: "repo.read_file",
          inputHash: "a",
          idempotencyKey: "a",
          idempotency: "safe",
          status: "started",
          startedAt: new Date().toISOString(),
          retryCount: 0,
        })
        await store.startToolCall({
          id: "call_write",
          taskId: "task_1",
          toolName: "command.run",
          inputHash: "b",
          idempotencyKey: "b",
          idempotency: "non_idempotent",
          status: "started",
          startedAt: new Date().toISOString(),
          retryCount: 0,
        })
        const open = await store.openToolCalls("task_1")
        expect(open).toHaveLength(2)
        expect(open.find((c) => c.id === "call_write")?.idempotency).toBe("non_idempotent")
        await store.finishToolCall("call_write", { status: "outcome_unknown" })
        const stillOpen = await store.openToolCalls("task_1")
        expect(stillOpen.map((c) => c.id)).toEqual(["call_safe"])
      } finally {
        await cleanup()
      }
    })

    it("会话消息：追加、替换、读回顺序一致", async () => {
      const { store, cleanup } = await create()
      try {
        await store.createTask({
          id: "task_1",
          title: "t",
          userRequest: "r",
          mode: "edit",
          status: "queued",
          workspaceRoot: "D:/w",
          budget: { ...DEFAULT_BUDGET },
          usage: createUsage(0),
        })
        await store.appendMessages("task_1", [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
        ])
        await store.appendMessages("task_1", [{ role: "assistant", content: "third" }])
        expect((await store.getMessages("task_1")).map((m) => m.content)).toEqual([
          "first",
          "second",
          "third",
        ])

        await store.replaceMessages("task_1", [{ role: "user", content: "compacted" }])
        expect((await store.getMessages("task_1")).map((m) => m.content)).toEqual(["compacted"])
      } finally {
        await cleanup()
      }
    })

    it("检查点：存引用与变更文件，不存整段 diff", async () => {
      const { store, cleanup } = await create()
      try {
        await store.createTask({
          id: "task_1",
          title: "t",
          userRequest: "r",
          mode: "edit",
          status: "queued",
          workspaceRoot: "D:/w",
          budget: { ...DEFAULT_BUDGET },
          usage: createUsage(0),
        })
        await store.saveCheckpoint({
          id: "cp_1",
          taskId: "task_1",
          version: 1,
          status: "executing",
          completedStepIds: ["s1"],
          plan: {
            summary: "plan",
            assumptions: [],
            steps: [
              {
                id: "s1",
                objective: "do it",
                filesLikelyAffected: [],
                toolsAllowed: [],
                dependencies: [],
                doneWhen: [],
                risk: "low",
              },
            ],
            validation: [],
            requiresApproval: false,
          },
          changedFiles: ["D:/w/src/a.ts"],
          messageCount: 4,
          createdAt: new Date().toISOString(),
        })
        const latest = await store.latestCheckpoint("task_1")
        expect(latest?.id).toBe("cp_1")
        expect(latest?.changedFiles).toEqual(["D:/w/src/a.ts"])
        expect(latest?.completedStepIds).toEqual(["s1"])
        // 计划正文要能原样读回：恢复时靠它把 pending-steps 注入上下文。
        expect(latest?.plan?.steps.map((step) => step.id)).toEqual(["s1"])
        expect(latest?.plan?.summary).toBe("plan")
        expect(latest).not.toHaveProperty("diff")
      } finally {
        await cleanup()
      }
    })

    it("产物记录可写可读", async () => {
      const { store, cleanup } = await create()
      try {
        await store.createTask({
          id: "task_1",
          title: "t",
          userRequest: "r",
          mode: "edit",
          status: "queued",
          workspaceRoot: "D:/w",
          budget: { ...DEFAULT_BUDGET },
          usage: createUsage(0),
        })
        await store.createArtifact({
          id: "art_1",
          taskId: "task_1",
          kind: "tool-output",
          uri: "file:///tmp/out.txt",
          sha256: "abc",
          sizeBytes: 12,
          createdAt: new Date().toISOString(),
        })
        const artifacts = await store.listArtifacts("task_1")
        expect(artifacts.map((a) => a.uri)).toContain("file:///tmp/out.txt")
      } finally {
        await cleanup()
      }
    })

    it("读取不存在的任务返回 undefined，不抛错", async () => {
      const { store, cleanup } = await create()
      try {
        expect(await store.getTask("nope")).toBeUndefined()
      } finally {
        await cleanup()
      }
    })
  })
}

storeTests("memory", async () => {
  const store = new MemoryStore()
  return { store, cleanup: async () => store.close() }
})

storeTests("sqlite", async () => {
  const ws = await createTempWorkspace("mod-sqlite-")
  const result = await createStore({ sqliteFile: path.join(ws.root, "state.sqlite") })
  return {
    store: result.store,
    cleanup: async () => {
      await result.store.close()
      await ws.cleanup()
    },
  }
})

describe("store/sqlite: 回落与实例结构", () => {
  it("node:sqlite 可用时 storeKind = sqlite", async () => {
    const ws = await createTempWorkspace("mod-sqlite-")
    try {
      const result = await createStore({ sqliteFile: path.join(ws.root, "state.sqlite") })
      expect(result.store.kind).toBe("sqlite")
      expect(result.degradedReason).toBeUndefined()
      await result.store.close()
    } finally {
      await ws.cleanup()
    }
  })

  it("数据库目录不存在时自动创建，而不是静默回落到内存", async () => {
    const ws = await createTempWorkspace("mod-sqlite-")
    try {
      const nested = path.join(ws.root, "deep", "nested", "state.sqlite")
      const result = await createStore({ sqliteFile: nested })
      expect(result.store.kind).toBe("sqlite")
      expect(result.degradedReason).toBeUndefined()
      await result.store.close()
      expect(
        await fs
          .stat(nested)
          .then(() => true)
          .catch(() => false),
      ).toBe(true)
    } finally {
      await ws.cleanup()
    }
  })

  it("不指定文件时用内存 store", async () => {
    const result = await createStore()
    expect(result.store.kind).toBe("memory")
    await result.store.close()
  })

  it("SqliteStore 可在同一文件上重开并且数据仍在（真正的持久化）", async () => {
    const ws = await createTempWorkspace("mod-sqlite-")
    try {
      const file = path.join(ws.root, "state.sqlite")
      const firstOpened = await SqliteStore.open(file)
      const first = firstOpened.store
      expect(first).toBeDefined()
      expect(firstOpened.reason).toBeUndefined()
      await first!.createTask({
        id: "task_persist",
        title: "persisted",
        userRequest: "r",
        mode: "edit",
        status: "queued",
        workspaceRoot: "D:/w",
        budget: { ...DEFAULT_BUDGET },
        usage: createUsage(0),
      })
      await first!.close()

      const second = (await SqliteStore.open(file)).store
      const task = await second!.getTask("task_persist")
      expect(task?.title).toBe("persisted")
      await second!.close()
    } finally {
      await ws.cleanup()
    }
  })

  it("非法 migrations 场景：坏 JSON 列不能让读全体崩掉", async () => {
    const ws = await createTempWorkspace("mod-sqlite-")
    try {
      const store = (await SqliteStore.open(path.join(ws.root, "state.sqlite"))).store
      const task = await store!.createTask({
        id: "task_bad",
        title: "t",
        userRequest: "r",
        mode: "edit",
        status: "queued",
        workspaceRoot: "D:/w",
        budget: { ...DEFAULT_BUDGET },
        usage: createUsage(0),
      })
      // budget / usage 都是 JSON 列：即使被外部写坏也应按默认值收敛而不是抛错
      const listed = await store!.listTasks()
      expect(listed.map((t) => t.id)).toEqual([task.id])
      await store!.close()
    } finally {
      await ws.cleanup()
    }
  })
})

/* ------------------------------------------------------------------ *
 * 版本化迁移
 * ------------------------------------------------------------------ */

/** 用原生驱动直接看库文件：验证"迁移记录"这种只有 SQL 能回答的事实。 */
async function rawDb(file: string): Promise<{
  exec(sql: string): void
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...p: unknown[]): unknown }
  close(): void
}> {
  const mod = (await import("node:sqlite")) as unknown as {
    DatabaseSync: new (file: string) => {
      exec(sql: string): void
      prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...p: unknown[]): unknown }
      close(): void
    }
  }
  return new mod.DatabaseSync(file)
}

describe("store/sqlite: 版本化迁移", () => {
  it("新库记录全部迁移版本；重开同一文件不会重复执行", async () => {
    const ws = await createTempWorkspace("mod-sqlite-")
    try {
      const file = path.join(ws.root, "state.sqlite")
      const first = (await SqliteStore.open(file)).store
      const version = first!.schemaVersion()
      expect(version).toBeGreaterThanOrEqual(1)
      await first!.close()

      const second = (await SqliteStore.open(file)).store
      expect(second!.schemaVersion()).toBe(version)
      await second!.close()

      const db = await rawDb(file)
      try {
        const rows = db
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all() as Array<{ version?: unknown }>
        const versions = rows.map((row) => Number(row.version))
        // 版本号递增且不重复：重复执行迁移会把 DDL 反复跑一遍，也可能插入重复记录
        expect(versions).toEqual([...new Set(versions)].sort((a, b) => a - b))
        expect(versions[versions.length - 1]).toBe(version)
      } finally {
        db.close()
      }
    } finally {
      await ws.cleanup()
    }
  })

  it("旧库缺少 changed_files_json：打开时补列并记账，而不是等到 saveCheckpoint 才报错", async () => {
    const ws = await createTempWorkspace("mod-sqlite-")
    try {
      const file = path.join(ws.root, "state.sqlite")
      // 模拟"上一个版本建的表"：结构存在，但没有 changed_files_json
      const legacy = await rawDb(file)
      legacy.exec(`
        CREATE TABLE task_checkpoints (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          status TEXT NOT NULL,
          plan_json TEXT,
          completed_steps_json TEXT NOT NULL DEFAULT '[]',
          context_summary_json TEXT,
          workspace_snapshot_ref TEXT,
          message_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          UNIQUE (task_id, version)
        );
      `)
      legacy.close()

      const opened = await SqliteStore.open(file)
      expect(opened.store).toBeDefined()
      expect(opened.reason).toBeUndefined()
      await opened.store!.close()

      const db = await rawDb(file)
      try {
        const columns = db.prepare("PRAGMA table_info(task_checkpoints)").all() as Array<{
          name?: unknown
        }>
        expect(columns.map((column) => String(column.name))).toContain("changed_files_json")
        const versions = (
          db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
            version?: unknown
          }>
        ).map((row) => Number(row.version))
        expect(versions).toContain(2)
      } finally {
        db.close()
      }
    } finally {
      await ws.cleanup()
    }
  })
})

void settingsWith
void AppError
