# Tools & Extensions · 工具系统、MCP 与 Skills

> 这篇讲工具契约、统一执行结果、幂等与重试、人工审批策略，以及 MCP / Skills 扩展机制。

模型再强，也得靠工具才能真正改代码、跑命令。这篇回答两个问题：模型每一轮能调用哪些工具，一次调用又要过几道检查才能落地。工具按来源分内部核心工具和 MCP 外部能力两类，审批则按动作风险决定放行、拒绝还是问人。读完你会知道 mod-agent 为什么连跑哪条命令都要拆成前缀白名单/黑名单来管。

## 1. 工具分层

**A. 内部核心工具（由 Node 进程直接执行，高可信）**

- `repo.list_files` / `repo.read_file` / `repo.search_text`
- `repo.find_symbol` / `repo.find_references`
- `repo.git_status` / `repo.read_diff` / `repo.apply_patch`
- `command.run` / `test.run`
- `browser.open_page` / `browser.screenshot`（后期）

**B. MCP 外部能力**

- GitHub/GitLab：读 Issue/PR、建分支、发 PR（后期）；
- 文档系统 / 工单系统 / 设计工具 / 自定义企业工具。

MCP 是互操作协议，不天然代表可信或安全。每个 MCP Server 单独登记来源、用途、权限范围、认证方式、网络目标、超时与数据分类；其工具描述、注释、返回内容一律按不可信输入处理。

**MCP 的角色模型（协议规范原文，出处：https://modelcontextprotocol.io/specification/ ）**：

| 角色        | 是谁                    | 干什么                                                                       |
| ----------- | ----------------------- | ---------------------------------------------------------------------------- |
| Host        | 主应用（mod-agent CLI） | 发起并管理所有 MCP 连接                                                      |
| Client      | Host 内部的连接器       | 与某个具体 Server 会话、做能力协商                                           |
| Server      | 外部工具 / 数据服务     | 暴露 Resources（可读数据）/ Prompts（模板化提示）/ Tools（可调用函数）三原语 |
| Elicitation | Client → Server 反向    | 允许 server 在任务中向用户追问信息，映射为 CLI 提问交互                      |

