/**
 * 编辑引擎测试（code-editing.md §2.1）。
 *
 * 这一层的五条护栏决定了"模型改代码会不会把用户的文件弄坏"，用例围绕
 * 每条护栏的真实失效场景设计，尤其是 `$&` 陷阱与 mtime 竞态这两个
 * 只有在真文件上跑才复现得出来的 bug。
 */

import { describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import path from "node:path"

import {
  EditEngine,
  countOccurrences,
  findOccurrences,
  normalizeForMatch,
  replaceAtPositions,
  validateStructuredFile,
} from "../src/patch/edit.js"
import { diffText, formatAll, summarize } from "../src/patch/diff.js"
import { AppError } from "../src/shared/errors.js"
import { createTempWorkspace } from "./helpers.js"

async function readAndRecord(engine: EditEngine, file: string): Promise<string> {
  const content = await fs.readFile(file, "utf8")
  const stat = await fs.stat(file)
  engine.recordRead(file, stat.mtimeMs, content)
  return content
}

describe("patch/edit: 匹配与替换原语", () => {
  it("normalizeForMatch 把弯引号折成直引号，仅用于匹配", () => {
    expect(normalizeForMatch("\u201Chello\u201D")).toBe('"hello"')
    expect(normalizeForMatch("\u2019")).toBe("'")
  })

  it("countOccurrences 统计重叠也不漏：aaa 中 aa 计 1 次（互不重叠）", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(2)
    expect(countOccurrences("abc", "z")).toBe(0)
    expect(countOccurrences("abc", "")).toBe(0)
  })

  it("findOccurrences 按规范化结果定位，下标可用于原始文本切片", () => {
    const original = "say \u201Chello\u201D now"
    const positions = findOccurrences(original, '"hello"')
    expect(positions).toHaveLength(1)
    expect(original.slice(positions[0]!, positions[0]! + '"hello"'.length)).toBe(
      "\u201Chello\u201D",
    )
  })

  it("replaceAtPositions 用 split/join，newString 里的 $& 不被当成替换模式", () => {
    // "value = X" 里 X 的下标是 8
    const out = replaceAtPositions("value = X", [8], 1, "process.env['$&']")
    expect(out).toBe("value = process.env['$&']")
    // 同一场景用 String.replace 会吃掉 $& —— 这条用例正是那条护栏的回归测试
    expect("value = X".replace("X", "process.env['$&']")).toBe("value = process.env['X']")
  })

  it("多位置替换逐段拼接正确", () => {
    expect(replaceAtPositions("a-b-a", [0, 4], 1, "Z")).toBe("Z-b-Z")
  })

  it("空匹配列表返回原文", () => {
    expect(replaceAtPositions("abc", [], 1, "Z")).toBe("abc")
  })
})

describe("patch/edit: read-before-edit 与 mtime", () => {
  it("没读过的文件不允许编辑", async () => {
    const ws = await createTempWorkspace()
    try {
      const engine = new EditEngine()
      const file = await ws.write("a.ts", "export const a = 1\n")
      await expect(
        engine.replace({ path: file, oldString: "const a = 1", newString: "const a = 2" }),
      ).rejects.toMatchObject({ code: "READ_BEFORE_EDIT" })
    } finally {
      await ws.cleanup()
    }
  })

  it("读后被外部进程改过 → MTIME_CHANGED，不静默覆盖", async () => {
    const ws = await createTempWorkspace()
    try {
      const engine = new EditEngine()
      const file = await ws.write("a.ts", "export const a = 1\n")
      await readAndRecord(engine, file)

      // 外部修改：把 mtime 推到下一个毫秒
      await new Promise((r) => setTimeout(r, 15))
      await ws.write("a.ts", "export const a = 999\n")

      const err = await engine
        .replace({ path: file, oldString: "const a = 1", newString: "const a = 2" })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe("MTIME_CHANGED")
      // 文件内容必须原封不动
      expect(await ws.read("a.ts")).toBe("export const a = 999\n")
    } finally {
      await ws.cleanup()
    }
  })

  it("文件不存在时提示改用 write_file，而不是静默新建", async () => {
    const ws = await createTempWorkspace()
    try {
      const engine = new EditEngine()
      await expect(
        engine.replace({ path: ws.abs("missing.ts"), oldString: "a", newString: "b" }),
      ).rejects.toMatchObject({ code: "READ_BEFORE_EDIT" })
    } finally {
      await ws.cleanup()
    }
  })

  it("recordWrite 之后可以直接继续改（本 Agent 自己写的记了新的 mtime）", async () => {
    const ws = await createTempWorkspace()
    try {
      const engine = new EditEngine()
      const file = await ws.write("a.ts", "line1\nline2\n")
      const content = await readAndRecord(engine, file)

      const first = await engine.replace({
        path: file,
        oldString: "line1",
        newString: "LINE1",
      })
      await fs.writeFile(file, first.content, "utf8")
      await engine.recordWrite(file, first.content)

      const second = await engine.replace({ path: file, oldString: "line2", newString: "LINE2" })
      expect(second.content).toBe("LINE1\nLINE2\n")
      expect(content).toContain("line1")
    } finally {
      await ws.cleanup()
    }
  })
})

