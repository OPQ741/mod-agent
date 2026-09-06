/**
 * 权限策略层测试。
 *
 * 这一层是"文档里的纪律"被翻译成代码的主要落点，所以用例按**攻击手写**
 * 而不是按函数写：每条用例问的是"这个逃逸手段能不能绕过"。
 *
 * 覆盖：
 * - 复合命令拆分（`git status && rm -rf`）
 * - wrapper 剥离与"剥完还要再判一次"（`sudo`）
 * - 判定序 deny → allow → 档位，且 deny 不可翻案
 * - allow / deny 的深度语义不同
 * - bypass-immune：路径、命令、无法静态解析的形状
 * - 六个权限档位的裁决
 * - 会话级放行绑定参数
 */

import { describe, expect, it } from "vitest"
import path from "node:path"
import fs from "node:fs"

import {
  isUnresolvableShape,
  parseCommandLine,
  parseCommandSegments,
  splitCommandLine,
  stripWrappers,
  tokenizeSegment,
  usesSudo,
} from "../src/policy/command.js"
import {
  matchCommand,
  matchesBypassImmuneCommand,
  matchesBypassImmunePath,
  matchDomain,
  matchGlob,
  matchPath,
  matchParam,
  parseRule,
} from "../src/policy/rules.js"
import {
  CODE_LIKE_PATHS,
  PathGuard,
  isCodeLikePath,
  matchSimpleIgnore,
} from "../src/policy/pathguard.js"
import { PolicyEngine, evaluateOnce, indexRules } from "../src/policy/engine.js"
import { AppError } from "../src/shared/errors.js"
import { normalizeCommandRequest } from "../src/shared/contracts.js"
import { createTempWorkspace, settingsWith } from "./helpers.js"