> **版本提示**：上表的 Elicitation、`initialize` 握手、Roots 等机制对应的是 2025-11-25 及更早的规范。现行规范为 2026-07-28，是自发布以来最大的一次改版，握手与会话已被移除、Elicitation 被 MRTR 取代。详见 [§1.2](#_1-2-2026-07-28-规范改了什么-必读-影响所有-mcp-代码)。新代码一律按 2026-07-28 写。

**MCP 工具安全基线（规范原文，出处同上）**：协议文档明确 "Tools represent arbitrary code execution（工具就是任意代码执行）"，要求 "工具描述、注释等应按不可信处理"，也承认 "MCP itself cannot enforce these security principles at the protocol level"。所以 consent / 授权流必须由本 CLI 自己实现：

1. 一个 MCP 工具 = 任意本地代码执行，不能因为它来自某个 server 就信任；
2. 调用有副作用的工具前走显式确认（与 [§5](#_5-人工审批策略) 审批、agent-loop 的阻塞式校验同源）；
3. Host 必须让用户理解每个工具干什么再授权。

### 1.1 MCP 连接生命周期：工具发现、路由与调用

第 1 节的角色模型回答谁是谁，这里补连接怎么建、工具怎么发现、调用怎么路由。下面两张图：第一张是现行规范（2026-07-28）的写法，第二张是已被移除的旧握手，保留旧图是为了让你在读存量资料和旧 server 时不至于困惑。

**现行（2026-07-28，无状态）**：

```mermaid
sequenceDiagram
    participant H as "Host (CLI)"
    participant S as "MCP Server"
    H->>S: 启动 stdio 子进程 / 连上 Streamable HTTP
    H->>S: server/discover（可选，想先摸能力才调）
    S-->>H: 支持的协议版本与身份
    H->>S: tools/list（带 Mcp-Method / Mcp-Name 头）
    S-->>H: 工具清单 + ttlMs 缓存提示（可缓存）
    Note over H: 重命名为 mcp__<server>__<tool> 并合并进工具池
    H->>S: tools/call（每个请求自带 _meta：协议版本/客户端信息）
    S-->>H: 结果 / isError（按不可信内容处理）
    Note over H,S: 无需握手、无需会话粘性，任意请求可落任意实例
```

**旧版（≤2025-11-25，已移除，仅供对照）**：

```mermaid
sequenceDiagram
    participant H as "Host (CLI)"
    participant S as "MCP Server"
    H->>S: 启动 stdio 子进程
    H->>S: initialize（协议版本 / 客户端能力）
    S-->>H: 服务端能力
    H->>S: notifications/initialized（握手完成）
    H->>S: tools/list
    S-->>H: 工具清单
    H->>S: tools/call
    S-->>H: 结果（依赖 Mcp-Session-Id 粘性会话）
```

落地要点：

- **三段式命名**：每个外部工具重命名为 `mcp__<serverName>__<toolName>`，既避免不同 server 同名工具冲突，也让模型与权限规则能精确路由到具体 server；
- **懒加载 + 失败隔离**：server 可按需启动而非开局全拉起；单个 server 启动失败、发现超时或调用超时，只让它名下的工具不可用，不能拖垮主进程或其他 server；连接、发现、调用各设独立超时；
- **合并进工具池时分区排序**：内置工具按字母序在前、MCP 工具追加在后，不做全局混排。缓存断点设在最后一个内置工具之后，动态挂接的 MCP 工具不影响内置工具部分的前缀缓存命中（见 [system-prompt.md §6](./system-prompt.md#_6-工具清单如何呈现给模型)、[model-gateway.md](./model-gateway.md)）；
- **工具 schema 也要过校验**：server 声明的参数模式在注册时做兼容性校验，畸形 schema 不注册；工具结果一律标记为不可信数据，走 [context-engineering.md §6](./context-engineering.md#_6-输入注入与不可信内容) 的注入防护。注意：2026-07-28 起 `inputSchema` 支持完整 JSON Schema 2020-12（含 `oneOf` / `anyOf` / `$ref`），校验器不能再假设它是扁平结构。

### 1.2 2026-07-28 规范改了什么（必读，影响所有 MCP 代码）

这是 MCP 自发布以来最大的一次改版，不是增量更新。如果你在 2026-07 之前学过 MCP，有一部分认知已经是历史了。

| 变化                                  | 旧（≤2025-11-25）                                                          | 新（2026-07-28）                                                                                                                | 对 mod-agent 的影响                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **协议内核**                          | 双向有状态，需 `initialize`/`initialized` 握手 + `Mcp-Session-Id` 粘性会话 | **无状态**：握手与会话头一并废除（SEP-2567/2575），每个请求在 `_meta` 自带协议版本、客户端身份与能力                            | server 可跑在普通轮询负载均衡后，**无需共享会话存储**                                                                               |
| **需要跨调用状态时**                  | 藏在 transport 的会话里                                                    | server 从工具里**签发一个显式 handle**，模型把它当普通参数传回来                                                                | handle 对模型可见、可审计，比藏在传输层好                                                                                           |
| **路由**                              | 网关要解析 JSON body                                                       | 必带 `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` 头（SEP-2243）                                                          | 网关、限流、WAF **只看头部**就能路由和鉴权                                                                                          |
| **服务端反向请求**                    | `sampling/createMessage`、`elicitation/create`、`roots/list`，需常开双向流 | **MRTR（多往返请求，SEP-2322）**：返回 `resultType: "input_required"` + `inputRequests`，客户端带 `inputResponses` 重试原调用   | 审批/追问交互改造为「返回问题 → 客户端补答案重试」                                                                                  |
| **列表结果**                          | 每次重连重新拉                                                             | 带 **ttl 与缓存范围 + 确定性顺序**                                                                                              | 可缓存工具目录，**重连后上游 prompt cache 保持稳定**（直接利好 [§1.1](#_1-1-mcp-连接生命周期-工具发现、路由与调用) 的缓存断点设计） |
| **长任务**                            | 需保持 HTTP 连接打开                                                       | **Tasks 扩展（SEP-2663）**：返回 task handle，客户端用 `tasks/get` / `tasks/update` / `tasks/cancel` 跟踪                       | 数小时级任务不再占连接                                                                                                              |
| **UI**                                | 无                                                                         | **MCP Apps 扩展（SEP-1865）**：server 可返回沙箱 iframe 里的交互 HTML                                                           | 工具可自带表单/面板                                                                                                                 |
| **错误码**                            | 资源缺失返回自定义 `-32002`                                                | 改为 JSON-RPC 标准 **`-32602`**                                                                                                 | 任何硬编码匹配 `-32002` 的代码会静默漏判                                                                                            |
| **废弃（12 个月最短窗口，SEP-2596）** | Roots / Sampling / Logging 可用                                            | 三者**废弃**，分别改用工具参数或资源 URI、直接调 LLM 厂商 API、stderr 或 OpenTelemetry；HTTP+SSE 传输也废弃，转 Streamable HTTP | 别在新代码里用它们；用了就当作已知搬迁债务                                                                                          |

治理归属这点在选型评审时会被问到：Anthropic 已于 2025-12-09 把 MCP 捐给 Linux 基金会旗下的 Agentic AI Foundation（AAIF），创始成员包括 AWS、Anthropic、Block、Bloomberg、Cloudflare、Google、Microsoft、OpenAI；基金会明确不干预技术方向，日常仍走 SEP 流程。MCP 不再是单一厂商的赌注，协议被弃的长期风险显著下降。

规模参考：Tier 1 SDK 月下载接近 5 亿次，TypeScript 与 Python SDK 累计下载各破 10 亿。

Client 侧兼容清单（落到实现）：

- 本地 / 私有 server 用 **stdio**；远端共享 server 用 **Streamable HTTP**（SSE 已是兼容回退，不是推荐）；
- 优先用官方或厂商维护的 server，其次才自建；自建时把工具面做到最窄，写权限单独设闸；
- 信任一个 server 之前，先跑一次低成本健康检查；
- 一次性 HTTP 调用、或"包一个巨大通用 wrapper"的场景，不要用 MCP，直接写个简单工具更合适。

## 2. 工具描述契约（ACI）

```ts
interface AgentTool<I = unknown, O = unknown> {
  name: string // 命名空间，如 repo.read_file
  description: string // 写清楚，防模型幻觉 API
  inputSchema: unknown // Zod / JSON Schema adapter
  outputSchema?: unknown
  risk: "read" | "workspace_write" | "command" | "external_side_effect"
  idempotency: "safe" | "keyed" | "non_idempotent"
  timeoutMs: number
  requiresApproval: (input: I, ctx: TaskContext) => boolean
  execute(input: I, ctx: ToolExecutionContext): Promise<O>
}
```

- 模型可见的工具子集按任务模式、任务状态、用户权限与注册策略动态生成；
- 工具名带命名空间（`repo.read_file`），避免多个 MCP Server 提供同名 `search` 产生歧义；
- ACI 反向定制：输出分页 / 折叠 / 截断、报错结构化带「你可能想运行…」提示、强制绝对路径。Anthropic 实测改成强制绝对路径后，模型再没犯过相对路径错误。

模型说跑什么，运行时不会直接跑。每次工具调用要依次过下面这道安检：

```mermaid
flowchart TD
    T["模型发起工具调用"] --> S{"参数过 Schema 校验?"}
    S -- 否 --> E1["parse_error 回喂模型，不执行"]
    S -- 是 --> P{"权限 policy 判定"}
    P -- deny --> E2["直接拒绝，记策略版本"]
    P -- ask --> H["存审批请求 + 参数 hash，暂停等人"]
    P -- allow --> B{"前缀黑名单?"}
    B -- 命中 --> E2
    B -- 未命中 --> W{"在白名单/超时/路径边界内?"}
    W -- 否 --> H
    W -- 是 --> X["沙箱内执行，记 exitCode/durationMs"]
    X --> R["统一 ToolExecutionResult，标 truncated"]
```

模型想跑的任何一条命令，都要先过一串关卡：参数对不对、允不允许、黑不黑名单、要不要问人，最后拿到的都是一份格式统一、标了截断、带耗时和退出码的结果。这样模型拿到的反馈是确定的，不会因为一次报错文本措辞不同就判断失误。

比如，你刚批准模型跑 `npm test`。下一轮它想跑 `npm install lodash`，这是另一条命令、带网络副作用，不能因为你批过 npm 相关的命令就自动放行。审批必须和具体参数绑定，系统会按参数 hash 重新问你一次。

### 2.1 工具注册：三层流水线与 fail-closed 默认值

模型这一轮能看到哪些工具，不是固定的静态清单，而是每轮按上下文组装的结果：

```mermaid
flowchart LR
    L1["① 基础集：内置工具直接装配<br/>+ 按功能开关条件加载"] --> L2["② 运行时过滤：任务模式 / deny 规则 /<br/>isEnabled / 权限档位"]
    L2 --> L3["③ 组装工具池：内置 + MCP 桥接<br/>分区排序、去重"]
    L3 --> F["最终下发给模型的工具集"]
    style L1 fill:#e8e0ff
    style L3 fill:#7c5cfc,color:#fff
```

工具元数据（只读 / 并发安全 / 破坏性）的默认值必须 fail-closed：

| 标记                | 安全默认     | 为什么默认成这样                                                       |
| ------------------- | ------------ | ---------------------------------------------------------------------- |
| `isConcurrencySafe` | 默认 `false` | 误标「可并发」会让写操作在无保护下并发；误标「不可并发」顶多串行慢一点 |
| `isReadOnly`        | 默认 `false` | 误标「只读」可能绕过写权限检查；误标「非只读」只是多一次确认           |
| `isDestructive`     | 默认 `false` | 破坏性由更上层的命令 / 路径策略显式判定                                |

原则：标记出错时，后果要落在多打扰用户这一边（烦人但安全），而不是静默放行那一边（危险且隐蔽）。

### 2.2 单次工具执行的八阶段生命周期

一次工具调用从模型吐出 tool_use 到结果回到模型，生产级实现拆成固定阶段，把校验、Hook、权限、裁剪这些横切关注点插在标准位置：

1. **工具查找**：按名解析，找不到就回 `Unknown tool` 作为工具结果（不抛异常）；
2. **输入验证（两阶段）**：先做低成本的 Zod schema 校验（字段类型），再做业务校验（如 `edit_file` 的待替换串是否唯一、配置文件改完是否仍是合法 JSON）。先做便宜的检查，减少无谓磁盘 I/O；
3. **并行启动**：Pre-Tool Hook 与命令安全分类器同时启动，各耗时几十到几百毫秒，并行化压低权限判定总延迟；
4. **权限检查**：Hook → 工具自带 `checkPermissions` → 规则引擎 → 分类器 → 交互式确认，顺序裁决（见 [§5](#_5-人工审批策略) 与 [security.md](./security.md)）；
5. **执行**：在沙箱内运行，支持流式进度回调（长命令、多文件任务可回报进度）；
6. **结果处理**：标准化、裁剪；超过 `maxResultSizeChars` 的大结果落盘，模型只收到路径 + 短预览 + 用 read 取回全文的指示（与 [context-engineering.md §5](./context-engineering.md#_5-压缩-compaction-与外置记忆) 的分层裁剪衔接）；
7. **Post-Tool Hook**：可向上下文追加事实或替换输出（如把 stdout 里的密钥打码）；
8. **返回 `tool_result`**：成功或失败都以数据形式回灌模型（见 [agent-loop.md §2.3](./agent-loop.md#_2-3-工具错误是「数据」-不是异常-最轻的自修复)）。

> 每个工具还可自带两类渲染：`prompt()` 向系统提示词注入该工具的专属使用指南（内聚于工具），`renderToolUse / renderToolResult` 决定它在 TUI 里怎么展示。新增工具无需改全局渲染。

### 2.3 延迟加载（deferred tools / tool_search）

工具一旦多起来，把所有工具的完整 schema 都下发给模型，会固定占用大量 token。成熟做法是**延迟加载**：

- 不常用工具打 `deferred` 标记，下发时只给名字、不给完整 schema；系统提示词里告知模型这些工具可以通过 `tool_search` 按需激活；
- 模型需要时调用 `tool_search`（按名字 / 关键词检索），匹配到的工具被加入已激活集合，下一次模型请求才带上其完整 schema；
- 典型例子是 `enter_plan_mode` / `exit_plan_mode`（见 [agent-loop.md §3.2](./agent-loop.md#_3-2-plan-mode-的落地-只读契约-计划文件-审批四选项)）：只在用户要规划时才值得占 schema。

这与 [§6](#_6-skills-·-工程流程复用) Skills 的常驻只放 frontmatter 摘要、正文按需加载是同一思路：把能力的目录给模型，把详情推迟到真正使用的时刻。

### 2.4 并行工具执行

模型一轮可能请求多个工具（如同时读 5 个文件）。全部串行会让只读等待白白累加：

- 并发安全判定按参数而非按工具：`isConcurrencySafe(input)` 接收本次入参。同一个 shell 工具，对 `ls` 判只读、对 `rm` 判非并发，比给整个工具贴标签精确；
- 调度规则：有非并发安全工具在执行时，它独占执行；只存在并发安全工具时可并行，并设并发上限（如 10）；
- 与流式配合：流式响应中某个只读工具的参数 JSON 一旦完整（`content_block_stop`）就提前开跑（见 [agent-loop.md §2.4](./agent-loop.md#_2-4-流式窗口里提前执行工具)）；对不支持工具 block 级流式事件的后端，则把连续的并发安全工具分组用 `Promise.all` 并行执行；
- 混合序列要保持语义：`[读, 读, 写, 读]` 被切成 `[读‖读] → [写] → [读]` 三个批次，写操作前后的读不会跨越写操作并行，避免读到中间态。

典型收益：模型一轮读 3–5 个文件时，并行通常带来 2–3 倍的提速，且文件读取（毫秒级）几乎能完全藏进模型流式生成（数秒到数十秒）的窗口里。

## 3. 统一执行结果

```ts
interface ToolExecutionResult<T = unknown> {
  callId: string
  toolName: string
  status: "succeeded" | "failed" | "timed_out" | "cancelled"
  output?: T
  error?: { code: string; message: string; retryable: boolean }
  startedAt: string
  finishedAt: string
  durationMs: number
  artifacts?: Array<{ kind: string; uri: string; sha256?: string }>
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }
}
```

- observation 一律标注 `truncated`，让模型知道结果不完整；
- 错误对象必须有稳定 `error_code`，不靠匹配自然语言报错文案来判断分支。

## 4. 重试与幂等

- 只读操作（GET、搜索、读文件）可按策略有限重试；
- 模型请求重试区分超时 / 限流 / 网络错误 / 参数错误，遵守 `Retry-After`，指数退避加抖动；
- 补丁重试前必须检查目标文件 hash 与是否已应用，不能不判断就再写；
- 创建 PR、发消息、改工单等外部副作用用幂等键，或先查副作用是否已发生；没有幂等保证时，超时后不自动重放，转人工确认；
- 结果未知的非幂等调用进入 `outcome_unknown` 语义，而非自动标失败后重试。

## 5. 人工审批策略

| 风险动作                           | 默认策略                                         |
| ---------------------------------- | ------------------------------------------------ |
| 读工作区内普通源码                 | 允许，受路径策略约束                             |
| 改授权目录内源码                   | 按任务模式允许，前端展示 diff                    |
| 改锁文件 / 权限 / CI/CD / 部署脚本 | 更严格确认或管理员策略决定                       |
| 跑测试 / lint / 类型检查           | 命令在白名单 / 隔离环境内可自动执行              |
| 新增依赖、访问外网装包             | 需网络策略放行；首次新增建议审批                 |
| 读密钥 / 凭证 / SSH 私钥           | 默认拒绝；确需则由服务端能力托管，不回模型上下文 |
| 批量删文件、改 Git 历史            | 默认拒绝或强制审批                               |
| push / 建 PR / 合并 / 发布         | 先审批；MVP 默认不自动 merge / deploy            |
| 访问生产系统 / 改线上数据          | 默认拒绝，需独立授权与审计                       |

审批必须与具体动作参数绑定：用户批准了 `command.run` 的一条命令，不能复用于参数不同的另一条。保存请求摘要、参数 hash、策略版本、审批人、时间、结果与失效时间。

### 5.1 细粒度权限矩阵（Kilo Code 实证，出处：https://kilo.ai/docs/features/auto-approving-actions ）

不要只做一个全自动总开关。把动作拆成类别，各自标风险并逐项决定 ask / auto / deny：

| 动作          | 风险等级 | 默认建议                |
| ------------- | -------- | ----------------------- |
| 读文件 / 目录 | 中       | 可自动（起手推荐）      |
| 改文件        | 高       | 默认逐次确认            |
| 执行终端命令  | 高       | 仅白名单前缀可自动      |
| 无头浏览器    | 中       | 逐次确认                |
| 调用 MCP 工具 | 中高     | 逐次确认 + 可单独白名单 |

- 另设主开关一键全开 / 全关，便于在敏感代码与快速开发之间切换；
- 工作区外读写、受保护文件写、删除，各自再独立标极高并默认关闭；
- 自动批准与快照是捆绑设计：单独放开 auto-approve 而无每步快照等于裸奔（见 [code-editing.md §3](./code-editing.md#_3-工作区隔离与用户变更保护)）；官方同样警告 auto-approve 可能造成数据丢失 / 文件损坏。

命令执行 = 前缀白名单 + 前缀黑名单，且黑名单优先级最高（出处同上）：

1. 白名单写命令前缀（`git`、`npm test`、`ls`），命中即自动执行不问人；
2. 黑名单写危险前缀，无论白名单是否含 `*`，黑名单一律拦截；
3. 生产 / 敏感数据场景禁止用 `*` 放开全部；删除类操作单独一档（极高风险）。

最高自治档（YOLO）必须配前置守门员（出处同上）：YOLO = 一键放开全部权限，仅推荐隔离环境 / 低风险任务；可选开启 AI 守门员，用一个小而快的模型在每个写操作真正落盘前先判一次，放行或拦截。守门员有额外成本与延迟；生产 / 敏感数据默认不开 YOLO。

权限模型分两层，别混为一谈（Zed 实证，出处：https://zed.dev/docs/ai/tools ）：

1. **Profile（工具可用性）**：决定某 agent 线程挂载哪组工具（read / search / edit / terminal / mcp…），不挂载即物理不可用；
2. **Tool Permission（行为）**：对每个已挂载工具设三态：自动批准 / 自动拒绝 / 逐次确认；
3. 终端工具额外叠加 OS 级沙箱：限制可访问的网络主机（`allow_hosts` / `allow_all_hosts`）。

能不能用，与用的时候要不要问人，是两个正交维度，应分别配置。

## 6. Skills · 工程流程复用

| 概念                  | 是什么                                                 | 例子                                                    |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| **Tool**              | 可被程序调用的原子能力                                 | 读文件、搜代码、跑测试                                  |
| **Skill**             | 可复用的工作流程 / 说明，指导 Agent 何时按何步骤调工具 | 「定位 React 状态竞态」「给项目加页面」「排查构建错误」 |
| **Workflow / 状态机** | 程序强制执行的可靠流程                                 | 必须审批、测试失败最多修两轮、取消后不再跑命令          |

安全约束不能只写在 Skill 文本里：Skill 可以建议，Policy 与状态机负责强制。

### 6.0 Agent Skills 已是一个开放标准（2026 核实）

`SKILL.md` 这套一个目录 + 一个 Markdown 文件的格式，已经是一个开放标准：由 Anthropic 提出并开源、被大量 agent 产品采用（出处：https://skill.md ）。这一点决定了 mod-agent 该怎么选：直接跟标准，而不是自造一套。

格式小到不能再小：一个目录 + `SKILL.md`（YAML frontmatter + Markdown 正文）。frontmatter 只有两个必需字段：

| 字段            | 必需 | 约束                                                                                    |
| --------------- | ---- | --------------------------------------------------------------------------------------- |
| `name`          | 是   | 1–64 字符，仅小写字母、数字、连字符；无首尾连字符、无连续连字符；**必须与父目录名一致** |
| `description`   | 是   | 1–1024 字符，非空；须同时说清**做什么**和**何时用**，并带上便于匹配的关键词             |
| `license`       | 否   | 许可证名或指向 bundled 许可证文件                                                       |
| `compatibility` | 否   | ≤500 字符，说明环境要求（目标产品、系统包、网络）                                       |
| `metadata`      | 否   | 字符串键值映射，给标准未定义的属性用                                                    |
| `allowed-tools` | 否   | 空格分隔的预批准工具串；**规范标为实验性**，各实现支持度不一                            |

目录约定（可选）：`scripts/`（可执行代码）、`references/`（按需加载的文档）、`assets/`（模板与静态资源）。正文无任何格式限制，规范建议写清分步指令、输入输出示例、常见边界情况，并建议把过长的正文拆到被引用的文件里，因为正文一旦激活就整体进入上下文。

真正让这套格式好用的是渐进披露三段，也是所有实现唯一的共同行为：

```mermaid
flowchart LR
    D["1 发现<br/>启动只加载 name + description<br/>约 50–100 token/个"] --> A["2 激活<br/>任务匹配上才读正文"]
    A --> E["3 执行<br/>脚本/参考按需再读"]
    E -.->|"未命中则永不加载"| N["其余技能零成本躺在磁盘上"]
    style D fill:#e7f1ff
    style N fill:#f5f5f5
```

一个团队可以装几十个技能，平时只付几十个名字 + 一句话的 token 成本。这也意味着 `description` 是整份文件里权重最高的字段，它是模型在做决定前唯一能看到的文字：写得太模糊，技能永远不会触发；写得太宽泛，技能会在不该触发的时候乱触发。

规模与落地：规范的客户端展示页列出 46 个产品支持，包括 Claude Code、ChatGPT/Codex、Cursor、GitHub Copilot、VS Code、Gemini CLI、OpenHands、Goose、Amp 等。安装路径的通用位置是项目根的 `.agents/skills/`，Claude Code 另扫 `.claude/skills/`（个人 `~/.claude/skills/`、项目 `.claude/skills/`）。规范建议正文 <5000 token / <500 行。

要清醒的边界：规范只定义了目录里放什么，没有定义目录放哪、重名怎么解、遇到没见过的 frontmatter 字段怎么办。跨 agent 移植时坏掉的正是这三件事，所以 [§6.3](#_6-3-选择与版本管理) 要求自己维护 `id` / `version` / `content_hash`，不要指望标准替你解决。

安全（规范原文强调）：只从可信来源装技能。恶意技能可以让 agent 以与其声称目的不符的方式调用工具或执行代码，造成数据外泄或未授权访问。启用前需审计 `SKILL.md` 及其所有附带文件（`scripts/`、图片、资源），重点看异常的网络调用、与声称目的不符的文件访问模式。从外部 URL 取数的技能风险尤其高，即使技能本身可信，它的外部依赖也可能随时间变坏。把装技能当成装软件来对待。

### 6.1 Skill 文件结构

```text
.agent/skills/
  react-feature/
    SKILL.md
    examples.md
    checklist.md
  bug-triage/
    SKILL.md
    checklist.md
  test-repair/
    SKILL.md
    examples.md
```

`SKILL.md` 包含：名称、适用场景、输入前提、必须遵守的边界、步骤、成功条件、常见失败与恢复方式、需调用的工具、相关示例。按需加载，不要把所有 Skill 一次性塞进每轮上下文。

Skill 文件标准（Claude Code 实证，出处：https://code.claude.com/docs/en/skills ）：每个技能一个目录，目录下必须有 `SKILL.md`；它由两段组成：YAML frontmatter（告诉模型何时用）+ Markdown 正文（用的时候遵循的步骤）：

```text
my-skill/
  SKILL.md          # frontmatter（name / description / paths / allowed-tools）+ 正文
  reference.md      # 详细参考资料，按需自读
  examples.md
  scripts/helper.py # 被工具调用，而非被读入上下文
```

- **按需加载**：与规则文件常驻不同，技能正文只在被触发时进入上下文，常驻的只有技能名 + description 清单，长参考资料几乎零成本；
- **`SKILL.md` 建议 ≤ 500 行**：详细参考拆到 `reference.md` / `examples.md`，正文用相对路径引用，由模型按需自读；
- frontmatter 的 `description` 决定模型何时自动触发；`paths`（glob）限定只在命中某类文件时触发；命令名取自目录名，用户可 `/name` 手动调用。

### 6.2 触发路径与执行模式（inline / fork）

技能有两条等价的触发路径，最终汇合到同一个「展开技能 prompt」的逻辑：

1. **用户手动调用**：输入 `/commit [参数]`，CLI 解析出技能名与参数，展开 prompt 后交给主循环；
2. **模型程序化调用**：用户只说"帮我提交代码"，模型理解意图后调用 `skill` 工具，工具返回的是展开后的指令文本（元工具：它返回的不是数据，而是给模型的指令），模型在随后的回合按它执行。

只支持手动会漏掉用户根本不知道有这个技能的场景；只支持模型自动调用又失去精确触发时机，两条路径都要有。

技能 prompt 在执行前做模板替换：

- `$ARGUMENTS` / `${ARGUMENTS}`：替换用户传入的参数；
- `${CLAUDE_SKILL_DIR}`（mod-agent 对应 `${AGENT_SKILL_DIR}`）：替换技能目录，便于技能正文引用同目录下的模板、脚本（`scripts/` 下的脚本由工具调用执行，而不是读进上下文）。

执行模式有两种：

| 模式               | 行为                                                                                                            | 适用                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **inline（默认）** | 把展开后的 prompt 直接注入当前对话，由主 agent 继续                                                             | 一两步、不污染上下文的轻量流程（如规范一次提交信息）                           |
| **fork**           | 派生一个**独立子 agent**，以技能 prompt 为其系统提示、按 `allowed-tools` 白名单收敛工具，单独跑完只回传最终结果 | 需要多轮工具调用、会读很多文件的流程（如代码审查）——避免这些中间过程污染主对话 |

fork 的安全约束：工具集受 frontmatter `allowed-tools` 白名单限制；未指定时至少摘除 `agent` / 子代理派生工具以防止递归；fork 出去的子 agent 必须继承主 agent 的权限模式（不能借 fork 提权，见 [verification-and-multiagent.md](./verification-and-multiagent.md) 与 [autonomy.md §3.5](./autonomy.md#_3-5-权限必须传播给子代理)）。

> 技能发现遵循项目级覆盖用户级（先加载用户目录、再加载项目目录，同名以项目为准）；启动时只载入 frontmatter，正文调用时才读取。技能清单也要受 token 预算约束：预算充足时全量展示描述，紧张时保留内置常用技能的完整描述、其余降级为仅列名称。

### 6.3 选择与版本管理

- 由轻量 Router 按任务类型召回候选；明确的用户指令优先；
- 每个 Skill 带 `id`、`version`、`source`、`content_hash`、`trust_level`；
- 仓库内 Skill 是项目辅助指引而非安全策略；启用外部来源 Skill 前审阅并固定版本；
- Skill 作为可评测资产：维护标准任务与成败案例，验证它是否真的降低步骤错误、修改范围与成本。

### 6.4 规则加载的激活矩阵（Cursor 实证，出处：https://cursor.com/docs/rules ）

规则不是一股脑全塞进 prompt。用 frontmatter 三个开关决定一条规则何时注入上下文，这样既不撑爆上下文，又能装很多规则：

| alwaysApply | description | globs | 何时注入上下文                     |
| ----------- | ----------- | ----- | ---------------------------------- |
| true        | —           | —     | 每次会话都注入                     |
| false       | —           | 提供  | 上下文里出现匹配文件时自动挂载     |
| false       | 提供        | 省略  | agent 读描述后自行判断相关性再拉取 |
| false       | 空          | 空    | 仅当用户 `@规则名` 时注入          |

- 规则源优先级 Team → Project → User，冲突时前者优先；
- 最佳实践：单条规则 < 500 行、大规则拆成可组合小规则、用 `@文件` 引用而非复制内容。

嵌套规则文件（就近优先，出处同上）：支持在任意子目录放 `AGENTS.md`；当操作的文件位于某目录（或其子目录）时，自动叠加该目录及所有父目录的 `AGENTS.md`，越靠近文件的规则越优先（例：根 `AGENTS.md` 全局风格 + `components/AGENTS.md` 组件约定），无需用户手动 @ 引用。

### 6.5 Hooks 生命周期挂点（Claude Code 实证，出处：https://code.claude.com/docs/en/hooks ）

在 agent loop 的固定挂点允许用户脚本介入，事件分三类节奏：

| 节奏     | 事件                                        | 可否阻断          |
| -------- | ------------------------------------------- | ----------------- |
| 会话     | SessionStart / SessionEnd                   | 否                |
| 轮次     | UserPromptSubmit / Stop                     | 可阻断 prompt     |
| 工具调用 | PreToolUse（执行前）/ PostToolUse（执行后） | PreToolUse 可阻断 |

1. 钩子从 stdin 收事件 JSON，用退出码 2 阻断，stderr 作为原因回喂模型；
2. PreToolUse 输入含 tool_name / tool_input（文件路径展开为绝对路径，防 `~/` 相对路径绕过）；
3. PostToolUse 两种介入：`additionalContext`（向上下文追加事实，如当前分支 / 测试命令；超长则落盘只传路径）、`updatedToolOutput`（替换模型看到的工具输出，如把 stdout 里的密钥打码为 `[redacted]`，不影响已发生的副作用）；
4. 写作要求：追加内容用陈述句事实，避免祈使句式系统指令，否则会触发模型的 prompt-injection 防御而被丢弃。

真实 Claude Code 的完整 Hooks 体系（v2.1.88 快照）：上面 6 个是最常用、官方文档化的事件；实际运行时按生命周期分约 13 组、23+ 个事件，四个执行点（会话边界 / 轮次边界 / 工具执行前 / 工具执行后），且在执行点可产出四种决策：

| 决策类型       | 效果                                               |
| -------------- | -------------------------------------------------- |
| 继续（放行）   | 正常往下走                                         |
| 阻断（exit 2） | 阻止本次动作，stderr 回喂模型                      |
| 追加上下文     | 向上下文加事实（PostToolUse 的 additionalContext） |
| 替换输出       | 改模型看到的工具输出（updatedToolOutput）          |

除上表的核心事件外，还有 Notification、SubagentStop、PreCompact、SessionStart 的 `source` 等更细挂点（如压缩前、子 agent 停止、通知时）。对 mod-agent：

- MVP 先做上表 6 个事件 + 阻断/追加/替换三类决策，覆盖 90% 场景；其余事件按真实需求再补；
- Hook 是确定性扩展，比让模型临场改行为可靠，它是用户/组织在不写代码的前提下插进主循环的确定性逻辑；
- Hook 与 Auto Mode 的 Stop hook 是同一套引擎：`/goal` 本质就是封装了一个会话级 Stop hook（见 [autonomy.md §1.5](./autonomy.md#_1-5-真实-claude-code-证据-goal-其实是-stop-hook-的封装)）；
- CI/无人值守默认不自动加载仓库自带 hooks（`--bare`，见 [security.md §3](./security.md#_3-沙箱基线)），防止恶意仓库借 hook 执行任意代码。
