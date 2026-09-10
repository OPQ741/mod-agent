/**
 * 事件契约守卫。
 *
 * `TASK_EVENT_TYPES` 是类型定义，但"定义了却没人发"是一种沉默的谎言：
 * 文档与 CLI 渲染都以为这个事件存在，实际事件表里永远看不到它。
 * 这条测试扫描 `src/` 里的真实发事件调用点（`sink.emit` / `runtime.appendEvent`），
 * 少任何一个类型就失败，逼着新增事件的人在同一个改动里补上发送方。
 */

import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { TASK_EVENT_TYPES } from "../src/shared/contracts.js"

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src")

async function collectSources(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await collectSources(full)))
    else if (entry.name.endsWith(".ts")) out.push(full)
  }
  return out
}

describe("事件契约", () => {
  it("TASK_EVENT_TYPES 里的每个类型都至少有一个真实发送点", async () => {
    const sources = await collectSources(SRC_DIR)
    const emitted = new Set<string>()
    const patterns = [
      /\.emit\(\s*"([a-z][a-z0-9_]*\.[a-z0-9_]+)"/g,
      // appendEvent(taskId, "task.cancelled", …)
      /appendEvent\(\s*[^,\n]+,\s*"([a-z][a-z0-9_]*\.[a-z0-9_]+)"/g,
    ]
    for (const file of sources) {
      const text = await fs.readFile(file, "utf8")
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
          if (match[1]) emitted.add(match[1])
        }
      }
    }

    const missing = TASK_EVENT_TYPES.filter((type) => !emitted.has(type))
    expect(missing, `这些事件类型只有定义，没有任何发送点：${missing.join(", ")}`).toEqual([])
  })
})