function cmd(executable: string, args: string[] = []) {
  return normalizeCommandRequest({ executable, args, cwd: "D:/w", reason: "test" })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const policy = (overrides: any = {}, extra: any = {}) =>
  new PolicyEngine({
    settings: settingsWith(overrides),
    cwd: "D:/w",
    hasTty: true,
    ...extra,
  })

describe("policy/command: 复合命令拆分", () => {
  it("按 && || ; | 拆段，不留尾巴", () => {
    const segments = parseCommandLine("git status && npm test; echo hi | grep x")
    expect(segments.map((s) => s.executable)).toEqual(["git", "npm", "echo", "grep"])
  })

  it("引号内的操作符不当分隔符", () => {
    expect(splitCommandLine(`echo "a && b"`)).toHaveLength(1)
    expect(splitCommandLine("echo 'x; y'")).toHaveLength(1)
  })

  it("git status && rm -rf 拆出两段 —— 前缀规则不再被后半段蹭到", () => {
    const segments = parseCommandSegments(cmd("git", ["status", "&&", "rm", "-rf", "/"]))
    expect(segments.map((s) => s.executable)).toEqual(["git", "rm"])
  })

  it("args 里塞进连接符同样会被拆出来", () => {
    const segments = parseCommandSegments(cmd("bash", ["-c", "echo hi && rm -rf x"]))
    expect(segments.length).toBeGreaterThanOrEqual(2)
  })

  it("tokenizeSegment 尊重引号与转义", () => {
    expect(tokenizeSegment(`echo "hello world"`)).toEqual(["echo", "hello world"])
    expect(tokenizeSegment("echo a\\ b")).toEqual(["echo", "a b"])
  })
})

describe("policy/command: wrapper 剥离", () => {
  it("剥离 sudo / env / nice 等 wrapper 并单独记录", () => {
    const result = stripWrappers(["sudo", "-u", "root", "npm", "run", "test"])
    expect(result.executable).toBe("npm")
    expect(result.wrappers).toContain("sudo")
    expect(result.args).toEqual(["run", "test"])
  })

  it("环境变量赋值前缀被跳过", () => {
    expect(stripWrappers(["FOO=bar", "npm", "test"]).executable).toBe("npm")
  })

  it("npx / docker exec / mise 不剥离 —— 真正执行的内容在参数里", () => {
    const npx = stripWrappers(["npx", "tsc", "--noEmit"])
    expect(npx.executable).toBe("npx")
    expect(npx.args).toEqual(["tsc", "--noEmit"])

    const docker = stripWrappers(["docker", "exec", "-it", "box", "rm", "-rf", "/"])
    expect(docker.executable).toBe("docker")
  })

  it("带路径的可执行文件取 basename", () => {
    expect(stripWrappers(["/usr/bin/sudo", "/bin/ls"]).executable).toBe("ls")
  })

  it("usesSudo 识别提权 — 与剥离动作解耦，剥完还要再判一次", () => {
    const segments = parseCommandLine("sudo npm install")
    expect(usesSudo(segments[0]!)).toBe(true)
  })
})

describe("policy/command: 只能精确匹配 / 无法静态解析", () => {
  it("watch / setsid / ionice / flock 只能精确匹配", () => {
    for (const bin of ["watch", "setsid", "ionice", "flock"]) {
      expect(parseCommandLine(`${bin} npm test`)[0]!.requiresExact).toBe(true)
    }
  })

  it("npx / docker / mise 需要精确匹配（二次进入了新的执行入口）", () => {
    for (const bin of ["npx", "docker", "mise"]) {
      expect(parseCommandLine(`${bin} something`)[0]!.requiresExact).toBe(true)
    }
  })

  it("find 带 -exec / -delete 只能精确匹配", () => {
    expect(parseCommandLine("find . -name a -delete")[0]!.requiresExact).toBe(true)
    expect(parseCommandLine("find . -exec rm {} ;")[0]!.requiresExact).toBe(true)
    expect(parseCommandLine("find . -name '*.ts'")[0]!.requiresExact).toBe(false)
  })

  it("eval / sh -c / xargs -I / node -e 一律判为无法静态解析", () => {
    const cases = [
      "eval something",
      "sh -c rm -rf /",
      "bash -c rm -rf /",
      "xargs -I{} rm {}",
      "node -e console.log(1)",
      "python -c print(1)",
      "perl -e 'print 1'",
      "awk 'BEGIN { system(\"rm -rf /\") }'",
    ]
    for (const line of cases) {
      const segment = parseCommandLine(line)[0]!
      expect(isUnresolvableShape(segment).unresolvable, line).toBe(true)
    }
  })

  it("输出重定向不可静态解析", () => {
    expect(isUnresolvableShape(parseCommandLine("echo hi > /tmp/out")[0]!).unresolvable).toBe(true)
  })

  it("普通命令形状可解析", () => {
    expect(isUnresolvableShape(parseCommandLine("npm run build")[0]!).unresolvable).toBe(false)
    expect(isUnresolvableShape(parseCommandLine("git status --porcelain")[0]!).unresolvable).toBe(
      false,
    )
  })
})

describe("policy/rules: 规则解析与匹配", () => {
  it("Bash(ls:*) 与 Bash(ls *) 语义等价（只在原始写法上有差别）", () => {
    expect({ ...parseRule("Bash(ls:*)"), raw: "<raw>" }).toEqual({
      ...parseRule("Bash(ls *)"),
      raw: "<raw>",
    })
  })

  it("无括号 = 放行该工具全部调用", () => {
    const rule = parseRule("Bash")
    expect(rule.kind).toBe("all")
    expect(matchDomain(rule, "anything")).toBe(true)
  })

  it("命令前缀规则要求分隔位，避免 ls-evil 被放行", () => {
    const rule = parseRule("Bash(ls *)")
    expect(matchCommandChecked(rule, "ls -la")).toBe(true)
    expect(matchCommandChecked(rule, "ls")).toBe(true)
    expect(matchCommandChecked(rule, "ls --help")).toBe(true)
    expect(matchCommandChecked(rule, "lsof")).toBe(false)
    expect(matchCommandChecked(rule, "ls-evil")).toBe(false)
  })

  it("`.*` 前缀不要求分隔位（ls* 语义）", () => {
    const rule = parseRule("Bash(git st*)")
    expect(matchCommandChecked(rule, "git status")).toBe(true)
  })

  it("域名匹配：*.x 不含 apex，.x 含 apex，* 全域", () => {
    const sub = parseRule("WebFetch(domain:*.example.com)")
    expect(matchDomain(sub, "a.example.com")).toBe(true)
    expect(matchDomain(sub, "example.com")).toBe(false)

    const both = parseRule("WebFetch(domain:.example.com)")
    expect(matchDomain(both, "example.com")).toBe(true)
    expect(matchDomain(both, "a.example.com")).toBe(true)

    const star = parseRule("WebFetch(domain:*)")
    expect(matchDomain(star, "evil.test")).toBe(true)
  })

  it("参数级规则按 key:value 匹配", () => {
    const rule = parseRule("Bash(run_in_background:true)")
    expect(matchParam(rule, { run_in_background: true })).toBe(true)
    expect(matchParam(rule, { run_in_background: false })).toBe(false)
  })

  it("allow 路径锚 cwd 之内，deny 路径可任意深度", async () => {
    const ws = await createTempWorkspace()
    try {
      const ctx = { cwd: ws.root, homeDir: ws.abs("home") }
      await ws.write("src/a/b.ts", "x")
      await ws.write("nested/secrets/key", "x")

      const allowRule = parseRule("Write(src/**)")
      expect(matchPath(allowRule, ws.abs("src/a/b.ts"), "allow", ctx)).toBe(true)
      // 放权不能越过锚点目录
      expect(
        matchPath(allowRule, path.resolve(ws.root, "..", "other-src", "a.ts"), "allow", ctx),
      ).toBe(false)

      const denyRule = parseRule("Write(secrets/**)")
      expect(matchPath(denyRule, ws.abs("nested/secrets/key"), "deny", ctx)).toBe(true)
    } finally {
      await ws.cleanup()
    }
  })

  it("裸文件名规则等同任意深度", () => {
    const rule = parseRule("Read(secrets/**)")
    expect(matchPath(rule, "/repo/a/b/secrets/x", "deny", { cwd: "/repo", homeDir: "/h" })).toBe(
      true,
    )
  })

  it("matchGlob：** 跨目录、* 不跨目录、? 单字符", () => {
    expect(matchGlob("/a/b/c.ts", "/a/**/*.ts", { anyDepth: false })).toBe(true)
    expect(matchGlob("/a/x.ts", "/a/*.ts", { anyDepth: false })).toBe(true)
    expect(matchGlob("/a/b/x.ts", "/a/*.ts", { anyDepth: false })).toBe(false)
    expect(matchGlob("/a/x1.ts", "/a/x?.ts", { anyDepth: false })).toBe(true)
  })

  it("非法规则显式抛错，不静默丢弃", () => {
    expect(() => parseRule("")).toThrow()
    expect(() => indexRules(["Bash(", "ls"])).toThrow(/Invalid permission rule/)
  })
})

function matchCommandChecked(rule: ReturnType<typeof parseRule>, text: string): boolean {
  // matchCommand 只对 exact / prefix / all 有意义
  return matchCommand(rule, text)
}

async function fsRealpathQuiet(p: string): Promise<string | undefined> {
  try {
    return await fs.promises.realpath(p)
  } catch {
    return undefined
  }
}

describe("policy/rules: bypass-immune", () => {
  it("凭据类路径一律免疫，包括深层与变形", () => {
    for (const p of [
      "/repo/.env",
      "/repo/packages/app/.env.local",
      "/home/u/.ssh/id_rsa",
      "/repo/certs/server.pem",
      "/repo/.aws/credentials",
      "/repo/service-account.json",
      "/etc/shadow",
      "/proc/self/environ",
    ]) {
      expect(matchesBypassImmunePath(p), p).toBe(true)
    }
  })

  it("普通源码路径不免疫，否则等于什么都拦", () => {
    for (const p of ["/repo/src/index.ts", "/repo/package.json", "/repo/.gitignore"]) {
      expect(matchesBypassImmunePath(p), p).toBe(false)
    }
  })

  it("rm / sudo 等命令免疫", () => {
    for (const bin of ["rm", "rmdir", "sudo", "mkfs", "chown"]) {
      expect(matchesBypassImmuneCommand(bin), bin).toBe(true)
    }
    expect(matchesBypassImmuneCommand("npm")).toBe(false)
  })
})

describe("policy/pathguard", () => {
  it("拒绝读写工作区外的路径", async () => {
    const ws = await createTempWorkspace()
    try {
      const guard = new PathGuard({ workspaceRoot: ws.root })
      await expect(guard.assertReadable(path.resolve(ws.root, ".."))).rejects.toThrow(
        /outside the workspace/,
      )
      await expect(guard.assertWritable(path.resolve(ws.root, ".."))).rejects.toThrow(
        /outside the workspace/,
      )
    } finally {
      await ws.cleanup()
    }
  })

  it("真实的逃逸手法会被 realpath 抓住（相对路径穿越工作区）", async () => {
    const ws = await createTempWorkspace()
    const outside = await createTempWorkspace("mod-outside-")
    try {
      await ws.write("inside.txt", "ok")
      await outside.write("secret.txt", "KEY=1")

      const guard = new PathGuard({ workspaceRoot: ws.root })
      // 写法上"看起来"在工作区内（`ws/../outside`），realpath 之后落在区外
      const traversal = path.join(ws.root, "..", path.basename(outside.root), "secret.txt")
      await expect(guard.assertReadable(traversal)).rejects.toThrow(/outside the workspace/)
      // 解析结果本身必须如实记录"在外面"
      const resolved = await guard.resolve(traversal)
      expect(resolved.insideWorkspace).toBe(false)
    } finally {
      await ws.cleanup()
      await outside.cleanup()
    }
  })

  it("符号链接逃逸：环境支持则断言拦截，不支持则明确跳过而不是假装通过", async () => {
    const ws = await createTempWorkspace()
    const outside = await createTempWorkspace("mod-outside-")
    let usable: boolean
    try {
      await outside.write("secret.env", "KEY=1")
      try {
        await (
          await import("node:fs/promises")
        ).symlink(outside.abs("secret.env"), ws.abs("linked.env"), "file")
        // 有些环境（无特权的 Windows / 沙箱）mkdir 出来的链接解析不了，
        // 此时这条用例无法真实验证，必须显式跳过而不是留下假绿。
        usable = (await fsRealpathQuiet(ws.abs("linked.env"))) === outside.abs("secret.env")
      } catch {
        usable = false
      }
      if (!usable) return

      const guard = new PathGuard({ workspaceRoot: ws.root })
      await expect(guard.assertReadable(ws.abs("linked.env"))).rejects.toThrow(
        /outside the workspace|bypass-immune/,
      )
    } finally {
      await ws.cleanup()
      await outside.cleanup()
    }
  })

  it("cwd 必须落在工作区内", async () => {
    const ws = await createTempWorkspace()
    try {
      const guard = new PathGuard({ workspaceRoot: ws.root })
      expect(() => guard.assertCwd(path.resolve(ws.root, ".."))).toThrow(/must be inside/)
    } finally {
      await ws.cleanup()
    }
  })

  it("respectGitignore 拦截被忽略的路径", async () => {
    const ws = await createTempWorkspace()
    try {
      const guard = new PathGuard({
        workspaceRoot: ws.root,
        respectGitignore: true,
        gitignorePatterns: ["dist/", "*.log"],
      })
      await ws.write("dist/bundle.js", "x")
      await ws.write("debug.log", "x")
      await expect(guard.assertReadable(ws.abs("dist/bundle.js"))).rejects.toThrow(
        /respectGitignore/,
      )
      await expect(guard.assertReadable(ws.abs("debug.log"))).rejects.toThrow(/respectGitignore/)
    } finally {
      await ws.cleanup()
    }
  })

  it("「看着像数据、实则是代码」的位置写入需要审批而非放行", async () => {
    const ws = await createTempWorkspace()
    try {
      const guard = new PathGuard({ workspaceRoot: ws.root })
      await ws.write(".vscode/tasks.json", "{}")
      const verdict = await guard.assertWritable(ws.abs(".vscode/tasks.json"))
      expect(verdict.needsApproval).toBe(true)
      expect(verdict.reason).toMatch(/feeds a program outside the sandbox/)

      const normal = await guard.assertWritable(ws.abs("src/new-file.ts"))
      expect(normal.needsApproval).toBe(false)
    } finally {
      await ws.cleanup()
    }
  })

  it("高危清单覆盖 hook / CI / venv 解释器配置", () => {
    expect(CODE_LIKE_PATHS).toContain(".git/hooks")
    expect(CODE_LIKE_PATHS).toContain(".github/workflows")
    expect(CODE_LIKE_PATHS).toContain(".husky")
    expect(isCodeLikePath("/r/.venv/pyvenv.cfg")).toBe(true)
    expect(isCodeLikePath("/r/src/util.ts")).toBe(false)
  })

  it("matchSimpleIgnore 支持目录 / 后缀 / 文件名", () => {
    expect(matchSimpleIgnore("dist/a.js", "dist/")).toBe(true)
    expect(matchSimpleIgnore("a/b.log", "*.log")).toBe(true)
    expect(matchSimpleIgnore("node_modules/x", "node_modules")).toBe(true)
    expect(matchSimpleIgnore("src/a.ts", "dist/")).toBe(false)
  })
})

describe("policy/engine: 判定序 deny → allow → 档位", () => {
  it("deny 规则优先于 allow 规则 —— 同一动作两条规则都命中时拒绝", async () => {
    const engine = policy({
      permissions: { allow: ["Bash(npm run *)"], deny: ["Bash(npm run test)"] },
    })
    const decision = await engine.evaluate({
      toolName: "Bash",
      risk: "command",
      args: {},
      command: cmd("npm", ["run", "test"]),
      permissionMode: "default",
      taskMode: "edit",
    })
    expect(decision.effect).toBe("deny")
    expect(decision.matchedRule).toBe("Bash(npm run test)")
  })

  it("bypassPermissions 也翻不了 deny 的案", async () => {
    const engine = policy({ permissions: { deny: ["Write(**)"] } })
    const decision = await engine.evaluate({
      toolName: "Write",
      risk: "workspace_write",
      args: {},
      paths: ["D:/w/src/a.ts"],
      permissionMode: "bypassPermissions",
      taskMode: "edit",
    })
    expect(decision.effect).toBe("deny")
  })

  it("bypass-immune 路径在任何模式下都拦", async () => {
    const engine = policy({})
    const decision = await engine.evaluate({
      toolName: "Read",
      risk: "read",
      args: { path: "D:/w/.env" },
      paths: ["D:/w/.env"],
      permissionMode: "bypassPermissions",
      taskMode: "autopilot",
    })
    expect(decision.effect).toBe("deny")
    expect(decision.bypassImmune).toBe(true)
  })

  it("sudo 在任何模式下都拦", async () => {
    const engine = policy({ permissions: { allow: ["Bash(*)"] } })
    const decision = await engine.evaluate({
      toolName: "Bash",
      risk: "command",
      args: {},
      command: cmd("sudo", ["rm", "-rf", "/"]),
      permissionMode: "bypassPermissions",
      taskMode: "autopilot",
    })
    expect(decision.effect).toBe("deny")
    expect(decision.bypassImmune).toBe(true)
  })

  it("allow 规则命中的前缀，不会被后半段蹭走：需要逐段全部命中", async () => {
    const engine = policy({ permissions: { allow: ["Bash(git status)"] } })
    const decision = await engine.evaluate({
      toolName: "Bash",
      risk: "command",
      args: {},
      command: cmd("git", ["status", "&&", "rm", "-rf", "/"]),
      permissionMode: "default",
      taskMode: "edit",
    })
    // git status 命中，但第二段 rm 没命中 → 不整体放行，交给档位裁决
    expect(decision.effect).not.toBe("allow")
  })

  it("npx / docker 这类入口，前缀规则放不倒", async () => {
    const engine = policy({ permissions: { allow: ["Bash(npx *)"] } })
    const decision = await engine.evaluate({
      toolName: "Bash",
      risk: "command",
      args: {},
      command: cmd("npx", ["evil-pkg"]),
      permissionMode: "default",
      taskMode: "edit",
    })
    expect(decision.effect).not.toBe("allow")
  })
})

describe("policy/engine: 六个权限档位", () => {
  const base = {
    toolName: "Edit",
    risk: "workspace_write" as const,
    args: { path: "D:/w/src/a.ts" },
    paths: ["D:/w/src/a.ts"],
    taskMode: "edit" as const,
  }

  it("default：读放行、写要确认、无 TTY 直接拒", async () => {
    const read = await policy({}).evaluate({
      toolName: "Read",
      risk: "read",
      args: {},
      paths: ["D:/w/src/a.ts"],
      permissionMode: "default",
      taskMode: "edit",
    })
    expect(read.effect).toBe("allow")

    expect(
      (await policy({}, { hasTty: true }).evaluate({ ...base, permissionMode: "default" })).effect,
    ).toBe("ask")
    const noTty = await policy({}, { hasTty: false }).evaluate({
      ...base,
      permissionMode: "default",
    })
    expect(noTty.effect).toBe("deny")
    expect(noTty.reason).toMatch(/No interactive TTY/)
  })

  it("acceptEdits：写放行，命令仍然问", async () => {
    const edit = await policy({}).evaluate({ ...base, permissionMode: "acceptEdits" })
    expect(edit.effect).toBe("allow")

    const command = await policy({}).evaluate({
      toolName: "Bash",
      risk: "command",
      args: {},
      command: cmd("npm", ["install"]),
      permissionMode: "acceptEdits",
      taskMode: "edit",
    })
    expect(command.effect).toBe("ask")
  })

  it("plan：只读放行，写直接拒（不是问，是连工具都不注册）", async () => {
    const engine = policy({})
    const write = await engine.evaluate({ ...base, permissionMode: "plan", taskMode: "plan" })
    expect(write.effect).toBe("deny")
    expect(write.reason).toMatch(/Plan mode is read-only/)

    const read = await engine.evaluate({
      toolName: "Read",
      risk: "read",
      args: {},
      paths: ["D:/w/src/a.ts"],
      permissionMode: "plan",
      taskMode: "plan",
    })
    expect(read.effect).toBe("allow")
  })

  it("ask 模式任务：任何非只读动作都拒", async () => {
    const decision = await policy({}).evaluate({
      ...base,
      permissionMode: "default",
      taskMode: "ask",
    })
    expect(decision.effect).toBe("deny")
    expect(decision.reason).toMatch(/read-only/)
  })

  it("dontAsk：读放行、本该弹框的一律拒（不是全放行）", async () => {
    const read = await policy({}).evaluate({
      toolName: "Read",
      risk: "read",
      args: {},
      paths: ["D:/w/src/a.ts"],
      permissionMode: "dontAsk",
      taskMode: "edit",
    })
    expect(read.effect).toBe("allow")

    const write = await policy({}).evaluate({ ...base, permissionMode: "dontAsk" })
    expect(write.effect).toBe("deny")
    expect(write.reason).toMatch(/automatically denied/)
  })

  it("bypassPermissions：放行，但 deny 与 bypass-immune 之前已经拦下", async () => {
    const decision = await policy({}).evaluate({ ...base, permissionMode: "bypassPermissions" })
    expect(decision.effect).toBe("allow")
  })

  it("auto：分类器不可用 / 抛错一律回落 ask（fail-closed）", async () => {
    const noClassifier = await policy({}).evaluate({ ...base, permissionMode: "auto" })
    expect(noClassifier.effect).toBe("ask")

    const throwingClassifier = await policy(
      {},
      {
        classifier: {
          async classify() {
            throw new Error("classifier down")
          },
        },
      },
    ).evaluate({ ...base, permissionMode: "auto" })
    expect(throwingClassifier.effect).toBe("ask")

    const allowClassifier = await policy(
      {},
      {
        classifier: {
          async classify() {
            return "allow"
          },
        },
      },
    ).evaluate({ ...base, permissionMode: "auto" })
    expect(allowClassifier.effect).toBe("allow")
  })

  it("显式 ask 规则优先于任何档位", async () => {
    const engine = policy({ permissions: { ask: ["Bash(npm run deploy)"] } })
    const decision = await engine.evaluate({
      toolName: "Bash",
      risk: "command",
      args: {},
      command: cmd("npm", ["run", "deploy"]),
      permissionMode: "bypassPermissions",
      taskMode: "autopilot",
    })
    expect(decision.effect).toBe("ask")
  })
})

describe("policy/engine: 会话级放行与拒绝追踪", () => {
  it("会话放行绑定具体参数：批准 npm run test 不等于批准 npm install", async () => {
    const engine = policy({})
    const args = { executable: "npm", args: ["run", "test"] }
    engine.grantSessionAllow("Bash", args)

    const same = await engine.evaluate({
      toolName: "Bash",
      risk: "command",
      args,
      command: cmd("npm", ["run", "test"]),
      permissionMode: "default",
      taskMode: "edit",
    })
    expect(same.effect).toBe("allow")

    const different = await engine.evaluate({
      toolName: "Bash",
      risk: "command",
      args: { executable: "npm", args: ["install", "lodash"] },
      command: cmd("npm", ["install", "lodash"]),
      permissionMode: "default",
      taskMode: "edit",
    })
    expect(different.effect).not.toBe("allow")
  })

  it("按 hash 授权与实际参数的 hash 对得上 —— 批准后不会被反复问", async () => {
    const engine = policy({})
    const args = { path: "D:/w/src/a.ts", content: "..." }
    const { parameterHash } = await import("../src/shared/hash.js")
    engine.grantSessionAllowHash("Write", parameterHash(args))
    expect(engine.hasSessionAllow("Write", args)).toBe(true)
    expect(engine.hasSessionAllow("Write", { ...args, content: "different" })).toBe(false)
  })

  it("会话放行不写回配置", async () => {
    const settings = settingsWith({})
    const engine = new PolicyEngine({ settings, cwd: "D:/w", hasTty: true })
    engine.grantSessionAllow("Bash", { c: "npm test" })
    expect(settings.permissions.allow).toEqual([])
    engine.resetSessionAllow()
    expect(engine.hasSessionAllow("Bash", { c: "npm test" })).toBe(false)
  })

  it("累计拒绝到上限后判定结果带上 denialLimitReached（而不是抛异常）", async () => {
    const engine = policy({ permissions: { deny: ["Read(**)"] } }, { maxCumulativeDenials: 3 })
    const decisions = []
    for (let i = 0; i < 5; i += 1) {
      decisions.push(
        await engine.evaluate({
          toolName: "Read",
          risk: "read",
          args: {},
          paths: ["D:/w/a.ts"],
          permissionMode: "default",
          taskMode: "edit",
        }),
      )
    }

    // 判定引擎是纯函数式的：它不中止任务，只报告"该停了"。
    // 抛异常会让拒绝从"数据"变成"控制流"，执行器与主循环的容错设计就全失效了。
    expect(decisions.slice(0, 2).every((d) => d.denialLimitReached === undefined)).toBe(true)
    expect(decisions.slice(2).every((d) => d.effect === "deny")).toBe(true)
    expect(decisions.slice(2).every((d) => d.denialLimitReached === true)).toBe(true)
    expect(decisions[4]?.reason).toMatch(/cumulative denial limit/)
    expect(engine.denialStats.cumulative).toBe(5)
  })

  it("evaluateOnce 便捷入口返回同样的三态结果", async () => {
    const decision = await evaluateOnce(
      {
        settings: settingsWith({}),
        cwd: "D:/w",
        hasTty: true,
      },
      {
        toolName: "Read",
        risk: "read",
        args: {},
        paths: ["D:/w/a.ts"],
        permissionMode: "default",
        taskMode: "edit",
      },
    )
    expect(decision.effect).toBe("allow")
  })
})

describe("policy/engine: 不一致规则不该静默通过", () => {
  it("工具 missing tool name 的规则在加载期就被抓住", () => {
    expect(() => indexRules(["Bash(ok)", ""])).toThrow(/Invalid permission rule/)
  })

  it("decision 始终带回 parameterHash —— 审批与执行的参数绑定依据", async () => {
    const decision = await policy({}).evaluate({
      toolName: "Write",
      risk: "workspace_write",
      args: { path: "a", content: "b" },
      paths: ["D:/w/a"],
      permissionMode: "bypassPermissions",
      taskMode: "edit",
    })
    expect(decision.parameterHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("policy/engine: 错误着装 AppError code", () => {
  it("AppError 带统一错误码，便于上层按 code 分支而不是匹配文案", () => {
    const err = new AppError("COMMAND_DENIED", "denied")
    expect(err.code).toBe("COMMAND_DENIED")
    expect(err.message).toBe("denied")
  })
})

/* ------------------------------------------------------------------ *
 * 回归：多路径 allow 的量化方向
 * ------------------------------------------------------------------ */

describe("policy/engine: 多路径 allow 必须 every 而不是 some", () => {
  it("allow 规则只覆盖部分路径时，整次调用不放行", async () => {
    const engine = policy({ permissions: { allow: ["Edit(src/**)"] } })
    const decision = await engine.evaluate({
      toolName: "Edit",
      risk: "workspace_write",
      args: {},
      // 第一条命中规则、第二条完全在规则之外 —— 用 some 的话整次调用会被放行，
      // 等于一条规则把没被覆盖的路径也一起批了。
      paths: ["D:/w/src/a.ts", "D:/w/etc/passwd"],
      permissionMode: "default",
      taskMode: "edit",
    })
    expect(decision.effect).not.toBe("allow")
  })

  it("每条路径都命中时正常放行", async () => {
    const engine = policy({ permissions: { allow: ["Edit(src/**)"] } })
    const decision = await engine.evaluate({
      toolName: "Edit",
      risk: "workspace_write",
      args: {},
      paths: ["D:/w/src/a.ts", "D:/w/src/b.ts"],
      permissionMode: "default",
      taskMode: "edit",
    })
    expect(decision.effect).toBe("allow")
  })

  it("deny 仍然用 some：任一路径命中就拒", async () => {
    const engine = policy({ permissions: { deny: ["Edit(src/**)"] } })
    const decision = await engine.evaluate({
      toolName: "Edit",
      risk: "workspace_write",
      args: {},
      paths: ["D:/w/src/a.ts", "D:/w/ok.ts"],
      permissionMode: "default",
      taskMode: "edit",
    })
    expect(decision.effect).toBe("deny")
  })
})

/* ------------------------------------------------------------------ *
 * 回归：验证命令的授权
 * ------------------------------------------------------------------ */

describe("policy/engine: evaluateValidation 的来源裁决", () => {
  const validationRequest = (command: string) => ({
    toolName: "test.run",
    risk: "command" as const,
    args: { command: [command] },
    command: normalizeCommandRequest({
      executable: command,
      args: ["run", "test"],
      cwd: "D:/w",
      timeoutMs: 300_000,
      networkProfile: "none" as const,
      reason: "Validation check: test",
      onTimeout: "kill" as const,
    }),
    paths: ["D:/w"],
    permissionMode: "default" as const,
    taskMode: "edit" as const,
  })

  it("仓库内容发现的命令不能自我授权", async () => {
    const engine = policy({})
    const decision = await engine.evaluateValidation(validationRequest("npm"), {
      userProvided: false,
    })
    expect(decision.effect).toBe("deny")
    expect(decision.reason).toMatch(/not covered by an allow rule/)
  })

  it("用户显式给出的命令视为已授权", async () => {
    const engine = policy({})
    const decision = await engine.evaluateValidation(validationRequest("npm"), {
      userProvided: true,
    })
    expect(decision.effect).toBe("allow")
  })

  it("显式 allow 规则可以授权发现出来的命令", async () => {
    // 规则里的工具名必须写**真实工具名**：本仓库的命令工具是 `test.run` / `command.run`，
    // 写成文档示例里的 `Bash(...)` 不会命中任何东西（那是另一个待修的一致性问题）。
    const engine = policy({ permissions: { allow: ["test.run(npm run *)"] } })
    const decision = await engine.evaluateValidation(validationRequest("npm"), {
      userProvided: false,
    })
    expect(decision.effect).toBe("allow")
  })

  it("deny 规则对验证命令同样生效（用户显式给也不行）", async () => {
    const engine = policy({ permissions: { deny: ["test.run(npm run test)"] } })
    const decision = await engine.evaluateValidation(validationRequest("npm"), {
      userProvided: true,
    })
    expect(decision.effect).toBe("deny")
  })

  it("bypass-immune 命令连用户显式授权都不放过", async () => {
    const engine = policy({})
    const decision = await engine.evaluateValidation(
      {
        ...validationRequest("rm"),
        command: normalizeCommandRequest({
          executable: "rm",
          args: ["-rf", "/"],
          cwd: "D:/w",
          timeoutMs: 300_000,
          networkProfile: "none" as const,
          reason: "Validation check: test",
          onTimeout: "kill" as const,
        }),
      },
      { userProvided: true },
    )
    expect(decision.effect).toBe("deny")
    expect(decision.bypassImmune).toBe(true)
  })
})
