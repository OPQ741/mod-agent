import { defineConfig } from "vitest/config"

/**
 * 测试全部跑在 node 环境、离线、不联网：
 * 模型侧一律用 `ScriptedProvider` 回放固定决策，命令侧只跑能在任何机器上成功的命令。
 * 这样"测试失败"永远意味着代码有问题，不会是网络或环境抖动。
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 子进程/沙箱测试会 fork，用进程池隔离避免互相干扰
    pool: "forks",
    restoreMocks: true,
  },
})