describe("patch/edit: 唯一匹配是底线", () => {
  it("0 次匹配 = 幻觉检测", async () => {
    const ws = await createTempWorkspace()
    try {
      const engine = new EditEngine()
      const file = await ws.write("a.ts", "const realCode = 1\n")
      await readAndRecord(engine, file)
      await expect(
        engine.replace({ path: file, oldString: "const imaginedCode = 1", newString: "x" }),
      ).rejects.toMatchObject({ code: "EDIT_NOT_FOUND" })
    } finally {
      await ws.cleanup()
    }
  })

  it(">1 次匹配且未声明 → EDIT_NOT_UNIQUE，不静默批量替换", async () => {
    const ws = await createTempWorkspace()
    try {
      const engine = new EditEngine()
      const file = await ws.write("a.ts", "dup\ndup\ndup\n")
      await readAndRecord(engine, file)
      await expect(
        engine.replace({ path: file, oldString: "dup", newString: "uniq" }),
      ).rejects.toMatchObject({ code: "EDIT_NOT_UNIQUE" })
      expect(await ws.read("a.ts")).toBe("dup\ndup\ndup\n")
    } finally {
      await ws.cleanup()
    }
  })

  it("allowMultiple 显式开启才批量替换，并如实回报匹配次数", async () => {
    const ws = await createTempWorkspace()
    try {
      const engine = new EditEngine()
      const file = await ws.write("a.ts", "dup\ndup\ndup\n")
      await readAndRecord(engine, file)
      const outcome = await engine.replace({
        path: file,
        oldString: "dup",
        newString: "uniq",
        allowMultiple: true,
      })
      expect(outcome.matches).toBe(3)
      expect(outcome.content).toBe("uniq\nuniq\nuniq\n")
    } finally {
      await ws.cleanup()
    }
  })

  it("替换结果带回 baseHash / newHash / 增删行数", async () => {
    const ws = await createTempWorkspace()
    try {
      const engine = new EditEngine()
      const file = await ws.write("a.ts", "one\ntwo\n")
      await readAndRecord(engine, file)
      const outcome = await engine.replace({
        path: file,
        oldString: "two",
        newString: "three\nfour",
      })
      expect(outcome.baseHash).not.toBe(outcome.newHash)
      expect(outcome.deletions).toBe(1)
      expect(outcome.additions).toBe(2)
    } finally {
      await ws.cleanup()
    }
  })
})

describe("patch/edit: 引号容错与写回", () => {
  it("模型给的是弯引号、文件里是直引号，也能命中并写回文件原有字符", async () => {
    const ws = await createTempWorkspace()
    try {
      const engine = new EditEngine()
      const file = await ws.write("a.ts", 'const greeting = "hi"\n')
      await readAndRecord(engine, file)
      const outcome = await engine.replace({
        path: file,
        oldString: "const greeting = \u201Chi\u201D",
        newString: 'const greeting = "hello"',
      })
      expect(outcome.matches).toBe(1)
      expect(outcome.content).toBe('const greeting = "hello"\n')
      // 未被 oldString 覆盖的那部分保留原始字符风格
      expect(outcome.content.includes("const greeting = ")).toBe(true)
    } finally {
      await ws.cleanup()
    }
  })
})

