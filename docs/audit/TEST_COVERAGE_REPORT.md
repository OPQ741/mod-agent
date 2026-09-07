# TEST_COVERAGE_REPORT · 测试与验证报告

> 本报告区分三件事：**跑了什么**（真实执行）、**测了什么**（代码核对）、**测不到什么**（如实声明）
> 原则：不声称没跑过的校验，不把"有测试文件"当成"该行为被测到"

## 1. 执行结果（真实）

```text
$ npx tsc --noEmit
（无输出，退出码 0）

$ npx vitest run
 ✓ tests/shared.test.ts        (32 tests)   169ms
 ✓ tests/model.test.ts         (36 tests)   200ms
 ✓ tests/runtime.test.ts       (43 tests)    63ms
 ✓ tests/policy.test.ts        (59 tests)   566ms
 ✓ tests/context.test.ts       (29 tests)   706ms
 ✓ tests/patch.test.ts         (27 tests)   803ms
 ✓ tests/regression.test.ts    (13 tests)   895ms
 ✓ tests/tools.test.ts         (54 tests)  3518ms
 ✓ tests/sdk.test.ts           (11 tests)  3383ms
 ✓ tests/loop.test.ts          (37 tests) 16039ms
 ✓ tests/cli.test.ts           (31 tests)  9653ms
 ✓ tests/sandbox-store.test.ts (45 tests) 24469ms

 Test Files  12 passed (12)
      Tests  417 passed (417)
   Duration  53.28s
```

| 维度        | 数值                                                 |
| ----------- | ---------------------------------------------------- |
| 测试文件    | 12（+1 helper）                                      |
| 用例总数    | 417                                                  |
| 测试代码行  | 7,263                                                |
| 被测代码行  | 13,410                                               |
| 测试/源码比 | 0.54                                                 |
| 最慢文件    | `sandbox-store.test.ts` 24.5s（真实子进程 + SQLite） |
| 网络依赖    | 0（全部离线）                                        |
| 跳过/仅运行 | 0                                                    |

**工程判断**：测试/源码比 0.54 对于 13k 行的 CLI 项目属于健康区间；
更重要的是测试**类型分布**合理——不是大量"测 getter"，而是真实文件系统、
真实子进程、真实 SQLite、真实 CLI 进程内调用。

## 2. 测试策略评估

### 2.1 做得好的四点

1. **离线可复现**。`ScriptedProvider` 回放固定决策，命令侧只用 `process.execPath`
   与跨平台命令。注释里写明"测试红了永远意味着代码有问题，不会是网络抖动"——
   这条纪律被实际遵守了（我跑了两次，耗时 53s / 39s，全绿）。
2. **脚本耗尽抛错而非兜底**（`scripted.ts:86-90`）。这是关键的防假绿设计：
   如果兜底返回 `final`，"循环空转"这类 bug 会被测试掩盖。
3. **真实文件系统而非 mock fs**（`helpers.ts:5-9` 的注释说明了理由）。
   read-before-edit、mtime 检测、realpath 守卫这些逻辑 mock 掉 fs 就等于一起 mock 掉被测行为。
4. **对"不该假装通过"的自觉**。`policy.test.ts` 里符号链接测试的写法：
   "环境支持则断言拦截，不支持则明确跳过而不是假装通过"。
   这是我在测试代码里见到的最有价值的注释之一。

### 2.2 覆盖热点

按被测模块统计用例分布（`describe` 块）：

| 领域                                        | 用例数 | 代表断言                                                                             |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| policy（命令拆分/规则/路径/引擎）           | 59     | "deny 规则优先于 allow""sudo 在任何模式下都拦""bypassPermissions 也翻不了 deny 的案" |
| tools（6 个内置工具 + executor + registry） | 54     | "命中过多时要求收窄，而不是硬塞""空输出有固定说法"                                   |
| sandbox + store                             | 45     | "超时会带走孙进程（整组 kill）""会话累计输出超预算时 kill""跨进程可读回"             |
| runtime（预算/进度/状态机/驱动）            | 43     | "连续三次同参数同结果 → 压缩成诊断"                                                  |
| loop（主循环全分支）                        | 37     | "验证失败 → 进 Repair Loop（不是照常交付）""批准后恢复：退出码 0，命令真的执行了"    |
| model（两家映射 + 网关）                    | 36     | "流式分片累积的 arguments 也能解析""退避指数增长且有上限，抖动可确定性注入"          |
| shared                                      | 32     | token 估算、JSON Schema 转换、脱敏                                                   |
| cli                                         | 31     | "text 格式：结果进 stdout，事件与提示进 stderr""有 TTY 时真的会问人"                 |
| context                                     | 29     | "压缩后第一条 user 与 system 仍然在""@import 循环引用不死循环"                       |
| patch                                       | 27     | "没读过的文件不允许编辑""newString 里的 `$&` 不被当成替换模式"                       |
| regression                                  | 13     | 8 处已修缺陷的回归                                                                   |
| sdk                                         | 11     | "同一份脚本在 SDK 与 CLI 里产出同样的终态与退出码"                                   |

