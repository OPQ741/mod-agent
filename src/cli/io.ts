/**
 * CLI 的 I/O 抽象。
 *
 * 抽出来只有两个理由：headless 的输出必须是机器可读的干净 stdout（日志一律走 stderr），
 * 以及交互逻辑要能在测试里被替换成假的输入流 —— 否则"审批流程"这类关键路径
 * 根本没法自动化验证。
 */

import readline from "node:readline"
import { Writable } from "node:stream"

export interface CliIo {
  readonly isTty: boolean
  /** stdout：headless 的机器可读输出专用。 */
  out(text: string): void
  /** stderr：人机提示、警告、日志。 */
  err(text: string): void
  /**
   * 问一行。**返回 null 表示输入已结束**（Ctrl-D / 非交互 / 已关闭），
   * 这与"用户直接回车"必须区分开：前者要退出循环，后者只是空输入。
   */
  ask(question: string): Promise<string | null>
  close(): void
}

export interface ProcessIoOptions {
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  input?: NodeJS.ReadableStream
  isTty?: boolean
}

export function createProcessIo(options: ProcessIoOptions = {}): CliIo {
  const writeOut = options.stdout ?? ((text: string) => process.stdout.write(text))
  const writeErr = options.stderr ?? ((text: string) => process.stderr.write(text))
  const input = options.input ?? process.stdin
  const isTty = options.isTty ?? Boolean((input as { isTTY?: boolean }).isTTY)

  let rl: readline.Interface | undefined
  let closed = false

  const ensureRl = (): readline.Interface => {
    if (!rl) {
      // 提示语也走 io.out：这样测试里能一并收集到，不会出现"断言里少了提示符"。
      const output = new Writable({
        write(chunk, _encoding, callback) {
          writeOut(typeof chunk === "string" ? chunk : String(chunk))
          callback()
        },
      })
      rl = readline.createInterface({ input, output, terminal: false })
      rl.on("close", () => {
        closed = true
        rl = undefined
      })
    }
    return rl
  }

  return {
    isTty,
    out: (text) => writeOut(text),
    err: (text) => writeErr(text),
    async ask(question: string): Promise<string | null> {
      // 非交互或 stdin 已关闭（Ctrl-D）：返回 null，由调用方据此退出
      if (!isTty || closed) return null
      const iface = ensureRl()
      return new Promise<string | null>((resolve) => {
        let settled = false
        const finish = (value: string | null): void => {
          if (settled) return
          settled = true
          iface.off("close", onClose)
          resolve(value)
        }
        const onClose = (): void => finish(null)
        iface.on("close", onClose)
        iface.question(question, (answer) => finish(answer))
      })
    },
    close(): void {
      rl?.close()
      rl = undefined
    },
  }
}

/** 测试与 `--print` 场景用的假 I/O：收集输出、不读输入。 */
export function createMemoryIo(options: { isTty?: boolean; answers?: string[] } = {}): CliIo & {
  stdoutText: () => string
  stderrText: () => string
} {
  const outChunks: string[] = []
  const errChunks: string[] = []
  const answers = [...(options.answers ?? [])]
  return {
    isTty: options.isTty ?? false,
    out: (text) => outChunks.push(text),
    err: (text) => errChunks.push(text),
    async ask(): Promise<string | null> {
      // 允许显式放入空串（模拟"直接回车"），只有答案耗尽才表示输入结束
      if (answers.length === 0) return null
      return answers.shift() ?? null
    },
    close(): void {},
    stdoutText: () => outChunks.join(""),
    stderrText: () => errChunks.join(""),
  }
}