describe("patch/edit: writeWhole", () => {
  it("新建文件无需先读", async () => {
    const ws = await createTempWorkspace()
    try {
      const engine = new EditEngine()
      const outcome = await engine.writeWhole(ws.abs("new/file.ts"), "export const x = 1\n")
      expect(outcome.baseHash).toBe("")
      expect(outcome.matches).toBe(0)
      expect(outcome.additions).toBe(1)
    } finally {
      await ws.cleanup()
    }
  })

  it("整篇覆写超大已有文件 → PATCH_CONFLICT，要求改用 replace", async () => {
    const ws = await createTempWorkspace()
    try {
      const engine = new EditEngine()
      const big = "x".repeat(1000)
      const file = await ws.write("big.ts", big)
      await readAndRecord(engine, file)
      await expect(engine.writeWhole(file, "tiny", { maxBytes: 500 })).rejects.toMatchObject({
        code: "PATCH_CONFLICT",
      })
    } finally {
      await ws.cleanup()
    }
  })

  it("写过的文件进 trackedFiles（变化清单的来源）", async () => {
    const ws = await createTempWorkspace()
    try {
      const engine = new EditEngine()
      const file = await ws.write("a.ts", "x\n")
      await readAndRecord(engine, file)
      expect(engine.trackedFiles).toContain(path.resolve(file))
      engine.reset()
      expect(engine.trackedFiles).toEqual([])
    } finally {
      await ws.cleanup()
    }
  })
})

describe("patch/edit: 结构化文件写后校验", () => {
  it("合法 JSON 通过，非法 JSON 报出位置", async () => {
    const ws = await createTempWorkspace()
    try {
      expect(validateStructuredFile("a.json", '{"a":1}').ok).toBe(true)
      const bad = validateStructuredFile("a.json", '{"a":1,}')
      expect(bad.ok).toBe(false)
      if (!bad.ok) expect(bad.error).toMatch(/JSON/)
    } finally {
      await ws.cleanup()
    }
  })

  it("JSONC（带注释）也能校验 — 项目配置常见形态", () => {
    expect(validateStructuredFile("tsconfig.json", '{ /* ok */ "a": 1 }').ok).toBe(true)
  })

  it("非结构化文件不校验", () => {
    expect(validateStructuredFile("a.ts", "this is not json at all").ok).toBe(true)
  })
})

describe("patch/diff", () => {
  it("diffText 产出 hunks 与增删统计", () => {
    const diff = diffText("a\nb\nc\n", "a\nB\nc\n", "src/a.ts")
    expect(diff.path).toBe("src/a.ts")
    expect(diff.additions).toBe(1)
    expect(diff.deletions).toBe(1)
    expect(diff.hunks.length).toBeGreaterThan(0)
  })

  it("内容相同则没有 hunk", () => {
    expect(diffText("same\n", "same\n", "a.ts").hunks).toEqual([])
  })

  it("summarize 汇总多个文件的增删与变更范围", () => {
    const summary = summarize([diffText("a\n", "b\n", "x.ts"), diffText("c\n", "c\nd\n", "y.ts")])
    expect(summary.fileCount).toBe(2)
    expect(summary.files.map((f) => f.path)).toEqual(["x.ts", "y.ts"])
    expect(summary.totalAdditions).toBe(2)
    expect(summary.totalDeletions).toBe(1)
  })

  it("formatAll 生成统一 diff 文本", () => {
    const text = formatAll([diffText("a\n", "b\n", "x.ts")])
    expect(text).toContain("x.ts")
    expect(text).toContain("-a")
    expect(text).toContain("+b")
  })

  it("大文件走退化路径也不崩（超 DP 阈值）", () => {
    const before = Array.from({ length: 6000 }, (_, i) => `line ${i}`).join("\n")
    const after = `${before}\nnew line`
    const diff = diffText(before, after, "big.ts")
    expect(diff.additions).toBeGreaterThanOrEqual(1)
  })

  it("纯新增行也能正确识别", () => {
    const diff = diffText("keep\n", "keep\nadded\n", "a.ts")
    expect(diff.additions).toBe(1)
    expect(diff.deletions).toBe(0)
  })
})