### 2.3 模块级可达性

46 个可测模块全部被测试直接或间接引用（逐个核对 `tests/**` 的 import 图）。
**没有任何一个模块是"零测试覆盖"**。这一点在 13k 行规模上不常见。

未被直接 import 的 5 个文件：`cli/main.ts`（进程入口，调用 `process.exit`）、
`cli/session.ts`、`cli/repl.ts`、`cli/provider.ts`、`index.ts`——前四个经 `cli/index.ts` 传递覆盖。

## 3. 测不到什么（本次审计最重要的部分）

以下行为**有测试文件、看起来被覆盖，但断言的对象不是真实风险点**。
这是"测试通过 ≠ 行为正确"的具体清单。

### 3.1 单元测试锁定了缺陷行为

| 缺陷                                | 现有测试                                                            | 为什么没拦住                                                                          |
| ----------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| AUD-002 拒绝上限异常穿透            | `policy.test.ts:714-717` 断言 `evaluate()` 抛 `DenialLimitExceeded` | 测试只验证"会抛"，**从未验证调用方接住了**。这个测试实际上把缺陷行为固定成了契约      |
| AUD-004 plan 模式不生效             | `tools.test.ts:1001-1017` 断言返回 `planFilePath`                   | 用的是**桩 controller**，且只断言返回值。工具描述里"写工具已不可用"这句话没有任何测试 |
| AUD-014 Retry-After 未使用          | `model.test.ts:258-263` 标题为"Retry-After 头被解析并**用于退避**"  | 只测了 `parseRetryAfter` 单独解析，没有一条断言网关的等待时长受它影响                 |
| AUD-017 `Store.transition()` 死代码 | `sandbox-store.test.ts:418` 直接调用 `transition`                   | 测试了死代码本身，没有测试"主循环的状态转换是否经过它"                                |

这四条是同一类问题的四个实例：**测试跟着实现走，而不是跟着风险走**。

### 3.2 完全没有测试的关键路径

| 路径                             | 风险                            | 说明                                                                                               |
| -------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------- |
| 并行工具调用                     | 静默丢调用 + 历史被改写         | 无任何 provider 返回多 `toolCalls` 的用例                                                          |
| 验证绕过策略                     | 策略体系外的执行通道            | 所有验证测试都注入假 `runCommand`，从未断言"验证命令也经过 policy"                                 |
| 并发 cancel/pause                | `VersionConflictError` 抛穿循环 | 无并发用例                                                                                         |
| `runtime` 传 `gitignorePatterns` | 配置失效                        | `pathguard` 单测**手动传**了该参数，集成路径从未传过                                               |
| `.env.example`                   | 读不了合法模板文件              | bypass-immune 测试覆盖 `.env`，未覆盖 `.env.example`                                               |
| `preToolUse` 改入参              | 策略绕过                        | 有 3 处 hook 测试，但测的是 block / replaceOutput，未测"改入参后是否重新判定"                      |
| 流式                             | 能力声明为真但未实现            | 已补：`tests/streaming.test.ts` ×14（SSE 回放、两条路径逐字段相等、断流不重试、取消、CLI 输出）    |
| 事件类型完整性                   | 4 个死类型                      | 无"声明表 vs 实际 emit"的一致性测试                                                                |
| 长会话压缩后用户请求是否保留     | 目标漂移                        | `context.test.ts:360` 测了"第一条 user 仍存在"，但构造的消息数组**没有**循环里的动态环境块前置结构 |

