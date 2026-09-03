#!/usr/bin/env node
/**
 * CLI 进程入口。
 *
 * 单独拆一个文件而不是在 `index.ts` 底部直接自执行：否则任何 `import { runCli }`
 * （测试、SDK 复用）都会顺带把一个真实 CLI 会话跑起来。
 */
import { main } from "./index.js"

await main()