最后一条值得展开：`context.test.ts` 构造的输入是 `[system, user(请求), assistant, ...]`，
而生产环境构造的是 `[system, user(环境块), user(请求), ...]`。测试通过，生产环境保护错对象。
**测试的 fixture 与生产的装配顺序不一致**，是这类漏检的根因。

## 4. 覆盖率数字：无法给出（UNVERIFIED）

我尝试了三种方式，均未能得到可信数字：

1. **仓库无覆盖率工具**：`package.json` 没有 `@vitest/coverage-v8` 或 `coverage-v8`，
   `vitest.config.ts` 也没有 `coverage` 配置。
2. **V8 原生采集对 Vite 模块无效**：以 `NODE_V8_COVERAGE=<tmp> npx vitest run` 采集，
   得到 18 个覆盖文件、863 个唯一 URL，其中 `src/` 命中 **0 个**。
   原因是 Vitest 经 Vite 转换后以模块运行器执行，脚本 URL 不注册为 `file://`。
   只有 `vitest.config.ts` 的临时编译产物与 `node_modules` 出现在结果里。
3. **不擅自安装依赖**：安装 `@vitest/coverage-v8` 会改动 `package.json` 与 `package-lock.json`，
   超出"审计阶段不修改工程配置"的边界。

**结论**：覆盖率数字记为 **UNVERIFIED**。上面 §2.3 的"模块级可达性"是可核对的替代指标
（46/46 模块被引用），但它不等于行覆盖率。

**建议**：在 CI 接入测试的同一个 PR 里加 `@vitest/coverage-v8` 与 `coverage.thresholds`，
先用当前实测值作为基线（只降不升），避免"设一个拍脑袋的 80% 然后永远不达标"。

## 5. 测试类型分布

| 类型            | 状态        | 说明                                                                       |
| --------------- | ----------- | -------------------------------------------------------------------------- |
| 单元测试        | IMPLEMENTED | 12 文件，覆盖 46 个模块的纯逻辑与 I/O 边界                                 |
| 集成测试        | IMPLEMENTED | 真实文件系统 + 真实子进程 + 真实 SQLite + 真实 CLI 入口                    |
| E2E（离线）     | IMPLEMENTED | `--script` 回放驱动完整 CLI；`sdk.test.ts` 断言 CLI/SDK 一致性             |
| E2E（真实模型） | MISSING     | 无；这是有意的（离线原则），但意味着协议映射只有 fixture 级验证            |
| Mock Provider   | IMPLEMENTED | `ScriptedProvider`，含函数式脚本与 `append`                                |
| Benchmark       | MISSING     | 无性能/成本基线                                                            |
| 安全测试        | PARTIAL     | 策略与路径有大量用例；缺对抗性注入、缺 bypass 模糊测试、缺恶意仓库 fixture |
| 回归测试        | IMPLEMENTED | `regression.test.ts` 13 条，覆盖 8 处历史缺陷                              |
| 并发测试        | MISSING     | 无                                                                         |

## 6. 建议补充的测试（按性价比排序）

1. **多 tool_call 响应**（1 个用例）：provider 返回 2 个调用，断言两个都执行、历史里两个 `tool_use` 都在。
   —— 这是 AUD-001 的守护测试，成本极低。
2. **验证经过策略**（2 个用例）：`runChecks` 在 `deny` 时产出 `blocked` 而非 `passed`。
   —— SEC-01 的守护测试。
3. **拒绝上限优雅收场**（1 个用例）：连续 20 次拒绝后，循环以 `failed` 终态收尾且落库，
   而不是抛异常。需要同时改掉 `policy.test.ts:714` 那条锁定缺陷的断言。
4. **压缩保留用户请求**（1 个用例）：fixture 按生产顺序构造（system → 环境块 → 请求），
   断言压缩后请求仍在。这条会立刻暴露 AUD-022。
5. **集成路径的 gitignore**（1 个用例）：经 `AgentRuntime.create` 构造 PathGuard，断言 gitignored 路径被拒。
6. **事件类型一致性**（1 个元测试）：遍历 `TASK_EVENT_TYPES`，断言每个类型在 `src/` 里至少有一个 emit 点。
   —— 这个测试会自动发现 AUD-010 这类"声明了但没人发"的问题。
7. **并发 cancel**（1 个用例）：循环执行中调用 `runtime.cancel()`，断言终态为 `cancelled` 且无异常。

前 6 条都是 10 行以内的小用例，但能守住 6 个 P1/P2 缺陷不再回归。
