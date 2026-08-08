# Claude Code Guide · 对标产品实战教程

> 本文把 Claude Code 当作一个可核验的对标样本：记录公开能力、操作方式和实现限制，帮助我们做设计判断，而不是复制它的私有实现。[coding-agents.md](./coding-agents.md) 用于横向比较，[usage.md](./usage.md) 描述 mod-agent 的目标交互，各机制专题定义本项目的设计。
>
> Claude Code 更新频繁，本文不是替代官方文档的永久手册。涉及版本、数值、权限和命令时，应以文中标注的核验日期和官方链接为准；实现前再确认目标版本。

## 0. 怎么读这篇

### 0.0 先说结论

先建立三条判断；后续章节都围绕它们展开。

第一条，Claude Code 的产品形态是"模型外面那一层"。官方自己的措辞是三段式：gather context、take action、verify results，并且明确把外面这层叫 **agentic harness**：工具与模型可见的上下文都由它管理。同一个模型换一层外壳，能力差别可以非常大，这就是它值得逐条拆解的原因。

第二条，配置是拼接而不是覆盖，权限是判定而不是提示。`CLAUDE.md` 各级文件全部拼进上下文，谁都不压掉谁；权限判定按 deny、ask、allow 的顺序走规则引擎，模型说什么不影响结论。这两件事共同解释了它为什么敢放自治权限。

第三条，沙箱和权限是两套独立系统，各有各的盲区。沙箱只管 Bash 子进程的文件与网络，内置的 Read、Edit、Write、WebFetch 走的是权限规则；反过来，hooks、本地 MCP server、statusline 脚本、`apiKeyHelper` 全都在沙箱外执行。只知道其中一套的人，会高估自己的隔离程度。

### 0.1 事实基线

本教程的事实基线：**Claude Code CLI v2.1.300**，官方文档站 129 个页面，抓取核实于 **2026-08-15**（TS SDK 0.3.300、Python SDK 0.2.167 同日核实）。

正文刻意不逐条标"自 v2.1.xxx 起"。这个产品每周发版，把版本号写进每一条事实，等于给自己埋一批必然腐坏的注脚。只有三种情况例外：某个默认值发生过反转（需要解释为什么别处的教程和你看到的界面不一致）、某个能力有明确的版本下限（不升级就没有）、某条网上广为流传的说法已经被官方改掉。这时版本史本身就是内容。

还有一类事实只给区间不给小数：星数、成本样本、模型别名当日解析到的具体型号。这些每月都在动，写精确值就是维护负担。

### 0.2 与其他文档的分工

| 你想搞清楚                                     | 去读                                                                                                       | 本文给不给                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 业界有哪些 agent、各自什么形态                 | [coding-agents.md](./coding-agents.md)                                                                     | 只给 Claude Code 一格        |
| mod-agent 将来怎么用、命令怎么敲               | [usage.md](./usage.md)                                                                                     | 不讲，那是设计规格           |
| mod-agent 自己的权限引擎、状态机、存储怎么设计 | [security.md](./security.md)、[agent-loop.md](./agent-loop.md)、[data-and-events.md](./data-and-events.md) | 每节末给启示并指回           |
| Claude Code 的机制为什么值得这么做             | [research.md](./research.md)、[coding-agents.md](./coding-agents.md) §5                                    | 给事实与数值                 |
| 引用了哪些一手页面                             | [references.md](./references.md) §15                                                                       | 只标页名，URL 集中在参考来源 |

### 0.3 一处合规提醒

`anthropics/claude-code` 根目录 `LICENSE.md` 的全文只有一句："© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms of Service."。GitHub 的 license 识别字段为空，也就是说它不是任何被登记的开源证。这个仓库公开的是 CHANGELOG、官方插件、内建 mods 源码、示例与 issue 治理流水线，CLI 实现本体不在里面。

本教程只陈述上述事实。能不能据此复刻某个机制，属于要另读商业条款正文的判断，本文不作结论，各专题的设计决策也不以"它这么做了"作为依据。

## 1. 装起来、登进去、跑第一次

### 1.1 安装路径与一条容易读反的说明

官方推荐的是原生安装脚本。

```text
macOS / Linux / WSL   curl -fsSL https://claude.ai/install.sh | bash
Windows PowerShell    irm https://claude.ai/install.ps1 | iex
Windows CMD           curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd
```

包管理器两条：`brew install --cask claude-code`（`claude-code` 跟的是 stable 通道，官方自己写明"typically about a week behind"；追新用 `claude-code@latest`）和 `winget install Anthropic.ClaudeCode`。Linux 还有 apt、dnf、apk。

npm 这条路要单独说清，因为网上教程和它自己的徽章互相打架。README 里有一句原文："Installation via npm is deprecated. Use one of the recommended methods below."，但包仍然在发，`npm install -g @anthropic-ai/claude-code` 装得上。它要求 Node.js 22 或更高，低版本只会打一条 `EBADENGINE` 警告而不是失败，因为**这个 npm 包下载的是同一个原生二进制，`claude` 跑起来并不调用你机器上的 Node**。README 顶上那枚 `Node.js-18+` 徽章是旧的，以 setup 页为准。升级要写全 `npm install -g @anthropic-ai/claude-code@latest`，文档明确写了"Avoid `npm update -g`"，并且警告不要用 `sudo npm install -g`。

自检两条命令：`claude --version`（形如 `2.1.211 (Claude Code)`）和只读诊断 `claude doctor`。会话内的 `/doctor` 是另一个东西，它会给出可修复的建议。

### 1.2 更新与版本下限

原生安装"automatically update in the background"，手动按 `claude update`。组织侧可以用两个 managed 键把版本框住：`requiredMinimumVersion` 与 `requiredMaximumVersion`，个人侧对应 `autoUpdatesChannel` 和 `minimumVersion`。用包管理器装的，默认得自己升。

### 1.3 鉴权走的哪几条路

| 路径            | 适用                                                                              | 进入方式                                                                     |
| --------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Claude 订阅账号 | Pro、Max                                                                          | 首次 `claude` 弹出登录，走 claude.ai 授权                                    |
| 团队 / 企业账号 | Team、Enterprise                                                                  | 被邀请的 claude.ai 账号                                                      |
| Claude Console  | API 计费                                                                          | Console 凭据，可以不建 API key 直接登录                                      |
| 环境变量        | 流水线、脚本                                                                      | 已设 `ANTHROPIC_API_KEY` 且你确认，则跳过登录提示                            |
| 云平台          | Bedrock、Google Cloud's Agent Platform、Microsoft Foundry、Claude Platform on AWS | 登录屏选 3rd-party platform，或走各自环境变量                                |
| 企业网关        | 自托管 Claude apps gateway                                                        | `/login` 走企业 SSO，"gateway-issued token is the session's only credential" |

多账号并存靠 `CLAUDE_CONFIG_DIR` 隔离，官方给的写法就是一行 alias：`alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'`。凭据在 macOS 进 Keychain，写不进去回落到 `~/.claude/.credentials.json`（`0600`）；Linux 和 Windows 直接落这个文件。`/logout` 会顺带重置首启设置。长期令牌用 `claude setup-token`；`claude auth status` 输出 JSON，并且**登录返回 0、未登录返回 1**，CI 里可以直接拿它做前置检查。

### 1.4 第一次会话实际长什么样

进目录敲 `claude`。第一次启动会先让你确认这个目录可信，然后等一句话。

```text
> 这个仓库的登录链路是怎么走的
[读] CLAUDE.md · rg -n "login|session" src/ · git log --oneline -15
[答] 入口 src/auth/cli.ts:41 起，凭证落到 ~/.claude/.credentials.json …

⏸ manual mode on                              ← 状态栏，Shift+Tab 切档
> _
```

第一次用它的人最容易在这里建立错误预期：它没有先问你"要我读哪些文件"，直接就开始翻了。只读动作在 Manual 模式下不弹框，这是它跑得快的原因，也是后面 §5 要谈的边界起点。

### 1.5 对 mod-agent

安装面要尽早定死三件事：单一原生二进制、包管理器只做转发、凭据永不进命令行参数。[usage.md §1](./usage.md) 已经定了"凭证只走配置文件或环境变量"，这与它的做法一致，差别在于我们还应该像它那样把"npm 装的是同一个二进制"写进文档，免得将来两边版本语义打起来。版本下限与强制升级策略属于 managed 层能力，见 [security.md §4](./security.md)。

## 2. 日常操作面：模式、前缀、键位

### 2.1 六种权限模式

`Shift+Tab` 在模式之间循环（Windows 上终端没开 VT 输入时是 `Alt+M`），完整顺序按官方原文是 `default`、`acceptEdits`、`plan`，然后按可用性插入 `bypassPermissions` 和 `auto`。`dontAsk` 永远不进循环，只能启动时指定。

| 模式                             | 免询问的动作                                                                         | 状态栏文案                 |
| -------------------------------- | ------------------------------------------------------------------------------------ | -------------------------- |
| `default`（界面里叫 **Manual**） | 只有读                                                                               | `⏸ manual mode on`         |
| `acceptEdits`                    | 读、文件编辑、常见文件系统命令（`mkdir`、`touch`、`rm`、`rmdir`、`mv`、`cp`、`sed`） | `⏵⏵ accept edits on`       |
| `plan`                           | 读，外加 auto 可用时由分类器放行的命令                                               | `⏸ plan mode on`           |
| `auto`                           | 一切，但有后台安全检查（独立分类器实时裁决）                                         | `⏵⏵ auto mode on`          |
| `dontAsk`                        | 工作目录内读取加已 allow 的项，其余**一律拒绝**                                      | `⏵⏵ don't ask on`          |
| `bypassPermissions`              | 一切，提示与安全检查都关                                                             | `⏵⏵ bypass permissions on` |

两个时间点值得记住：`default` 在界面上改名 Manual 发生在 v2.1.200；v2.1.283 起，没显式配过权限模式的新会话（终端与 VS Code）**起始就是 `auto`**，而 `claude -p` 与 Agent SDK 起始仍是 `default`。也就是说，"它默认会问我"这句话已经不太成立了，默认变成"有个分类器在替我问"。

有几类动作任何模式都不会自动批准：命中显式 ask 规则的调用、组织设为 ask 的 connector 工具、需要人交互的工具（`AskUserQuestion`、标了 `requiresUserInteraction` 的 MCP 工具）、critical path 上的 `rm` 与 `rmdir`、跨会话消息防护，以及 v2.1.257 起开了 `permissions.blockReadsOutsideWorkingDirectories` 之后的目录外读取。这份清单的价值在于它是"自治上限"的可执行定义。

### 2.2 输入前缀只有四个

| 前缀 | 作用                             | 备注                                                                |
| ---- | -------------------------------- | ------------------------------------------------------------------- |
| `/`  | 斜杠命令或 skill                 | 二者已经合并，见 §10.1                                              |
| `!`  | shell mode，命令与输出都进上下文 | 默认会对输出自动作答，`respondToBashCommands: false` 改成只入上下文 |
| `@`  | 引用文件路径                     | v2.1.232 起；MCP 资源用 `@server:protocol://path`                   |
| `:`  | emoji shortcode                  | v2.1.217 起                                                         |
| `?`  | 空输入时打开快捷键面板           | 前缀表之外，单独提一下                                              |

有一处需要专门辟谣：很多教程还写着行首 `#` 是"快速记进 CLAUDE.md"，现行的 `interactive-mode` 与 `memory` 两页里都没有这个语法了，只剩 `memoryBackgroundColor` 这个配置项的描述里还提到"`#` memory entries"。写文档时不要把它当事实。

### 2.3 键位里真正会天天用的

| 键                          | 作用                                                             |
| --------------------------- | ---------------------------------------------------------------- |
| `Shift+Tab`                 | 切权限模式                                                       |
| `Esc`                       | 中断当前生成，**保留已完成的工作**                               |
| `Esc` `Esc`                 | 打开 rewind 菜单（输入框有字时改为清空草稿并存进历史）           |
| `Ctrl+C`                    | 中断或清空输入，按两次退出                                       |
| `Ctrl+D`                    | 退出（第一次只给确认提示，800ms 内按第二次才真退）               |
| `Ctrl+B`                    | 把正在跑的 Bash 命令或 agent 摘到后台（tmux 里按两次）           |
| `Ctrl+O`                    | transcript viewer，展开 thinking 与工具细节                      |
| `Ctrl+R`                    | 反向搜索历史输入                                                 |
| `Ctrl+G`                    | 在默认编辑器里改当前输入或改计划                                 |
| `Ctrl+T`                    | to-do 清单（注意：**不是**后台任务视图，后台看 `/tasks`）        |
| `Ctrl+X` `Ctrl+K`           | 停掉本会话所有后台子代理（3 秒内按两次确认）                     |
| `Alt+P` / `Alt+T` / `Alt+O` | 切模型、切 thinking、切 fast mode（macOS 需先开 Option as Meta） |

键位是可自定义的：`/keybindings` 会创建并打开 `~/.claude/keybindings.json`，改完热重载。曾经用来选按键风格的 `keybindingFlavor` 已废弃且不起作用，v2.1.261 起统一按 readline 约定走。

### 2.4 模型、effort 与 thinking

`/model` 接受的是别名，不是完整 model ID：`default`、`best`、`fable`、`sonnet`、`opus`、`haiku`，加上 `[1m]` 变体和 `opusplan`。别名到具体型号的解析结果**按平台不同**，而且会随版本变，基线当天在 Anthropic API 上是 `opus` 指 Opus 5.5、`sonnet` 指 Sonnet 5.5、`haiku` 指 Haiku 5.5、`fable` 指 Fable 5.1；换到 Bedrock 或 Foundry 就是另一组。这类映射不要抄进长期文档，要用时现查。

设置模型的优先级是一条链：`/model` 写入 user settings，高于 `claude --model`，再高于 `ANTHROPIC_MODEL`，再高于 settings 里的 `model`，最后才是 `ANTHROPIC_DEFAULT_MODEL`。`/model` 面板里 `Enter` 是"切换并存为默认"，按 `s` 只切本会话。

effort 有 `low`、`medium`、`high`、`xhigh`、`max` 五档（CLI 侧还有 `ultracode` 与 `auto`）。这里有个容易踩的默认值差异：支持 effort 的模型通常默认 `high`，但 5.5 一代的 Opus、Sonnet、Haiku 默认是 `medium`，Opus 4.7 是 `xhigh`；给了模型不支持的档位，它会降级到"不超过请求值的最高可用档"，而不是报错。

thinking 的开关是 `Alt+T`（当次）与 `/config` 里的 thinking 项（写 `alwaysThinkingEnabled`）。值得注意的是新模型已经关不掉它：Opus 5.5、Sonnet 5.5、Haiku 5.5、Fable 一律走 adaptive reasoning，界面直接显示 `Thinking can't be turned off`，`MAX_THINKING_TOKENS=0` 与 `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` 对它们无效。官方还明确写了一句容易忽略的成本事实：thinking 的 token 即使被折叠或被 redact 也照常计费。

上下文窗口这边，1M 已经是新模型的默认档，`CLAUDE_CODE_DISABLE_1M_CONTEXT=1` 会把窗口锁回 200K。过载时用 `--fallback-model sonnet,haiku` 给一条降级链，去重后最多三个型号，且只对当轮生效。

### 2.5 对 mod-agent

四档任务模式（`ask`、`plan`、`edit`、`autopilot`，见 [overview.md §1.2](./overview.md)）与它的六模式不是一一对应，差别在它把"沙箱边界"和"要不要问人"拆成了两个轴，而我们目前把两件事压在模式档位上。`dontAsk`（会问的一律拒绝）这个档位我们没有对应物，它其实是无人值守场景里比 `bypassPermissions` 安全得多的默认选择，值得进 [security.md §3](./security.md) 的档位表。另外"某些动作对任何模式都免疫"这份清单必须写成代码里的常量而不是文档条款，[tools-and-extensions.md §5](./tools-and-extensions.md) 的审批表要照这个思路补一列 bypass-immune。

## 3. 让它记住你的项目

### 3.1 四级文件与拼接语义

`CLAUDE.md` 的查找顺序按官方表格是"从最广的作用域到最具体"：

| 级别           | 位置                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Managed policy | macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`；Linux 与 WSL `/etc/claude-code/CLAUDE.md`；Windows `C:\Program Files\ClaudeCode\CLAUDE.md` |
| User           | `~/.claude/CLAUDE.md`                                                                                                                                 |
| Project        | `./CLAUDE.md` 或 `./.claude/CLAUDE.md`                                                                                                                |
| Local          | `./CLAUDE.local.md`（官方建议加进 `.gitignore`）                                                                                                      |

关键语义有三条。第一，"All discovered files are **concatenated** into context rather than overriding each other"，从文件系统根往下拼，越靠近当前目录的越靠后。第二，祖先目录的文件在启动时全部加载，**子目录里的 `CLAUDE.md` 与 `CLAUDE.local.md` 是按需加载**，等它要读写那个目录下的文件时才进上下文。第三，真出现冲突时官方给的是"project-level instructions take priority"，但这是靠模型遵守的软优先，不是引擎层的覆盖。

managed 那一级单独说一句：它"cannot be excluded by individual settings"，个人设置无法把企业级规则文件排除掉。

### 3.2 `@import` 与一个反直觉的点

语法是 `@path/to/import`，三条规则容易记错：相对路径按**含 import 的那份文件**解析而不是按工作目录；可以递归导入，**最多四跳**；路径里带空格要在空格前补一个反斜杠转义，而一旦给路径加引号则完全不导入。反引号与围栏代码块里的 `@` 保持字面量，不会被当导入。

真正要记住的是这句原文：导入的文件"also load at launch"，并且"don't reduce its context cost"。拆文件是为了可维护性与就近生效，不是为了省上下文。想省，只有把内容移进按需加载的 path-scoped rule 或者 skill。工作目录之外的导入需要批准。

### 3.3 rules 目录与按路径生效

`.claude/rules/` 下递归发现 `.md`，可以分子目录。有没有 `paths:` frontmatter 决定了它的加载时机：没有的一启动就载，优先级与 `.claude/CLAUDE.md` 同级；有的则在读写命中该 glob 的文件时才进上下文（`cat`、`head` 这类算作读的 Bash 也会命中）。`paths` 有预算：**1,000 个展开后的 pattern、4 MiB**。用户级同样有 `~/.claude/rules/`。

### 3.4 体量、排除与审计

官方的建议值和硬上限是两个数：单个文件目标 **200 行以内**（"Longer files consume more context and reduce adherence"），加载硬上限是**整个文件 4 MiB**，超了就整份跳过。另一条配套建议是"When CLAUDE.md approaches 200 lines, start splitting into rules"。

排除用 `claudeMdExcludes`（glob 或绝对路径数组，各层合并，managed 那份排不掉）。企业也可以直接用 `claudeMd` 键把规则内容写进 managed settings，不落盘。想让 `--add-dir` 的目录也带上规则文件，要显式设 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`。

生成与查看：`/init` 生成起点，已存在时"suggests improvements rather than overwriting it"；`CLAUDE_CODE_NEW_INIT=1` 换成交互式多阶段流程（派子代理探索、给你可审阅的提案）。`/memory` 列出各作用域的文件清单（包括还不存在、创建后可用的那些）；但要确认这次会话到底加载了哪些，得看 `/context` 里的 Memory files 段。规则文件陈旧与自相矛盾可以用 `/doctor prompt-audit` 审。

官方点名不该写进去的三类：模糊指令（要写 `Use 2-space indentation` 而不是 `Format code properly`）、互相矛盾的指令、只在局部有用的多步流程（该移去 skill 或 path-scoped rule）。

### 3.5 auto memory：默认就开的自动记忆

这是较新的一层，和 `CLAUDE.md` 是两回事。它由 Claude 自己写，分类固定四种 `type`：`user`、`feedback`、`project`、`reference`。两条设计约束值得抄：它"skips anything it can derive from the codebase"，能自己看出来的不写；也不写 `CLAUDE.md` 里已有的内容。

状态是**本地会话默认开启**，self-hosted environment 的会话默认关。开关有三处：`/memory` 菜单、`autoMemoryEnabled` 配置、`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`。后台会话与被别的 Claude Code 实例启动的会话里开不了，官方给的话是"use a session started outside Claude Code"。

落盘在 `~/.claude/projects/<project>/memory/`：一份 `MEMORY.md` 索引加每记忆一个主题文件。`<project>` 从 git 仓库推导，所以同一个仓库的所有 worktree 共享同一份记忆。它是机器本地的，不跨设备同步。索引只取**前 200 行或 25KB，先到为准**；写超了，写入本身成功但会回一条错误要求重写索引。记忆文件被排除在 `cleanupPeriodDays` 的清理之外，不会因为日子久了被删。想换目录用 `autoMemoryDirectory`（要求绝对路径或 `~/` 开头）。

### 3.6 它怎么读 `AGENTS.md`

这一节直接关系到本仓库。支持从 v2.1.277 起，默认策略叫 `claude-md-or-agents-md`：**只有当工作目录及其上层都没有** `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md` 时，才去读 `AGENTS.md`。`~/.claude/CLAUDE.md`、managed 级 `CLAUDE.md` 和 `.claude/rules/` 不参与这个判断。

可选值四个：`claude-md-or-agents-md`（默认）、`claude-md-and-agents-md`（两份都读）、`claude-md`（只读自己的）、`managed-only`。设置入口是 `/config` 的 Project instructions，或者写配置键 `pluginConfigs."cc-plugin-agents-md@builtin".options.instructionFiles`（v2.1.285 之前这个插件 ID 叫 `agents-md@builtin`）。这个键只在 user、`--settings` 与 managed 三层生效，project 与 local 层写它会被忽略。

三条边界要说清：它不读 `AGENTS.local.md`、`AGENTS.override.md`，也不读 `.agents/` 目录；经设置读进来的 `AGENTS.md` **不会触发 `InstructionsLoaded` hook**；`--add-dir` 目录里的 `AGENTS.md` 不加载。想几家共用一份规则文件，官方给的方案是在 `CLAUDE.md` 里写 `@AGENTS.md`，或者 `ln -s AGENTS.md CLAUDE.md`，但 Windows 上不建议 symlink，因为 Edit 与 Write 拒写穿符号链接。

### 3.7 对 mod-agent

[context-engineering.md §2](./context-engineering.md) 的分层拼接与就近优先方向是对的，本文补三个它没定的细节：一是**子目录按需加载**（我们的规则文件目前是逐级预读到工作区根，大仓库会把预算花在没人碰的目录上）；二是"导入不省上下文"这条要在文档里显式写出来，否则用户一定拿拆文件当省钱手段；三是自动记忆与规则文件要分层，能推导的不写、已写的不重复，这一点对应 [data-and-events.md](./data-and-events.md) 的记忆表结构，建议把四类型常量与"索引硬上限 + 超限回报错误"抄进去。至于 `AGENTS.md` 的读取策略，我们已经在 [usage.md §6](./usage.md) 定了"没有 `CLAUDE.md` 时回退读 `AGENTS.md`"，与它的默认策略同构，但**必须一并写下边界**：回退只在工作目录及其上层判、不读 `.agents/` 那类旁支、经回退读入的文件是否要发加载事件得先定死。

## 4. 上下文、压缩与检查点

### 4.1 先看它去哪了：`/context`

先给工具再给原理，因为 `/context` 就是官方给的排查入口。它以彩色网格画出当前上下文占用，并按类别给 breakdown：哪几份 `CLAUDE.md` 与 rules 真的加载了、auto memory 占多少、每个 MCP 工具定义占多少 token（传 `all` 才展开明细，也才列 MCP 工具）、哪些工具是 context-heavy、容量告警。超出窗口时它还会输出超出量和"哪条命令能腾出空间"。

MCP 工具定义默认是**延迟加载**的，经 tool search 按需取，所以一个挂了十个 server 的项目不一定会在 `/context` 里看到十份 schema。

### 4.2 压缩阈值

不设 `autoCompactWindow` 时的行为按官方表述是"compacts when the conversation reaches the model's context limit"，也就是贴到窗口才压。几种例外要知道：没开扩展上下文的 Opus 4.6、Sonnet 4.6 在 **200K** 边界压；原生 1M 的模型会在窗口填满之前、约 **967K tokens** 处提前压；无法识别的 model ID 按假定窗口处理。

可配项有五条路径，优先级要记清：环境变量 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 最高（只接受纯 token 数），其次会话内 `/autocompact 500k`（v2.1.288 起按模型存进 `modelSettings`，更早是顶层 `autoCompactWindow`），再是 `--autocompact`、settings 的 `autoCompactWindow`（取值范围 **100000 到 1000000**，默认不设）、以及子代理 frontmatter 上单独给一份。命令与 flag 接受 `200000`、`500k`、`1M`，或者 100 到 1000 之间的裸数字（含义是千）。另有 `idleCompaction` 管"闲着也压"（v2.1.299 起），以及 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 按百分比调触发点。

一条边界值得抄进设计文档：如果某个超大文件或工具输出让上下文在压缩后立刻又满，它会**试几次之后停止自动压缩并报错**，而不是无限循环。官方对这个 thrashing 场景的处理是失败退出，不是硬撑。

### 4.3 压缩之后什么会回来

这件事对使用者的体感影响很大，对实现者则是必须逐条对齐的行为规格。

| 内容                                          | 压缩后                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| system prompt 与 output style                 | 仍然生效                                                                           |
| 项目根 `CLAUDE.md` 与无 `paths` 的 rules      | **从磁盘重注入**                                                                   |
| auto memory                                   | 从磁盘重注入                                                                       |
| git status 快照                               | 重读                                                                               |
| plan mode 写下的计划                          | 从磁盘重注入                                                                       |
| `paths:` 规则与子目录 `CLAUDE.md`             | 命中时按需重载                                                                     |
| 它读过或改过的文件                            | **最多重读 5 个**，最近修改优先；超 5,000 tokens 的只留一个 `Referenced file` 占位 |
| 已调用的 skill 正文                           | 重挂，单个上限 **5,000 tokens**、总预算 **25,000 tokens**，从最旧的开始丢          |
| 后台命令与子代理                              | 继续运行，并被提醒它们还在                                                         |
| hook 早前注入的上下文                         | **会被一起摘要掉**（不重放）                                                       |
| 匹配 `compact` source 的 `SessionStart` hooks | 重跑                                                                               |

最后一行值得停一下：hook 注入的内容不是一等公民，它会随摘要蒸发。想让某条规则活过压缩，就得放进规则文件而不是靠 hook 注入。

手工压缩两条路：`/compact <instructions>` 全量摘要，可以带引导语（如 `/compact focus on the API changes`）；局部压缩不在 `/compact` 里，而是走 `/rewind` 菜单的 Summarize from here 与 Summarize up to here。`/clear` 不是压缩，它是换一份全新空上下文（别名 `/reset`、`/new`），参数是给**旧**会话打标签，之后同进程内还能从 rewind 菜单里那条 previous session 找回。压缩保留哪些内容还可以在 `CLAUDE.md` 里写一段 "Compact Instructions" 来控制。

### 4.4 检查点：默认开着，但它不是 git

先纠正一个常见误解：checkpoint **默认开启**，"Claude Code automatically tracks Claude's file edits as you work"，每一个开启新 turn 的 prompt 都建一个检查点。保留**最近 100 个**检查点的文件快照，丢旧检查点时只删不再被引用的快照，但每个文件的**首次快照始终保留**（VS Code 扩展拿它当会话 diff 的基线）。快照在 `~/.claude/file-history/<session>/`，随会话保存，默认约**保 30 天**（`cleanupPeriodDays`，默认 30、最小 1、写 `0` 直接校验失败），过期后回退会报 `No files were restored`。

入口两个：`/rewind`（别名 `/checkpoint`、`/undo`）或空输入时按两次 `Esc`。菜单六项逐字照抄：**Restore code and conversation**、**Restore conversation**、**Restore code**、**Summarize from here**、**Summarize up to here**、**Never mind**。两个 code restore 只在你选的检查点上确有被跟踪的文件改动时才出现；Summarize 两项不动磁盘，方向键高亮后还能填一句引导语。

限制清单是这一节最该记住的部分：

- 只有 Claude 文件编辑工具的改动被跟踪。**Bash 改的文件不跟踪**，`rm`、`mv`、`cp` 撤不了。
- 子代理的编辑通常不恢复（只有前台 forked skill 会），官方的建议是"use git to revert them"。
- 工作目录外的手工改动、其它并发会话的改动不捕获。
- turn 中途插入的消息标 `No code restore`。
- symlink 与 hard-link 路径被跳过，会提示 `Restored the code, but skipped N files`。
- 数据库、API、部署这类远端副作用无法检查点。

官方对它的定位也是分离的："Checkpoints are separate from git"、"continue using version control"。它是会话级的快速回退，不是版本管理。

### 4.5 对 mod-agent

我们的上下文分层策略（[context-engineering.md §5](./context-engineering.md)）与压缩后存活清单，是两套必须同时存在的设计：一套决定"什么时候压"，一套决定"压完还剩什么"。建议把上面这张表原样吸收成 [context-engineering.md](./context-engineering.md) 的验收口径，特别是三个数值：重读最多 5 个文件、skill 正文 5,000 与 25,000 的双层配额、thrashing 时停手报错而不是继续压。影子快照那一段（[code-editing.md §3.1](./code-editing.md)）要修正一处默认值差异：我们让 `checkpoint` 默认关闭，而它默认开启，差别在于我们用 worktree 隔离、它用会话内快照兜底，这条要写进文档免得评审时被当成遗漏。至于"hook 注入会随摘要蒸发"，对应 [data-and-events.md](./data-and-events.md) 的事件溯源原则：外部注入内容应当是可重放的事件，而不是一段拼进历史的文本。

## 5. 权限与审批：规则怎么写、谁先判

### 5.1 规则的形状

规则写成 `Tool` 或 `Tool(specifier)`。能写进规则的工具名是这些：`Bash`、`PowerShell`、`Read`、`Edit`、`Write`、`NotebookEdit`、`Glob`、`MultiEdit`（legacy）、`WebFetch`、`WebSearch`、`mcp__<server>__<tool>`、`Agent`、`Cd`、`Skill`、`EndConversation`、`TaskStop`、`TaskOutput`。在 settings 里长这样：

```jsonc
{
  "permissions": {
    "allow": ["Bash(npm run *)", "Bash(git commit *)", "Read(**/src/**)"],
    "ask": ["Write(**/.env*)"],
    "deny": ["Bash(git push *)", "mcp__*", "Read( secrets/** )"],
    "additionalDirectories": ["../docs-shared"],
  },
}
```

（最后一行的括号内容示意路径，实际写 `Read(secrets/**)`。）

### 5.2 Bash 匹配：四个会咬人的细节

```text
Bash(npm run build)     精确匹配，不带参数命中，加 --watch 就不命中
Bash(npm run *)         前缀匹配
Bash(ls:*)  ==  Bash(ls *)   官方明确 :* 与尾部空格星号等价
Bash(ls*)   !=  Bash(ls *)   前者会命中 lsof，后者要求 ls 后必须是空格
```

复合命令按 `&&`、`||`、`;`、`|`、`|&`、`&` 与换行拆成子命令，**每个子命令单独匹配**：`Bash(git status *)` 放行不了 `git status && rm -rf /tmp/x`。还有一层 wrapper 剥离：`timeout`、`time`、`nice`、`nohup`、`stdbuf`、`command`、`builtin`、`noglob`、裸 `xargs` 与安全的环境变量赋值会被剥掉再匹配，但 `npx`、`docker exec`、`devbox run`、`direnv exec`、`mise exec` **不剥**，它们是另一层执行入口。

另有一类命令前缀规则永远放行不了，必须精确匹配：`watch`、`setsid`、`ionice`、`flock`，以及带 `-exec`、`-delete`、`-fprint`、`-files0-from` 的 `find`。

参数级匹配是较新的能力：`Bash(run_in_background:true)` 可以按工具入参匹配，不只是命令行字符串。

### 5.3 路径规则：四种锚点，两种深度

路径规则用 gitignore 语义，但锚点有四种，第一种最容易写错：

```text
//etc/passwd       文件系统绝对路径
~/secrets/**       相对 home
/src/gen/**        相对"含这条规则的 settings 文件所在目录"
docs/**, ./x.md    相对当前工作目录
.env               裸文件名等同 **/.env
```

深度语义按规则类型不同：作 `allow` 时 `Edit(src/**)` 只匹配 `<cwd>/src` 下的内容；作 `deny` 或 `ask` 时 `Read(secrets/**)` 匹配任意深度。也就是说**同一条 pattern 在放权和收权时不是同一个集合**，写 deny 时可以偷懒，写 allow 时不行。单段 `*` 不跨目录，`**` 跨。deny 与 ask 里 `!` 前缀是 gitignore 式的反向豁免。symlink 要请求路径与解析后路径都命中才 allow，deny 则任一命中即生效。

网络用 `WebFetch(domain:example.com)`；`WebFetch(domain:*.example.com)` 匹配子域但**不含** `example.com` 本身；`WebFetch(domain:*)` 全域。`WebSearch` 只有裸工具名一种写法。

### 5.4 判定顺序

顺序是 **deny、ask、allow**，第一个命中的结论生效，规则写得具体与否不参与排序。官方明确 "deny rules from any scope are evaluated before allow rules"，并且"If denied at any level, no other level can allow"。managed 层最高，CLI flag 与个人设置都翻不了 managed 的 deny。

这条是整套权限设计里最值钱的性质：放权可以跨层取并集，收权不需要协调。

### 5.5 审批框、持久化粒度与信任

弹出的框里四个选择，逐字是：`Yes`、`Yes, and don't ask again for: <规则>`、`Yes, and switch to auto mode`、`No`，页脚提示 `Esc to cancel and Tab to amend`（Tab 打开评论框，可以给这次批准或拒绝附一句话）。

三种动作的"不再询问"持久度并不一样，这是最容易被用户误读的地方：

| 工具     | "don't ask again" 的实际持久度                                                       |
| -------- | ------------------------------------------------------------------------------------ |
| Bash     | Permanently per repository and command（写盘）                                       |
| 文件修改 | Until session end，官方原话是"A file-modification approval isn't saved to the file." |
| WebFetch | Permanently per repository and domain                                                |
| 某些调用 | 只给一次性批准，压根没有"不再询问"选项                                               |

写盘的规则落在 **git 仓库根**的 `.claude/settings.local.json`，worktree 会归位到主检出（v2.1.211 起，之前写在你启动它的那个目录）。

目录信任是另一回事：在未信任目录启动会弹工作区信任框，但"trust acceptance is held for the current session only and is not written to disk"，而且**没有任何设置可以持久化它**，官方给的替代方案是"Start Claude Code from a project subdirectory instead"。

`bypassPermissions` 有几道额外约束值得全抄：以 `--restricted` 启动时被拒；Linux 与 macOS 下以 root 或 sudo 启动被拒（除非在已识别的沙箱内）；首次交互式启动有接受责任对话框；VS Code 与桌面端要各自开关；项目 settings 里写 `"defaultMode": "bypassPermissions"` 自 v2.1.257 起被忽略。管理员的 kill switch 是 `permissions.disableBypassPermissionsMode: "disable"`。

### 5.6 配置分层与那 245 个键

优先级从高到低：managed settings（文件、MDM、claude.ai 控制台）> `--settings` > `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json` > 内置默认。同一键取最高层的值。环境变量不在这条链上，它有自己的规则：`ANTHROPIC_MODEL` 压过任何文件里的 `model`，而 `ANTHROPIC_DEFAULT_MODEL` 只在没有文件设过 `model` 时生效。

managed 文件的落盘路径与 CLAUDE.md 同级目录一致，另有 `managed-settings.d/*.json` drop-in。多来源之间默认 `first-wins`，可选 `merge`（v2.1.242+）。生效时机分三种：文件类启动读取加变更热加载；MDM 与 HKCU 启动读取加每 30 分钟检查；server-managed 启动拉取加每小时轮询。有一条安全性很强的行为：**managed 文件解析失败时它拒绝启动**，而不是当作没有策略继续跑。

`settings-reference` 一共列了 245 个顶层键，其中约 20 个只能由 managed 层设置，包括 `allowManagedPermissionRulesOnly`、`allowManagedHooksOnly`、`allowManagedMcpServersOnly`、`blockedMarketplaces`、`strictKnownMarketplaces`、`strictPluginOnlyCustomization`、`requiredMinimumVersion`、`requiredMaximumVersion`、`allowedProviders`、`policyHelper`、`disableSideloadFlags`，以及 `sandbox.bwrapPath`、`sandbox.socatPath`、`sandbox.network.allowManagedDomainsOnly`、`sandbox.filesystem.allowManagedReadPathsOnly`。另有一小撮是例外：下层给"更严格"的值会被采纳，比如 `permissions.blockReadsOutsideWorkingDirectories`、`autoMode.classifyAllShell`、`maxEffortLevel`。

三个命名坑：键名是 `statusLine` 不是 `statusline`；`includeCoAuthoredBy` 已废弃，改用 `attribution`（含 `attribution.commit`、`attribution.pr`）；**顶层没有 `permissionMode` 这个键**，默认模式在 `permissions.defaultMode` 下。

### 5.7 对 mod-agent

三条直接可抄的。第一，[security.md §4](./security.md) 的合并语义写的是"allow 跨层取并集、deny 与 ask 优先且立即生效"，和它完全一致，这一条可以标注为业界实证并把"specificity 不参与排序"补进判定流程图，因为我们容易顺手写成"更具体的规则赢"，那是错的。第二，路径规则在 allow 与 deny 下深度语义不同这一点，要进 [code-editing.md](./code-editing.md) 的编辑安全校验规格，否则我们的白名单会在 allow 侧静默放宽。第三，"文件修改的一次性批准不落盘、Bash 的一次性批准落盘"这个不对称设计值得在 [usage.md §5](./usage.md) 的审批选项里说明理由：读多写少的命令模式化程度高可以安全记住，写文件的授权按会话收敛才对。至于 root 下拒绝 `bypassPermissions`、`--restricted` 下拒绝绕过、managed 解析失败即拒绝启动这三条，都是 fail-closed 的具体形态，建议进 [security.md §7](./security.md) 的验收清单。

## 6. 沙箱：拦得住什么、拦不住什么

### 6.1 三平台实现，以及 Windows 上那个坏消息

macOS 用**内置的 Seatbelt**，不需要装任何东西。Linux 与 WSL2 用 **bubblewrap**，文件系统隔离加独立 network namespace。三条限制要写在一起看：**WSL1 不支持**，官方给的选择是升级到 WSL2 或关掉沙箱；**原生 Windows 上沙箱根本不运行**，所有命令都是 unsandboxed；依赖缺失或平台不支持时，默认行为是**静默回退**到不隔离执行，除非你显式设 `sandbox.failIfUnavailable: true`。

Linux 前置：`sudo apt-get install bubblewrap socat`（或 dnf）。要阻断 Unix socket 还得装可选的 seccomp 层：`npm install -g @anthropic-ai/sandbox-runtime`，沙箱底层就是这个开源包。Ubuntu 24.04+ 如果 `sysctl kernel.apparmor_restrict_unprivileged_userns` 返回 `1`，要给 `/usr/bin/bwrap` 写一份 `/etc/apparmor.d/bwrap` 授 `userns` 再 `sudo systemctl reload apparmor`。

### 6.2 配置键与网络代理

`sandbox` 块约 30 个键，分成四组。

| 组       | 键与默认值                                                                                                                                                                                                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 行为     | `enabled`（`false`）、`autoAllowBashIfSandboxed`（`true`）、`allowUnsandboxedCommands`（`true`，设 `false` 即 strict mode）、`failIfUnavailable`（`false`）、`excludedCommands`（如 `["docker compose *"]`）、`ignoreViolations`、`enableWeakerNestedSandbox`、`enableWeakerNetworkIsolation`、`allowAppleEvents` |
| 文件系统 | `filesystem.allowWrite`、`denyWrite`、`denyRead`、`allowRead`、`disabled`（v2.1.216+）                                                                                                                                                                                                                            |
| 网络     | `network.allowedDomains`（初始为空）、`deniedDomains`、`strictAllowlist`、`allowLocalBinding`（`false`）、`allowUnixSockets`、`allowAllUnixSockets`、`allowMachLookup`、`httpProxyPort`、`socksProxyPort`、`tlsTerminate`（标注 experimental）                                                                    |
| 凭证     | `credentials.files`、`credentials.envVars`（`mode` 支持 `deny` 与 `mask`，mask 需 v2.1.221+）、`allowPlaintextInject`、`awsPairs`、`sigv4`                                                                                                                                                                        |

网络默认**不放开**：所有出站连接走本地代理，逐个 host 校验。未列出的域名按当前权限模式处理，`bypassPermissions` 直接放行，Manual、`acceptEdits`、plan 弹提示，`auto` 交给分类器，`dontAsk` 拒绝。有一条联动很实用：`WebFetch(domain:...)` 的 allow 规则会喂给沙箱的域名 allowlist，不用维护两份。域名通配支持前导 `*.` 与裸 `*`；不写端口等于放行该 host 全部端口；只解析到 loopback 或 link-local 的主机名会被代理拒绝（`localhost` 与 `*.localhost` 例外）。反过来要知道哪些工具不读代理环境变量，它们在沙箱里就是连不上：裸 `ssh`、多数数据库驱动、UDP、HTTP/3 与 QUIC、ICMP。

没有 `--sandbox` 这个 CLI flag，沙箱只能通过 settings 或 `--settings` 内联 JSON 打开。

### 6.3 拦不住清单

这份清单比清单本身重要，因为它划的是"隔离"这个词的真实边界。

| 不受沙箱约束                                                                | 原因                                                                                            |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 内置 `Read`、`Edit`、`Write`、`WebFetch`、`WebSearch`                       | 它们走权限规则，不经 Bash 沙箱                                                                  |
| hooks、本地 MCP server、插件 monitors、LSP、statusline 命令、`apiKeyHelper` | 全部在沙箱外执行                                                                                |
| 用户用 `!` 前缀敲的 shell mode 命令                                         | 多数会话下 unsandboxed                                                                          |
| 命中 `excludedCommands` 的命令                                              | 显式豁免                                                                                        |
| 沙箱失败后用 `dangerouslyDisableSandbox` 重试的命令                         | 需要人批，但批了就绕过                                                                          |
| 依赖缺失或不支持的平台（原生 Windows、WSL1）                                | 静默回退，除非 `failIfUnavailable: true`                                                        |
| `filesystem.disabled: true`、`allowAllUnixSockets: true`、自定义 proxy 端口 | 前者关掉文件系统隔离；中者可及 Docker socket，是逃逸面；后者会让 Claude Code 自己的网络管控失效 |
| computer use 与 mods                                                        | 设计上在沙箱外                                                                                  |

自查两行命令：`touch ~/sandbox-probe`（macOS 报 `Operation not permitted`、Linux 与 WSL2 报 `Read-only file system`）和 `curl --noproxy '*' https://example.com`（报 `Could not resolve host`）。面板是 `/sandbox`，标签依次是 Mode、Overrides（对应 `allowUnsandboxedCommands`）、Config，Linux 缺 seccomp 时多一个 Dependencies。v2.1.285 起，在以 admin 配置沙箱的环境下，如果高优先级配置覆盖了 `enabled`、`autoAllowBashIfSandboxed` 或 `allowUnsandboxedCommands`，`/sandbox` 会直接报错而不是静默生效。

### 6.4 对 mod-agent

我们的 Docker 加受限子进程降级方案（[security.md §3](./security.md)）面对的是同一个问题，但它的清单说明了一件我们还没写的事：**沙箱覆盖率必须显式声明**。建议在 [security.md](./security.md) 补一节"沙箱不覆盖清单"，把只读工具、扩展执行体、用户手敲命令三类列出来并给出各自的兜底机制（权限规则、信任 workspace、审批），否则读者会以为开了沙箱就等于全隔离。第二件事是 `failIfUnavailable` 默认 `false` 这个选择的后果，与我们"沙箱不可用即拒绝启动高风险任务"的默认取向相反，值得作为一条 ADR 反例写进 [architecture.md](./architecture.md) 的安全决策。第三件是域名 allowlist 与 `WebFetch` 权限规则共用一份数据源，这是消除配置漂移的低成本手段，建议进 [context-engineering.md](./context-engineering.md) 的出站控制。

## 7. Hooks：33 个事件与退出码契约

### 7.1 事件清单

hook 挂在 agent loop 的各个缝隙上。截至基线版本共 **33 个事件**，按官方分组是三类节奏：per session、per turn、per tool call。

| 节奏         | 事件                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话级       | `SessionStart`、`Setup`、`SessionEnd`、`ConfigChange`、`InstructionsLoaded`                                                                                          |
| turn 级      | `UserPromptSubmit`、`UserPromptExpansion`、`MessageDisplay`、`Stop`、`StopFailure`、`PreCompact`、`PostCompact`、`PreModelSwitch`、`PostModelSwitch`、`Notification` |
| 工具级       | `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PostToolBatch`、`PermissionRequest`、`PermissionDenied`、`Elicitation`、`ElicitationResult`                      |
| 子代理与团队 | `SubagentStart`、`SubagentStop`、`TaskCreated`、`TaskCompleted`、`TeammateIdle`                                                                                      |
| 工作区       | `CwdChanged`、`DirectoryAdded`、`FileChanged`、`WorktreeCreate`、`WorktreeRemove`                                                                                    |

两处要纠正：广泛流传的"5 个钩子"是早期清单，现在是三倍量；**`PreEdit` 从来不存在**，要拦编辑就写 `PreToolUse` 加 matcher `Edit|Write|NotebookEdit`。事件名的增加轨迹本身有信息量：压缩前后、模型切换前后、权限请求与拒绝、worktree 创建与移除、指令加载、队友空闲各自都有挂点，说明它是把"可观测性要求"直接翻译成了扩展点。

### 7.2 五种类型与配置形状

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "if": "Bash(rm *)",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh",
            "timeout": 10,
          },
        ],
      },
    ],
  },
}
```

`type` 有五种：`command`（字段 `command`、`args`、`async`、`asyncRewake`、`shell`、`onFailure`）、`http`（`url`、`headers`、`allowedEnvVars`）、`mcp_tool`（`server`、`tool`、`input`）、`prompt`（`prompt`、`model`）、`agent`（`prompt`、`model`，官方标 experimental）。公共字段 `type`（必填）、`if`、`timeout`、`statusMessage`、`once`。给 `args` 传一个数组会切到 exec form，不经 shell 直接 spawn（Windows 上必须是真 `.exe`）。`onFailure: "block"` 是 v2.1.295 加的。

配置可以出现在五个地方：`~/.claude/settings.json`、`.claude/settings.json`（可提交）、`.claude/settings.local.json`、插件的 `hooks/hooks.json`、managed policy settings。子代理 frontmatter 里也能挂（它的 `Stop` 会被自动转成 `SubagentStop`），项目级 frontmatter hooks 需要先信任该 workspace。

### 7.3 stdin 契约

hook 从 stdin 收到一个 JSON。公共字段：`session_id`、`prompt_id`、`transcript_path`、`cwd`、`scratchpad_dir`、`permission_mode`、`effort`（对象，含 `level`）、`hook_event_name`；在子代理上下文里另有 `agent_id`、`agent_type`；工具级事件再加 `tool_name`、`tool_input`、`tool_use_id`。

```json
{
  "session_id": "abc123",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/home/user/.claude/projects/.../transcript.jsonl",
  "cwd": "/home/user/my-project",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "npm test", "description": "Run test suite", "timeout": 120000 },
  "tool_use_id": "toolu_01ABC123..."
}
```

`SessionStart` 另带 `source`、`model`、`agent_type`、`session_title`，以及若干条件字段：`seconds_since_last_response`、`context_tokens`、`prompt_cache_likely_expired`、`estimated_cache_write_usd`。后四个是做成本治理的现成入口。

### 7.4 退出码：不是一刀切

| 退出码   | 含义                                                                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`      | 成功。stdout 里的 JSON 字段生效；普通 stdout 进 debug log，**例外**是 `UserPromptSubmit`、`UserPromptExpansion`、`SessionStart`、`PostModelSwitch`，这四个的 stdout 会进入上下文 |
| `2`      | 阻断。动作停下，理由取 stderr（有 JSON `reason` 时优先用它）                                                                                                                     |
| 其它非零 | 非阻断错误，动作继续，transcript 里留一条提示                                                                                                                                    |

关键在"能不能真阻断"按事件而定。可阻断：`PreToolUse`、`UserPromptSubmit`、`UserPromptExpansion`、`Stop`、`SubagentStop`、`TeammateIdle`、`TaskCreated`（回滚这次创建）、`TaskCompleted`、`ConfigChange`（`policy_settings` 来源除外）、`PostToolBatch`（停掉 agentic loop）、`PreCompact`、`PreModelSwitch`、`Elicitation`、`ElicitationResult`、`WorktreeCreate` 与 `WorktreeRemove`（**任何非零都算失败**）。不可阻断：`PermissionRequest`（要拒就得返回 `decision` 对象）、`PostToolUse` 与 `PostToolUseFailure`（stderr 展示给模型）、`PermissionDenied`（用 `retry: true`）、`Notification`、`SubagentStart`、`SessionStart`、`SessionEnd`、`CwdChanged`、`FileChanged`（stderr 只给人看）、`DirectoryAdded`（只进 debug log）、`Setup`、`PostCompact`、`PostModelSwitch`、`StopFailure`、`InstructionsLoaded`、`MessageDisplay`。

### 7.5 能改写什么

stdout 的 JSON 支持这些字段：通用 `continue`（默认 `true`）、`stopReason`、`suppressOutput`、`systemMessage`、`terminalSequence`（只接受 OSC 0/1/2/9/99/777 与 BEL）；顶层 `decision`（唯一合法值 `"block"`，省略即放行）与 `reason`；`hookSpecificOutput`（必须带 `hookEventName`）里按事件给：`permissionDecision`（`allow`、`deny`、`ask`、`defer`）、`permissionDecisionReason`、`updatedInput`、`additionalContext`、`updatedToolOutput`、`initialUserMessage`、`sessionTitle`、`watchPaths`、`reloadSkills`、`retry`、`action` 与 `content`、`displayContent`、`worktreePath`。

三个结论：hook **可以改工具入参**（`updatedInput`，PreToolUse 与 PermissionRequest）、**可以替换工具返回**（`updatedToolOutput`，PostToolUse）、**可以只改显示**（`displayContent`，MessageDisplay，模型看到的不变）。`UserPromptSubmit` 只能注入 `additionalContext`，不能替换用户输入。`defer` 会把这轮停成 `stop_reason: "tool_deferred"` 并带上 `deferred_tool_use`。

### 7.6 matcher、并发与上限

matcher 写法有两条隐藏规则：只含字母、数字、`_`、`-`、空格、`,`、`|` 时按**精确字符串**比较（`|` 或 `,` 分隔多个）；含其它字符时按**不锚定的 JS 正则**求值。所以 `Edit.*` 会同时命中 `Edit` 和 `NotebookEdit`，要写 `^Edit$`。MCP 工具写 `mcp__<server>__<tool>` 或 `mcp__memory__.*`；插件自带的 MCP 是 `mcp__plugin_<name>_<server>__<tool>`。`if` 用权限规则语法（`"Bash(git *)"`、`"Edit(*.ts)"`），但官方标注它是 best-effort，硬管控仍然要靠权限系统。

timeout 单位是秒：`command`、`http`、`mcp_tool` 默认 **600**，`prompt` **30**，`agent` **60**；按事件下调到 `UserPromptSubmit`、`PreModelSwitch`、`PostModelSwitch` 30 秒、`MessageDisplay` 10 秒、`SessionEnd` 全体共享 1.5 秒预算（单个 hook 可用自己的 `timeout` 抬，上限 60）。`async: true` 的 command hook 不执行 timeout；超时的 `PreToolUse` 默认不阻断。所有匹配的 hook **并行执行**，同一个 handler 在多个 settings 文件里重复定义只跑一次。

长度与优先级：`additionalContext`、`systemMessage`、`initialUserMessage` 和纯 stdout 的上限都是 **10,000 字符**；多个 `PreToolUse` 同时返回 `updatedInput` 时顺序不确定，官方说法是"the last one to finish takes effect"；hook 环境里没有 `/dev/tty`。hook 的 allow **不能**越过 settings 里的 deny 规则和网络路径提示，但 hook 的 deny 在 `bypassPermissions` 下依然生效。`disableAllHooks` 关不掉 managed hooks，`allowManagedHooksOnly` 会屏蔽 user、project、local 与 plugin 四类。

### 7.7 官方给了什么例子

仓库 `examples/hooks/` 里目前只有一个脚本 `bash_command_validator_example.py`：PreToolUse 校验器，按一张正则规则表检查 `tool_input.command`，stdin 不是合法 JSON 时 `exit 1`，命中违规时写 stderr 并 `exit 2`，还会给出替代建议（把 `grep` 换成 `Grep`、把 `find -name` 换成 `Glob`）。

指南页给的配方值得抄进我们的教程层：桌面通知（`osascript`、`notify-send`、PowerShell `MessageBox]::Show`）、`PostToolUse` 挂 `Edit|Write` 自动 `prettier --write`、拦截受保护文件（读 stdin 取 `file_path`、归一化反斜杠、命中 `.env` 或 `package-lock.json` 或 `.git/` 则 `exit 2`）、`ConfigChange` 用 `jq -c` 追加审计行、`SessionStart` 与 `CwdChanged` 里 `direnv export bash > "$CLAUDE_ENV_FILE"`、自动放行 `ExitPlanMode`。

调试四条路：`/hooks` 只读浏览器（会标出每个 hook 的来源，选 `All events` 能浏览还没配置的事件）、`Ctrl+O` 看 transcript、`claude --debug` 或 `--debug-file /tmp/claude.log`、以及最朴素的一条，手工 `echo '{...}' | ./my-hook.sh` 然后看 `$?`。有个坑官方专门提醒：shell profile 里的 echo 会污染 stdout 导致 JSON 解析失败，要把输出包进 `if [[ $- == *i* ]]`；脚本必须可执行。

### 7.8 对 mod-agent

[tools-and-extensions.md §4](./tools-and-extensions.md) 目前的钩子口径是"stdin 收事件 JSON、退出码 2 阻断、stderr 回喂模型"，这三条都对，但要补三件它没有的东西：第一，**逐事件的阻断能力表**，"退出码 2 能阻断"并不普适，PostToolUse 与 PermissionRequest 都有专门契约，我们的事件流设计不能笼统承诺；第二，**改写能力三元组**（入参、结果、显示层），尤其"只改显示不改模型输入"这一档，是审计与体验分离的关键设计；第三，**hook 的失败语义分层**（非阻断错误 vs 阻断 vs 超时），以及 managed 级 hook 不可被用户关掉。事件数量上，我们 MVP 不必一次实现 33 个，但事件命名应当预留 `PostToolBatch`、`PermissionRequest`、`InstructionsLoaded` 这三个位，理由见 [agent-loop.md §7](./agent-loop.md)。

## 8. 内置工具与它们的硬上限

### 8.1 工具清单

官方 `tools-reference` 列的工具名，逐字照抄（这也顺便回答了"Task 工具去哪了"：v2.1.63 起 Task 改名 `Agent`，`Task(...)` 在 settings 与 agent 定义里仍作别名可用；`TaskOutput` 已在 v2.1.277 移除）：

```text
Agent  Artifact  AskUserQuestion  Bash  CronCreate  CronDelete  CronList  Edit
EndConversation  EnterPlanMode  EnterWorktree  ExitPlanMode  ExitWorktree  Glob
Grep  LSP  ListAgents  ListMcpResourcesTool  Monitor  NotebookEdit  PowerShell
PushNotification  Read  ReadMcpResourceTool  RemoteTrigger  ReportFindings
ScheduleWakeup  SendFeedback  SendMessage  SendUserFile  ShareOnboardingGuide
Skill  SubagentHandback  TaskCreate  TaskGet  TaskList  TaskOutput  TaskUpdate
TodoWrite  ToolSearch  WaitForMcpServers  WebFetch  WebSearch  Write
```

五大类分组是 File operations、Search、Execution、Web、Code intelligence，其中代码智能那一类要靠插件（LSP）才有。`TodoWrite` 现在默认关闭，被 `TaskCreate`、`TaskGet`、`TaskList`、`TaskUpdate` 四个取代（`CLAUDE_CODE_ENABLE_TASKS=0` 可以退回旧行为）。

### 8.2 一个会让人困惑的默认值：Glob 与 Grep

在 macOS、Linux 与 WSL 上，**`Glob` 与 `Grep` 不在默认工具集里**，Claude 通过 Bash 跑内置版本来搜索：官方说法是那两个命令分别运行 embedded 的 `bfs` 与 `ugrep`。Windows 上 `Glob` 与 `Grep` 才属于默认集。

这条值得记，因为它解释了一个常见现象：同一个提问在 mac 上让它找文件，你会看到 Bash 调用；在 Windows 上会看到 Grep 调用。工具集是平台相关的。

### 8.3 数值上限汇总

| 对象          | 上限                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Read` 单次   | **25,000 tokens**；整读拒绝超过 **256 KB** 的文件（v2.1.296+ 可传 `allow_large: true`）                                                                                   |
| `Read` 读 PDF | 超过 10 页必须给 `pages`，每次最多 20 页                                                                                                                                  |
| `Glob` 结果   | 按修改时间排序，**截 100 个文件**；默认不遵循 `.gitignore`（`CLAUDE_CODE_GLOB_NO_IGNORE=false` 可改）                                                                     |
| `Grep`        | 基于 ripgrep 语法，遵循 `.gitignore`，默认 output mode `files_with_matches`                                                                                               |
| `Bash` 超时   | 默认 **2 分钟**（`BASH_DEFAULT_TIMEOUT_MS`），单次上限默认 **10 分钟**（`BASH_MAX_TIMEOUT_MS`）                                                                           |
| `Bash` 输出   | inline 约 30,000 字符、失败时约 10,000；`BASH_MAX_OUTPUT_LENGTH` 默认 30,000、硬顶 **150,000**；设置项 `bashOutputMaxChars` 上限 128,000；命令输出总量超 5 GB 直接被 kill |
| `WebSearch`   | 交互会话 **每会话 200 次**（`CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`）                                                                                                  |
| API 层        | `API_TIMEOUT_MS` 默认 600000；`CLAUDE_CODE_MAX_RETRIES` 默认 10（v2.1.186+ 上限 15）；未识别模型的 `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 默认 32000                             |

工具输出是 agent 产品最容易失控的成本项，这一整列数字本身就是一份现成的默认值评审清单。

## 9. 子代理、后台会话与团队

### 9.1 定义放在哪、谁压过谁

五个来源，优先级从高到低：managed settings 里的 `.claude/agents/`、`--agents` 这个 CLI flag（只作用当次、不落盘）、项目 `.claude/agents/`、用户 `~/.claude/agents/`、插件的 `agents/` 目录。同名取更高优先级；项目级会沿 cwd 到仓库根全部扫，嵌套目录里同名时**离 cwd 最近的赢**。

`.claude/agents/` 与 `~/.claude/agents/` 是递归扫描的，子目录不影响识别，身份只来自 frontmatter 的 `name`。插件的 `agents/` 不一样，子目录会进 scoped identifier：`agents/review/security.md` 变成 `my-plugin:review:security`。`--add-dir` 的目录也会加载它自己的 `.claude/agents/`。改文件几秒内生效不用重启，三种例外要重启：新建第一个 agents 目录、`--add-dir` 的目录、开了 `--disable-slash-commands` 的会话。

### 9.2 frontmatter 与工具继承

只有 `name` 和 `description` 必填，其余可选：`tools`、`disallowedTools`、`model`、`permissionMode`、`maxTurns`、`autoCompactWindow`、`skills`、`mcpServers`、`hooks`、`memory`、`background`、`omitClaudeMd`、`effort`、`isolation`、`color`、`initialPrompt`、`experimental`。字段名必须逐字（多词用 camelCase），不认识的字段**静默忽略不报错**，这个行为本身就是坑。

```markdown
---
name: code-reviewer
description: Reviews diffs for correctness and security. Use proactively after implementation.
tools: Read, Grep, Glob, Bash(git diff *)
model: inherit
effort: high
maxTurns: 20
memory: project
---

只读审查，不改文件。按 P0/P1/P2 输出，每条给文件与行号证据。
```

几处具体约束：`name` 不超过 256 字符且不能含 `:`（冒号保留给插件 scope）；`model` 可以是别名、完整 ID 或 `inherit`；`permissionMode` 六个值都能写；`memory` 取 `user`、`project`、`local`，分别落 `~/.claude/agent-memory/<name>/`、`.claude/agent-memory/<name>/`、`.claude/agent-memory-local/<name>/`，启用后自动注入其 `MEMORY.md` 的前 200 行或 25KB 并自动放开读写编辑；`isolation: worktree` 让它在临时 git worktree 里跑（默认从 default branch 分叉，没改动就自动清理）；`autoCompactWindow` 必须是**纯整数**，写 `200k` 会被读成 200；`omitClaudeMd: true` 需要 v2.1.271 以后。出于安全，**插件提供的子代理不支持 `hooks`、`mcpServers`、`permissionMode`**，写了会被忽略。

工具继承走两道过滤，这是全节最容易踩空的地方。子代理先继承主对话的内置与 MCP 工具，然后：

1. 从**所有**子代理移除：`Agent`（达到嵌套上限时）、`AskUserQuestion`、`EndConversation`、`EnterPlanMode`、`ExitPlanMode`（除非 `permissionMode: plan`）、`ScheduleWakeup`、`WaitForMcpServers`、`Workflow`。
2. 对**后台运行的**子代理（这是默认）再收紧到一份白名单：`Read`、`Grep`、`Glob`、`LSP`、`Bash`、`PowerShell`、`Edit`、`Write`、`NotebookEdit`、`WebFetch`、`WebSearch`、`TodoWrite`、`Skill`、`ToolSearch`、`EnterWorktree`、`ExitWorktree`、`Monitor`、`TaskStop`、`SendMessage`、`Artifact` 加 `SubagentHandback`，MCP 工具全留。

结果是同一份定义在前台和后台解析出的工具集不同。`tools` 是白名单、`disallowedTools` 是黑名单，两个都写时先应用黑名单再解析白名单，同时出现在两边的工具直接被移除。带 specifier 的条目（`tools: Bash(git push *)` 这种）**会移除整个工具**，要只禁部分命令得写进 `permissions.deny`。白名单一个都解析不出来时它会拒绝启动并报 `Agent would be spawned with zero tools`。

### 9.3 嵌套层数与并发上限

默认行为是"由默认，子代理可以再spawn自己的子代理，**最多到主对话下面三层**"。用 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 改，写进 settings 的 `env` 块，设 `1` 等于关掉嵌套。这段的历史很乱，网上三种说法都来自真实版本：v2.1.172 到 v2.1.216 默认五层且不可改，v2.1.217 到 v2.1.218 默认改成 1，v2.1.219 提到 3 并沿用。

并发默认 **20 个运行中**子代理，超了就报 `Concurrent subagent limit reached`，而且错误文案里明确告诉模型不要重试；改法是 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`（正整数），开了 ultracode 的会话豁免此限制。会话内累计 spawn 数没有上限。

### 9.4 上下文隔离与调用方式

非 fork 子代理的起始上下文只包含：它自己的 system prompt、环境细节（**不含 Claude Code 的完整 system prompt**）、Claude 写的 task message、`CLAUDE.md` 层级、git status 快照（Explore 与 Plan 跳过）、`skills` 字段预载的内容（前 32 个名字的全量正文）、以及同级清单。不继承 output style、不继承主对话的 auto memory、也不继承主对话的上下文窗口大小。官方一句话概括了为什么值得这么贵："the subagent does that work in its own context and returns only the summary"。

四种调用方式按强制性递增：隐式（模型按 `description` 语义自己委派，描述里写"use proactively"会鼓励它主动用）；显式自然语言（`Use the test-runner subagent to fix failing tests`）；**@-mention 保证执行**（`@"code-reviewer (agent)" look at the auth changes`，也可手打 `@agent-<name>`）；整会话运行（`claude --agent code-reviewer`，或 settings 里 `{"agent": "code-reviewer"}`，CLI flag 优先）。注意 @-mention 只决定调用谁，不决定它的 prompt；整会话模式下自定义 prompt 会**整体替换**默认 system prompt，但 `CLAUDE.md` 与项目记忆仍按正常消息流加载。

模型解析顺序（v2.1.251 起）是：本次调用参数、定义里的 `model`（`inherit` 表示跟主对话）、`CLAUDE_CODE_SUBAGENT_MODEL`、主对话模型。要把某个模型强加给**每一个**子代理（含内置 Explore 与 Plan），得再加 `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`。

内置子代理有六个，各有各的怪癖：`Explore`（只读，Write 与 Edit 被拒，可调 thoroughness 到 quick、medium、very thorough，订阅与网关环境下跑 `opus` 别名指向的型号）、`Plan`（plan mode 专用研究者，只读）、`general-purpose`（全工具，不带 `subagent_type` 的调用会 fallback 到它）、`claude`（catch-all，也是被派发到后台的会话的默认 agent）、`statusline-setup`（Sonnet，`/statusline` 时调用）、`claude-code-guide`（Haiku，回答关于 Claude Code 本身的问题）。关掉它们：`permissions.deny: ["Agent(Explore)"]` 关单个，deny 整个 `Agent` 关所有委派，`CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` 只移除 Explore 与 Plan。

两个安全细节值得单独记。子代理结果回到主对话前会被扫描，若模仿 `<system-reminder>`、`Human:`、`Assistant:` 这类指令形状，会被插入反斜杠破坏并加前缀 `[harness: subagent output matched instruction-shaped pattern(s):`。已完成子代理可以用 `SendMessage`（`to` 填 agent ID 或 name）带着全量历史续跑，但 **Explore 与 Plan 是 one-shot、不返回 ID，无法续跑**；`maxTurns` 截断的输出会被标 partial 并可继续。子代理 transcript 落 `~/.claude/projects/<project>/<sessionId>/subagents/agent-<agentId>.jsonl`，按 `cleanupPeriodDays`（默认 30 天）清理，主对话压缩不影响它。

### 9.5 后台会话与 supervisor

后台能力有两层，别混。第一层是 Bash 命令与子代理的后台化：`Ctrl+B` 把正在跑的东西摘到后台，`/tasks`（别名 `/bashes`）查看与管理（含已完成的子代理），`Ctrl+X Ctrl+K` 全停。后台 Bash 的输出写文件、有唯一 ID、**Claude Code 退出时自动清理**、输出超 5 GB 被终止；macOS 与 Linux 上内存压力加空闲 30 分钟会回收（`CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1` 关掉）。

第二层是会话级的 background agents，官方叫 **agent view**，标注 research preview。每条后台会话是一个**独立的 Claude Code 进程**，由一个 supervisor 托管，脱离终端继续跑。入口：`claude agents` 打开视图；`/background`（别名 `/bg`）把当前会话摘到后台并释放终端；`/fork [prompt]` 复制一份到后台而原会话继续；空输入时按 `←` 一步完成"后台化并打开视图"；脚本侧 `claude --bg "<task>"`（prompt 走 positional，且 `--bg` 与 `-p` 互斥会被拒）。

运维命令一组：`claude attach <id|name>`、`claude logs <id>`、`claude stop <id>`（别名 `kill`）、`claude respawn <id>` 或 `--all`、`claude rm <id>`、`claude purge`、`claude daemon status|logs|stop --any`、`claude agents --json [--all] [--cwd <path>]`。在 attach 进去的会话里 `/exit` 是 detach，`/stop` 才是停。

状态字段分三层：`state` 取 `working`、`blocked`、`done`、`failed`、`stopped`；`status` 取 `busy`、`waiting`、`idle`；`waitingFor` 说明卡在哪，取值 `permission prompt`、`input needed`、`sandbox request`、`worker request`、`dialog open`。落盘在 `~/.claude/jobs/<id>/state.json` 与 `tmp/`，但官方明确说这些文件**不是稳定接口**；supervisor 日志在 `~/.claude/daemon.log`，花名册在 `~/.claude/daemon/roster.json`。

回收策略要说清，因为它是成本问题的答案：working、卡在 prompt、或已 attach 的会话保留；**已完成或在等你下一条消息且未 attach 约 1 小时的会话会被停掉进程**（在视图里用 `Ctrl+T` pin 可以保活）；异常退出会重启，而你自己用 `←` 或 `/background` 结束的会标成 stopped 不重启；supervisor 被外部杀掉时，各会话进程等约 1 分钟重连。detach 时 in-flight 的工作会 carry over：后台 shell、后台子代理、dynamic workflows、`/loop` 定时任务、artifact 自动回复。想关掉：`disableAgentView: true` 或 `CLAUDE_CODE_DISABLE_AGENT_VIEW`。

### 9.6 Agent teams：实验特性，以及它的九条限制

开启方式是 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`（官方标注 experimental、默认关闭）。不设这个环境变量时，会话不会建团队、不写团队目录，模型也不会 spawn 或提议 teammate。

与子代理的差别不在"数量"而在拓扑：子代理的结果**回给调用者**、由主 agent 管全部工作、成本较低（只回摘要）；teammate 是 fully independent 的 Claude 实例，通过消息与共享任务清单 **self-coordinate**，成本明显更高。触发方式也粗：启用了 teams 之后，Claude 调用 Agent 工具并带上 `name` 就会起一个 teammate，**不征求确认**；`-p` 非交互模式下不 spawn teammate。

通信机制是 mailbox：每个成员一个 JSON 文件 `~/.claude/teams/<team-name>/inboxes/<agent-name>.json`，自动投递，**要发给所有人就得给每人各发一条**。读消息时逐条校验，不合规的报错并移出文件、合规的仍投递。团队配置在 `~/.claude/teams/<team-name>/config.json`，任务清单在 `~/.claude/tasks/<team-name>/`，团队名是 `session-` 加会话 ID 前 8 字符。会话结束时删掉 config 目录，任务清单留在本地、永不上传。显示模式 `teammateMode` 取 `in-process`（默认）、`auto`、`tmux`、`iterm2`。

限制清单（官方逐条给明）：in-process teammate **不随 `/resume` 与 `/rewind` 恢复**；一个会话一个团队；**不支持嵌套团队**；lead 固定不可换；in-process teammate 不能起后台子代理；任务状态同步有延迟；关闭流程可能很慢；分屏显示需要 tmux 或 iTerm2；**teams 不用 worktree 隔离 teammate**，文件分区得自己规划。权限上 teammate 继承 lead 的模式（`dontAsk` 除外）、prompt 出现在 lead 会话、spawn 时不能给单个 teammate 设权限模式、spawn 后 model 与 fast mode 固定。成本上还有一句要点：token 消耗"significantly more tokens"，随人数线性放大；in-process teammate 的 prompt cache 默认持 5 分钟（`subagentPromptCacheTtl` 可调 `1h`）。

### 9.7 五种并行形态的边界

| 形态                            | 谁调度               | 结果去哪               | 成员能否互发       | 规模                          |
| ------------------------------- | -------------------- | ---------------------- | ------------------ | ----------------------------- |
| Subagent                        | 主 agent 逐轮决定    | 摘要回调用者           | 否                 | 默认并发 20、嵌套 3 层        |
| Forked subagent（`/subtask`）   | 主 agent             | 结果回本会话           | 否                 | 继承全对话、共享 prompt cache |
| Background agents（agent view） | **你**派发、你检查   | 只向你汇报             | 否，会话间不通信   | 每会话一个进程                |
| Agent teams                     | lead agent 监督      | 共享任务清单           | **是**，走 mailbox | 一个会话一个团队              |
| Dynamic workflows               | **runtime 执行脚本** | 中间结果留在脚本变量里 | 由脚本决定         | 数十到数百                    |

### 9.8 对 mod-agent

我们的单 agent 闭环加受控子任务派生（[architecture.md](./architecture.md) 的设计原则第 1 条）与它的默认形态是同一个取向，本文补三条可直接落规格的细节。第一，**两道工具过滤**是我们完全没有的机制，[verification-and-multiagent.md §4](./verification-and-multiagent.md) 的只读契约应当区分前台与后台两套工具集，而不是一个 `readOnly: true` 布尔；第二，嵌套层数与并发上限要有默认值和可改路径两件套（我们目前只在文档里写"有上限"），并把它做成 settings 键而非编译期常量；第三，"子代理输出回主对话前扫描指令形状"是一条廉价但高价值的注入防线，建议进 [context-engineering.md §6](./context-engineering.md) 的注入防护清单，比只靠 prompt 提醒强一个量级。teams 与 agent view 都在 [agent-teams.md](./agent-teams.md) 与 [background-fleet.md](./background-fleet.md) 里有对应设计，可把上面那张边界表吸收进去当作划界依据。

## 10. 扩展体系：skills、plugins、mods、MCP

### 10.1 commands 已经并进 skills

官方原文是一句 "**Custom commands have been merged into skills.**"。放在 `.claude/commands/deploy.md` 与放在 `.claude/skills/deploy/SKILL.md` 都生成 `/deploy`，工作方式相同，老文件继续可用。差异只有三处：commands 目录里的文件不支持 `name` 与 `paths` 两个 frontmatter 字段；skill 额外支持附带文件目录、`disable-model-invocation` 与 `user-invocable` 的调用者控制、以及被模型按需加载；同名时 **skill 胜出**。内置命令也参与这层覆盖：你可以用自己的 skill 顶掉 `/usage`，但别名 `/cost` 仍然走内置实现。

模板语法两种写法都还有效：`$ARGUMENTS`、`$ARGUMENTS[N]`、`$N`（**0 基**）、以及在 `arguments` 里声明后用 `$name`；变量替换 `${CLAUDE_SESSION_ID}`、`${CLAUDE_EFFORT}`、`${CLAUDE_SKILL_DIR}`、`${CLAUDE_PROJECT_DIR}`、`${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}`。`` !`cmd` `` 与带 `!` 标记的围栏代码块做动态注入，`shell: bash|powershell` 选执行器，**注入命令失败会整体中止这次调用**，deny 与 ask 规则可以打断它，`disableSkillShellExecution: true` 全部关掉。`@` 引用会附加文件，`\$1.00` 转义位置参数。一条消息可以堆叠多个 skill，最多"首个加五条"。

### 10.2 skills 的三层加载与那份预算表

frontmatter 字段全集（全部可选，官方只把 `description` 标为 Recommended）：`name`、`description`、`when_to_use`、`argument-hint`、`arguments`、`disable-model-invocation`、`user-invocable`、`allowed-tools`、`disallowed-tools`、`model`、`effort`、`context`、`agent`、`background`、`hooks`、`paths`、`shell`、`metadata`、`license`、`compatibility`。没有 `version` 字段；`license` 与 `compatibility` 来自 Agent Skills 规范，Claude Code 接受但不据此行事；布尔值 v2.1.218 起还接受 `yes`、`no`、`on`、`off`、`1`、`0`。

三层渐进披露是它省上下文的机制，也是理解成本的关键：

| 层  | 进上下文的内容                                     | 时机                                                 |
| --- | -------------------------------------------------- | ---------------------------------------------------- |
| 1   | 只有 `name` 与 `description`                       | 会话启动即载入，**每个请求都在**                     |
| 2   | 渲染后的 `SKILL.md` 全文                           | 被调用时作为一条消息进入，并跨轮常驻（不再回读文件） |
| 3   | 附带文件（`reference.md`、`scripts/helper.py` 等） | 模型按需 `Read`                                      |

第 1 层有预算，两个数：单条 `description` 与 `when_to_use` 合并后**截断到 1,536 字符**（`skilllistingmaxdescchars` 可改），listing 总预算是**模型上下文窗口的 1%**（`skillListingBudgetFraction` 或 `SLASH_COMMAND_TOOL_CHAR_BUDGET`），超预算时从最少调用的 skill 开始丢描述。这条设计说明了一件事：装了很多 skill 之后，最先劣化的是"模型还认不认识它们"，而不是磁盘占用。正文建议控制在 500 行以内，这是 Tip 不是硬限。

调用控制三个字段一组：`disable-model-invocation: true` 表示只能人敲（连描述都不进上下文）；`user-invocable: false` 表示不出现在 `/` 菜单但模型可以调；`paths` 用 glob 限定生效范围。权限侧用 `Skill(name)` 或 `Skill(name *)` 控制可调范围，deny 整个 `Skill` 就全关。settings 侧还有一个 `skillOverrides`，取 `on`、`name-only`、`user-invocable-only`、`off`，对插件提供的 skill 无效。

位置与命名：Enterprise（managed 目录）优先于 Personal（`~/.claude/skills/`）优先于 Project（`.claude/skills/`）；嵌套目录 `<subdir>/.claude/skills/` 在首次触及该目录文件时加载，重名时两者都可用（`/deploy` 走根、`/apps/web:deploy` 走嵌套）；插件 skill 走命名空间 `/plugin-name:skill-name`，`name` 只替换最后一段；claude.ai 同步下来的落在 `~/.claude/skills/synced/`，全名 `/anthropic-skills:<name>`，`synced` 与 `anthropic-skills` 是保留名。热重载监听 personal、project 与 `--add-dir` 三处（bare mode 除外），**新建顶层 skills 目录必须 `/reload-skills`**；正文改动即时生效，但 `hooks/`、`.mcp.json`、`agents/`、`output-styles/` 要 `/reload-plugins`。`/skill-doctor`（v2.1.252+）告诉你每个 skill 的上下文成本与调用频次。

`context: fork` 是个容易误解的字段：它会启一个 `agent` 类型（默认 `general-purpose`）的子代理来跑这个 skill，**不带会话历史**，不是"fork 当前对话"。默认后台跑（`background` 默认 `true`），`background: false` 才在本次 turn 内等；`-p`、SDK 与 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` 下总是等。fork 型 skill 必须有可执行指令，纯规范文本会空转。

### 10.3 plugins 与 marketplace

一个插件的组件目录约定：`skills/`、`commands/`、`agents/`、`hooks/hooks.json`、`.mcp.json`、`.lsp.json`、`bin/`（会加进 Bash 工具的 PATH）、根级 `settings.json`（作为默认设置）、`output-styles/`、`workflows/`、`themes/`、`monitors/monitors.json`、channels、以及 mod（`hooks/` 里的 JS 模块）。

清单文件 `.claude-plugin/plugin.json` 只有 `name` 必填（kebab-case，含空格、`@`、`:` 或路径分隔符即非法）。覆写字段的语义不统一，这是最容易写错的地方：`skills` 是**追加**到默认扫描，`commands`、`agents`、`outputStyles`、`workflows`、`themes` 是**替换**默认扫描，`hooks`、`mcpServers`、`lspServers` 是与默认文件**合并加载**。未知顶层键被剥离并给 warning，但 `userConfig`、`channels`、`lspServers`、`monitors` 内部键是 strict，写错就不加载。

marketplace 是分发单位：`.claude-plugin/marketplace.json` 必填 `name`、`owner{name}`、`plugins`。插件条目的 `source` 有七种形态：仓库内相对路径字符串、`github{repo,ref,sha}`、任意 git `url{...}`、`git-subdir{url,path,ref,sha}`、`npm{package,version,registry}`、`archive{url,sha256}`（v2.1.224+）、`command{command,timeout,mode}`（v2.1.229+）。CLI 侧 `claude plugin` 有 `init`（别名 `new`，脚手架到 `~/.claude/skills/<name>/`）、`install`、`uninstall`、`enable`、`disable`、`update`、`list`、`details`（**没有 `info`**）、`configure`、`prune`、`eval`、`tag`、`test`、`validate`，另有 `claude plugin marketplace add|list|update|remove`。会话内对应 `/plugin` 的子命令，`/reload-plugins [--force]` 应用挂起变更（改动了 MCP 工具集必须加 `--force`，否则为保护 prompt cache 会拒绝）。单次会话临时加载用 `--plugin-dir` 或 `--plugin-url`，显示为 `<name>@inline`。

安全模型这一节要说准：**没有代码签名机制**。官方对风险的自述是插件可以以你的用户权限执行任意代码；所谓官方与社区 tier 只靠"保留 marketplace 名加源必须来自 `github.com/anthropics/`"来保证，否则报 `Marketplace is registered from an untrusted source`；唯一的完整性校验是 `archive` 源的 `sha256` 不匹配即拒装。私有市场的鉴权靠 `headers`（静态）或 `headersHelper`（跑命令输出 JSON，要求该条目 `strict: false`）。审计入口是 `claude plugin details` 打出的 Component inventory。

`anthropics/claude-code` 仓库本身就是一个 marketplace（`claude-code-plugins`），`plugins/` 下收了 13 个：`agent-sdk-dev`、`claude-opus-4-5-migration`、`code-review`、`commit-commands`、`explanatory-output-style`、`feature-dev`、`frontend-design`、`hookify`、`learning-output-style`、`plugin-dev`、`pr-review-toolkit`、`ralph-wiggum`、`security-guidance`。仓库自己 `.claude/commands/` 里有三个自用命令：`commit-push-pr.md`、`dedupe.md`、`triage-issue.md`。

### 10.4 mods：函数级的扩展点

这是本文里最该被自研产品读进去的一层。官方定义："A mod is a Claude Code plugin whose behaviour lives in a hooks module: one `register(on, options)` entry that hooks the engine's events as functions `($, e, next)`. These four ship inside Claude Code; this folder is their source, published as it is built into the binary."

翻译一下差别：plugin 是声明式打包（命令、agent、skill、hook 配置、MCP server），mod 是**用 TypeScript 函数挂钩引擎事件**，能改写别的扩展点向模型呈现的内容。它随二进制内置发行，源码在公开仓库的 `mods/` 下（1,375 个文件，占仓库文件数的大头）。

结构三件套：`.claude-plugin/plugin.json`（必填，无新增字段）、`hooks/hooks.json`（`{"modules":["./register.js"]}`）、hooks module（ESM，`.js` 到 `.tsx` 八种扩展名）。核心签名：

```ts
export function register(on, options) {
  on("tool.call", "Bash", async ($, e, next) => {
    e.tool_input.command = sanitize(e.tool_input.command)
    return next(e)
  })
}
```

`$` 是 mods API，`e` 是**深度冻结**的事件输入，`next(e)` 是中间件式继续。事件点约七十个，按组列：`tool.call`、`tool.check`、`tool.describe`；`prompt.submit`、`prompt.fill`、`prompt.suggest`、`prompt.edit`、`prompt.autocomplete`、`prompt.compose`、`prompt.section`、`prompt.context`、`prompt.attachment`、`prompt.mention`、`skill.prompt`、`attribution.text`；`command.run`、`command.describe`、`config.set`、`config.describe`；`turn.start`、`turn.step`（async generator，可改 `model` 与 `effort`）、`turn.complete`；`session.start`、`session.end`、`session.compact`、`session.receive`、`session.send`、`session.append`、`session.attach`、`session.detach`、`session.measure`；`agent.offer`、`agent.spawn`；`ui.render`、`ui.resolve`、`ui.press`、`ui.input`、`ui.select`、`ui.focus`、`ui.scroll`、`ui.close`、`ui.message`、`ui.fault`；`plugin.register`（可返回 `{refuse}`）、`engine.create`；`telemetry.log`、`telemetry.mark`；以及 `classic.<Event>`（如 `classic.Stop`）把 settings 型 hook 事件也接进来。另一个巧思是**每个 API 方法同时是同名事件**，`fs.read`、`model.complete`、`ui.open` 既能调也能拦。

API 命名空间：`$.plugin`、`$.ui`（含 `resolve`、`open`、`close`、`panes`、`toast`、`status`、`notice`、`ask`、`copy`、`selection` 等）、`$.command`、`$.tool`、`$.agent`、`$.model`（`complete`、`fork`、`classify`）、`$.prompt`、`$.turn.abort`、`$.session`、`$.config`、`$.settings.read`、`$.env`、`$.fs`、`$.store`、`$.state`、`$.clock`、`$.http.fetch`、`$.process`、`$.mcp`、`$.audio`、`$.telemetry`。资源限制照抄：单个 hook 自身执行 10 秒（`prompt.edit` 只有 50ms）、`.catch` 1 秒、`$.model.complete.maxTokens` 默认 1024 上限 64000、`$.fs` 单文件 4 MiB、`$.http` 请求与响应体 4 MiB、`$.process.run` 默认 30 秒最长 10 分钟。

开发闭环给得挺完整：`claude --plugin-dir ./first-mod` 会话级加载并 watch 热重载（每次重载重跑 `register`，所以模块内变量会归零，这个坑官方提示了）；`claude -p "/tally" --plugin-dir ./first-mod` 非交互验证；`claude plugin test [dir]` 跑 `.test.ts`，从 `claude-code/testing` 导入 `{expect, test}`，test 回调拿 `($, on)`，**不需要 session、登录或网络**，失败退 1；`claude plugin eval [target]`（v2.1.269+）在只装目标插件的隔离会话里多次跑评测 case，默认还会再跑一遍"无插件"基线做对照（`--ablation with-without`）。

四个内建 mod 各是一类示范：`diff` 接管 `/diff` 并自己绘制面板；`agents-md` 负责读取 `AGENTS.md`（§3.6 那个策略就是它）；`sec-default` 是守护组织配置不被用户 mod 绕过的策略 mod，最先加载、managed 与 deny 规则优先、用户关不掉；`telemetry` 给其它 mod 提供上报方法并随附类型。现状上 mods 已**没有功能门禁**（v2.1.287 起默认开启，早期的 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` 现在被忽略，设 `0` 也关不掉），要关得走 `/plugin` disable、整会话 `--safe-mode`、或 `disableAllHooks`。

### 10.5 MCP

添加与查看。三种 scope 的落盘位置不一样，值得记：`local`（默认）写 `~/.claude.json` 里该项目路径下的 `mcpServers`、`user` 写 `~/.claude.json` 顶层 `mcpServers`、`project` 写项目根 `.mcp.json`。

```text
claude mcp add --transport http  api-server https://api.example.com/mcp
claude mcp add --transport sse   sse-server https://sse.example.com/sse
claude mcp add --env KEY=value -- <name> -- <command> [args...]     # stdio：-- 之后才是服务器命令
claude mcp list        # ✔ Connected / ! Needs authentication / ✘ Failed / ⏸ Pending approval / ⊘ Disabled
claude mcp get|remove|add-json|add-from-claude-desktop|reset-project-choices|login|logout|serve
```

`--transport` 只接受 `stdio`、`http`、`sse`，**`ws` 不在其中**，要写进 `.mcp.json` 或用 `add-json`。`.mcp.json` 顶层固定 `mcpServers`，stdio 用 `command`、`args`、`env`，远端用 `url`、`headers`、`headersHelper`、`timeout`、`alwaysLoad`；`type` 取 `stdio|http|sse|ws`，`streamable-http` 是 `http` 的别名；**写了 `url` 却没写 `type` 会被当 stdio 跳过并告警**。`${VAR}` 与 `${VAR:-default}` 可以展开，但有一组"凭据名"在远端 `url` 与 `headers` 里会被读成空且不套用默认值：`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`AWS_BEARER_TOKEN_BEDROCK`、`HTTPS_PROXY`、`NPM_TOKEN`。stdio 子进程会拿到 `CLAUDE_PROJECT_DIR`（不回传给 Claude Code 自身）。停 stdio 服务器的信号序列是 `SIGINT`、100ms、`SIGTERM`、400ms、`SIGKILL`。

认证上，`401` 与 `403` 判定为需要认证，OAuth 走自动发现加 DCR 或 CIMD，`/mcp` 菜单里完成浏览器授权或 `claude mcp login`；token 自动刷新、失败时重连并重试一次。不想用 OAuth 就写静态 `headers`，或者 `headersHelper`（命令输出 JSON，10 秒超时，每次连接与每次 401/403 后重跑，覆盖同名静态头）。注意 `apiKeyHelper` 是给 Claude Code 自己产生凭据的，不用于 MCP。

命名与限制：工具全名 `mcp__<server>__<tool>`，**超过 128 字符的工具直接不发给模型**；权限里可写 `mcp__plugin_<plugin>_<server>__*`；资源引用 `@server:protocol://path`（如 `@github:issue://123`），MCP Apps 的 `ui://` 资源不进 `@` 列表；MCP prompts 映射成斜杠命令。输出侧，`MAX_MCP_OUTPUT_TOKENS` 默认 **25000**，超过 10,000 token 就告警；没有 `anthropic/maxResultSizeChars` 注解的文本结果**超过 50,000 字符直接落盘**、上下文里换成文件路径（该注解本身上限 500,000）；错误文本超过约 11,000 字符时截成头 5,000 加尾 5,000；HTTP 与 SSE 单响应超 16 MiB 读失败、WS 单消息超 16 MiB 断连。工具描述截断是 **4,096 字符**（v2.1.296 之前是 2,048），经 tool search 加载的描述是 16,384，`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`（v2.1.280+）统一替换这两个值。超时一栈：`MCP_TIMEOUT` 默认 30000ms（单服务器连接）、`MCP_TOOL_TIMEOUT` 默认 100000000ms（约 28 小时，但 HTTP、SSE 与 connector 另有 60s 每请求上限）、`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` 网络传输 300000ms、stdio 1800000ms。长 MCP 调用超过 2 分钟会自动转成后台任务。

加载策略是懒的：tool search 默认开，启动只载入工具名与 server instructions，schema 按需取；因此 `WaitForMcpServers` 这个工具只在**没有 tool search 的配置**下才被用到（自定义 `ANTHROPIC_BASE_URL`、`ENABLE_TOOL_SEARCH=false`、4.5 代之前的模型、Azure 托管 Foundry）。`_meta["anthropic/alwaysLoad"]=true` 可以强制预载。企业侧一整套闸门：`managedMcpServers`（优先级最高）、独立文件 `managed-mcp.json`、`allowedMcpServers` 与 `deniedMcpServers`（deny 优先，内置与 `type:"sdk"` 豁免 allow）、`allowManagedMcpServersOnly`、`strictMcpConfig`。有一条安全行为要单记：`.mcp.json` 里的服务器需要交互式批准，而在**未信任工作区里**，仓库自带的批准配置（`enableAllProjectMcpServers`、提交进 `.claude/settings.json` 的 `enabledMcpjsonServers`）会被忽略（v2.1.207 起）。

### 10.6 扩展点全景对照

| 扩展点              | 载体          | 进不进上下文                               | 触发方式                               | 能否改写别的扩展                                                                                               |
| ------------------- | ------------- | ------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md` / rules | Markdown      | 全文，每请求                               | 自动                                   | 否                                                                                                             |
| Output styles       | Markdown      | 当前样式全文（Default 为 0）               | `/config`、`/output-style`             | 否                                                                                                             |
| Skills / commands   | `SKILL.md`    | 启动进 name 与 description，调用进全文     | `/name` 或模型按描述匹配，`paths` 限定 | 否                                                                                                             |
| Subagents           | `agents/*.md` | 不在主上下文，独立窗口                     | 模型委派或 `@agent-name`               | 否                                                                                                             |
| MCP 工具            | `.mcp.json`   | 默认只工具名与 instructions，schema 懒取   | 模型调 `mcp__s__t`                     | 否                                                                                                             |
| settings 型 hooks   | JSON          | 不进上下文（除非返回 `additionalContext`） | 生命周期事件                           | 否                                                                                                             |
| Plugins             | 目录包        | 本身不是扩展点，是打包与分发单位           | `/plugin`                              | 否                                                                                                             |
| **Mods**            | JS 模块       | 不进上下文                                 | 事件驱动                               | **能**：可改 `prompt.section`、`skill.prompt`、`tool.describe`、`command.describe`，也能自己注册新命令与新工具 |
| Workflows           | `.js`         | 主上下文只收最终结果                       | 模型调 `Workflow` 工具或 `/name`       | 编排子代理                                                                                                     |

### 10.7 对 mod-agent

[tools-and-extensions.md §6](./tools-and-extensions.md) 已经定了"用 Markdown 加目录约定降低扩展门槛"，方向与 skills 一致，但要看清它为什么在此之上又加了 mods：**声明式扩展能被审计、能被策略管控，但它改不动引擎怎么想**。当你需要"给所有工具调用注入统一校验"或者"改写系统提示的某一节"时，frontmatter 那一层是够不着的。mod-agent 侧的完整设计已经落到 [tools-and-extensions.md §7](./tools-and-extensions.md)：§7.1 Plugin 声明式打包（三种覆写语义 + `mod plugin details` 审计入口 + 无代码签名的四件兜底）、§7.2 Mods 函数级扩展点（`register(on, options)` + `($, e, next)` + 事件分组 + "每个 API 方法同时是同名事件"）、§7.3 两层的信任分级（mods 不受 `disableAllHooks` 影响 + 策略 mod 用户关不掉）。Phase 归属：Plugin 在 Phase 4、远程 marketplace 在 Phase 5、Mods 与策略 mod 在 Phase 6+，见 [roadmap.md](./roadmap.md) 对应段。第二件事是那份预算表：我们的 skill 或工具描述清单也要有"总量随安装数线性膨胀"的问题，1% 窗口预算加"从最少调用的开始丢"是个可落地的策略，已经落到 [tools-and-extensions.md §6.2](./tools-and-extensions.md)。第三是 MCP 工具名 128 字符上限与"超长直接不发模型"这类**静默失败**，我们的工具注册必须有显式的命名长度校验并给出报错而不是静默丢弃，已经落到 [tools-and-extensions.md §1.1](./tools-and-extensions.md)。

## 11. 编排：workflows 与代码审查

### 11.1 workflow 是模型现写的脚本

先中肯地说清它是什么：dynamic workflow 是**一段 Claude 现写的 JavaScript**。官方表述："Claude writes the script for the task you describe, and a runtime executes it in the background while your session stays responsive."。脚本负责编排子代理，中间结果留在脚本变量里，主对话只收最终答案。文件不是人手写的，但可以保存下来再改；`/workflows` 面板里按 `s` 就能把一次运行存成命令。

开关与键：`enableWorkflows`（`/config` 的 Dynamic workflows 项写进 user settings，取消时删除该键；**默认不设等于除 Pro 外全开，Pro 默认关**）、`disableWorkflows`（供 managed 全组织关闭）、`CLAUDE_CODE_DISABLE_WORKFLOWS=1`。关掉之后 `/workflows`、workflow 命令、`/workflow-authoring` skill 与 `ultracode` 关键词全部失效。`workflowSizeGuideline` 取 `unrestricted|small|medium|large`（默认 `medium`，Pro 且 v2.1.271 之后默认 `small`）。

文件在 `.claude/workflows/*.js`（项目）与 `~/.claude/workflows/*.js`（个人），monorepo 里沿路径每个目录都加载、就近优先、项目压过个人；插件的放插件根 `workflows/`，命名 `/plugin-name:meta.name`。入口约定是硬性的，值得逐条抄：

```js
export const meta = { name: "audit-deps", description: "Audit deps across workspaces" }
// ↑ 必须是首条语句、必须是纯字面量对象；含变量、函数调用或 spread 会让 /audit-deps 从补全里消失

export default async function () {
  const pkgs = await agent("列出所有 workspace 包名", { schema: PKG_SCHEMA })
  const rows = await parallel(
    pkgs.items.map((p) => () => agent(`检查 ${p} 的过期依赖与许可证冲突`)),
  )
  return rows.filter(Boolean) // agent() 被停或遇到不可恢复错误时 resolve 为 null
}
```

body 支持顶层 `await`，**禁止 `import()`**，并且 `Date.now()`、`Math.random()`、无参 `new Date()` 会直接抛错。这三条限制只有一个理由：可重放。编排脚本要能被恢复，就不能依赖墙钟和随机数。

API 一共五个：`agent(prompt, opts)` 派生一个子代理、`pipeline(items, fn)` 对列表逐项跑、`parallel()` 同时跑一组并等全部完成、`phase(title)` 分组、`log()`，外加全局 `args`。结构化返回走 `agent(prompt, { schema })`：启动前先校验 schema，如果 schema 本身自相矛盾（比如 `required` 的键被 `additionalProperties: false` 排除）就报错不启动；连续 5 次校验失败该调用才失败，次数由 `MAX_STRUCTURED_OUTPUT_RETRIES` 控。

### 11.2 四道上限与恢复语义

| 维度                             | 上限                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 并发 agent                       | 默认 **16**（CPU 受限会更少），`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` 取 1 到 256                                              |
| 单次 `parallel()` / `pipeline()` | **4096 items**，超出直接报错，不静默截断                                                                                             |
| 单次运行 agent 总数              | **1000**                                                                                                                             |
| stall 重试                       | 5 次，第 6 次报 `agent stalled on all 6 attempts`；单个可用 `agent(prompt, { stallMs })`，全局 `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` |

还有几处软性设定：fan-out 的前缀缓存错峰 `CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS` 默认 5000；workflow agent 的 prompt cache 默认 5 分钟（`subagentPromptCacheTtl: "1h"` 可延长）；`Large workflow` 警告在超过 25 个 agent 或预计超过 150 万 token 时出现，只提示不拦截；子代理失败时 `pipeline()` 保留 `null`，所以官方示例都以 `.filter(Boolean)` 收尾。

`Workflow` 工具的入参是 `{ script?, name?, scriptPath?, args?, resumeFromRunId?, title?, description? }`，三者至少给一个，`scriptPath` 优先且要求会话里有 `Read`，`title` 与 `description` 会被忽略。输出里有一个耐人寻味的行为：**语法检查失败仍然返回 `status: "async_launched"`，只是带一个 `error` 字段**。恢复语义按 agent 启动顺序重放：已完成的返回缓存结果、被停时仍在跑的重新开始、失败的那个以及**它之后的所有 agent** 全部重跑（所以改顺序会引发额外重算）。同会话内可续，离开会话要靠 agent view 或 cloud session 保住结果，新会话只能重开；找不到旧结果时报 `nothing to resume`。用量到顶时（v2.1.271 起，需交互、订阅、开了 `autoContinueAtUsageLimit`、24 小时内会重置、且已等待不足两次）整个 run 是**暂停**而不是失败。

`/workflows` 面板的键位：`↑↓` 选择、`Enter` 或 `→` 下钻、`Esc` 或 `←` 返回、`j` 与 `k` 滚动、`f` 按状态过滤、`p` 暂停或恢复、`x` 停 agent 或整个 run、`r` 重启某个 agent、`s` 存成命令。视图里能看到每个 phase 的 agent 数、每个 agent 的 prompt、工具调用、结果、它自己的 task list，以及**每个 agent 的 token 用量**。

`ultracode` 要说清它不是模型档位而是产品设置：`/effort ultracode` 只作用当次（`off` 关闭，需 v2.1.284+），`claude --effort ultracode` 会同时把档位设成 `xhigh`；开启后被免除的是 `Large workflow` 警告、Agent 工具的并发上限、以及 auto 模式下第一次 workflow 的审批。`ultracode` 这个关键词**只在人亲手敲的输入里生效**（`-p`、SDK、scheduled task、webhook 与 PR 评论都不触发，v2.1.210 之前会），这是一个典型的注入防线取舍。

### 11.3 代码审查：一个 skill 和一朵云

`/code-review` 是 bundled skill（不是内置命令），签名照抄：

```text
/code-review [low|medium|high|xhigh|max|ultra] [--fix] [--comment]
             [--max-findings n|all|default] [pr#|branch|path]
```

默认审"当前分支领先 upstream 的 commits 加未提交改动"，也可以传文件路径、PR 号、分支或 `main...my-feature` 这样的 ref 区间。档位语义是**信噪比换覆盖面**：`low` 只报最确信的那些（假阳最少），`medium` 到 `max` 逐级扩大；不写档位时它会复用你上一次选的 `low` 到 `max` 值并显示 `Reusing high effort...`；`ultra` 不读也不写这个记忆值。`--fix` 应用到工作树，`--comment` 发到 GitHub PR 行内评论或 GitLab MR note。默认它在后台以 forked subagent 跑，三种情况转前台：已有 review 在跑、`-p` 或 SDK、`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`。两条边界：`/code-review` **不读** `REVIEW.md`；后台 `--fix` 产生的编辑不进 checkpoint，`/rewind` 撤不掉。

历史上有两处改名要知道：v2.1.223 起 `/review` 变成 `/code-review` 的别名，此前它是按 PR 号做单遍只读审查的独立命令；`/code-review` 自己在 v2.1.147 之前叫 `/simplify`（那时默认会应用修复），而现在的 `/simplify` 是纯 cleanup 审查、**4 个 agent 并行**分别看 reuse、simplification、efficiency、altitude。

`ultra` 档是另一个量级的东西：它跑在云端沙箱里的多 agent fleet，每条 finding 独立复现验证，耗时 15 到 25 分钟，Pro 与 Max 各有 3 次一次性免费，之后按 usage credits 计费（文档给的区间是每次 $5 到 $25），diff 上限默认 500 文件 / 8000 行。它需要 claude.ai 登录，Bedrock、Agent Platform、Foundry、ZDR、HIPAA 环境不可用，此时 `ultra` 降级为本地审查。CI 里有对应子命令 `claude ultrareview [target]`，`--json` 出原始 `bugs.json`、`--timeout <minutes>` 默认 45、`--post` 与 `--no-post`（默认不发）、退出码 0、1、130，进度写 stderr。托管版的审查维度原文是"logic errors, security vulnerabilities, broken edge cases, and subtle regressions"，严重度分 🔴 Important、🟡 Nit、🟣 Pre-existing，check run 名叫 `Claude Code Review`，末尾还有一行机器可读的 `bughunter-severity: {...}`。`/security-review` 是另一件事：它审当前分支与 origin 默认分支的 diff，找 injection、认证问题与数据暴露，要求仓库**必须有 `origin` remote**。

### 11.4 对 mod-agent

[dynamic-workflows.md](./dynamic-workflows.md) 的"确定性脚本编排加结构化返回加三道上限"与它高度同构，本文可以校准三处。第一是可重放约束要写成硬性设计规则而不是约定：禁 `Date.now()`、禁 `Math.random()`、禁动态 `import()`，这三条直接对应我们的重放正确性，建议进 [agent-loop.md §7](./agent-loop.md) 的工作流运行时契约。第二是"失败的那个 agent 及其之后所有 agent 重跑"这个恢复语义，比我见过的多数实现都保守，但它是唯一在纯顺序重放下可解释的选择，[dynamic-workflows.md §6](./dynamic-workflows.md) 的断点续跑应明确采用同一条并写清改顺序的代价。第三是上限的层级设计：并发 16、单次 fan-out 4096、整次运行 1000，三层各挡一种失控（打爆 API、单步爆炸、总成本失控），我们的"三道上限"应当按这三个维度重排而不是按轮次与 token 两道来分。`ultracode` 只在人类输入里生效这条也值得抄，见 [dynamic-workflows.md §8](./dynamic-workflows.md) 的 opt-in 设计。

## 12. 无人值守：headless、stream-json 与 CI

### 12.1 `-p` 与 `--bare` 的真实差异

`claude -p "<需求>"` 跑完就退，结果打到 stdout，这是所有脚本化用法的入口。

```text
claude -p "Find and fix the bug in auth.py" --allowedTools "Read,Edit,Bash"
cat build-error.txt | claude -p 'concisely explain the root cause of this build error' > output.txt
```

管道输入的上限是 10MB，超了非零退出；官方对大输入的建议是写成文件、在 prompt 里引用路径，而不是塞 stdin。

真正要盯住的是加载行为。不带 `--bare` 时，`-p` **会执行项目 `.claude/settings.json` 里的 hooks、会连接 `.mcp.json` 声明的服务器，即使在未信任目录下也不弹信任框**。这在 CI 里跑外部仓库时是一条实际存在的攻击路径：仓库自带一个 hook，就在你的 runner 上以你的权限执行了。

`--bare` 是为此准备的：跳过 hooks、skills、commands、subagents、plugins、MCP、auto memory 与 `CLAUDE.md`，**绝不读 OAuth 或 keychain**（因此必须给 `ANTHROPIC_API_KEY`），禁后台任务，`--add-dir` 的目录只加载其中的 `.claude/skills/`。官方给它的定位是"recommended mode for scripted and SDK calls"，并且预告了"**will become the default for `-p` in a future release**"。同一目的还有一条更细的路：`--setting-sources` 只挑要加载的层。

无人值守的三件套配置：`--permission-prompts none`（deny 一切会弹窗的调用、移除 `AskUserQuestion`、取消 MCP elicitation）、`--permission-mode dontAsk`（会问的一律拒绝）、`--allowedTools` 预批白名单。退出前它还会等后台工作收尾，默认上限 10 分钟（`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`，设 0 表示不限）。`-p` 里能用 `/skill-name`、简化版 `/model sonnet`、`/config key=value`、`/output-style`、`/mcp`；终端专属的内置命令（如 `/login`）不可用。

### 12.2 stream-json 的三段结构

`--output-format stream-json` 逐事件吐，配 `--input-format stream-json` 可做流式输入。结构是首、中、尾三段。

首事件通常是 `system/init`，字段等于一份会话体检单：`model`、`tools`、`mcp_servers`（含 name、status、可选 source）、`plugins`、`plugin_errors`、`mcp_server_errors`、`slash_commands`、`skills`、`agents`、`cwd`、`claude_code_version`、`permissionMode`、`output_style`、`apiKeySource`、`capabilities`、`fast_mode_state`。它前面还可能出现 `plugin_install` 与 `hook_started`、`hook_progress`、`hook_response`。

中间是 `assistant` 与 `user` 消息，都带 `parent_tool_use_id`：主会话为 `null`，子代理产生的消息指向它的 `tool_use_id`（forked skill 用 `forked-command-` 前缀）。这就是把混合输出按执行主体拆开的现成依据。另有 `system/api_retry` 事件带 `attempt`、`max_retries`、`retry_delay_ms`、`error_status` 与 `error`（枚举如 `authentication_failed`、`rate_limit`、`overloaded`）。

末行 `result` 是机器判定的落点：`subtype` 取 `success`、`error_max_turns`、`error_during_execution`、`error_max_budget_usd`、`error_max_structured_output_retries`，外加 `duration_ms`、`duration_api_ms`、`is_error`、`num_turns`、`result`、`stop_reason`、`total_cost_usd`、`usage`、`modelUsage`、`permission_denials`、`session_id`，以及可选的 `structured_output` 与 `terminal_reason`。

结构化输出走 `--output-format json --json-schema '{...}'`，结果落在 `structured_output` 字段；schema 非法会直接报 `Error: --json-schema is not a valid JSON Schema`；`format` 关键字只当注解、不做校验。

### 12.3 多步 CI 与退出码

会话按 ID 全机器可寻、可以跨目录恢复，这给了流水线一个很朴素的多步范式：

```bash
session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')
claude -p "Continue that review" --resume "$session_id"
```

`--continue` 续当前目录最近一次会话（v2.1.257 起也包括已完成的后台会话），`--resume` 可按 ID、名字或 `.jsonl` 绝对路径。注意 `-p`、SDK 与 `/loop` 产生的会话默认不进交互式的 `/resume` picker。

退出码没有一张统一表，能确定的是这些：成功 0、失败非 0；无效 flag 在启动前报 stderr；运行内失败（比如缺认证）作为 result 打到 stdout 而不是靠退出码区分；**SIGTERM 退 143**，此时当前 turn 未完成、不记录 result，想善终应先 SIGINT 或调 `interrupt()`；stdin 超限非 0；`claude auth status` 用 0 与 1 表示登录与否；`claude daemon status` 未运行时退 1；`claude ultrareview` 是 0、1、130。子命令打错它会提示 `Did you mean ...`。

### 12.4 GitHub Actions

官方 action 是 `uses: anthropics/claude-code-action@v1`（beta 标签已迁移：`@beta` 改 `@v1`、删 `mode` 输入、`direct_prompt` 改名 `prompt`、`max_turns` 与 `model` 并入 `claude_args`）。

inputs 表：`prompt`（纯文本或 skill 调用；省略即监听触发词）、`claude_args`（任意 CLI 参数）、`anthropic_api_key`、`claude_code_oauth_token`（`claude setup-token` 生成）、`github_token`、`plugin_marketplaces`、`plugins`（`name@marketplace`）、`settings`、`trigger_phrase`（默认 `@claude`）、`use_bedrock` / `use_vertex` / `use_foundry`，以及 OIDC 免密四键 `anthropic_federation_rule_id`、`anthropic_organization_id`、`anthropic_service_account_id`、`anthropic_workspace_id`。

三类用法：交互式评论（`issue_comment` 或 `pull_request_review_comment` 加 `contains(github.event.comment.body,'@claude')`）、automation（提供 `prompt` 就自动跑，任意事件都行，含 `schedule: cron`）、PR 审查（`pull_request: [opened, synchronize, ready_for_review, reopened]` 配 `prompt: "/code-review:code-review --comment ..."`，允许 `mcp__github_inline_comment__create_inline_comment`）。

安全约束有五条要照做：密钥只放 GitHub Secrets；触发者需有 write access（否则要配 `allowed_non_write_users`）；bot actor 要进 `allowed_bots` 白名单；公开仓库的 fork PR 不会注入 secrets；默认 `GITHUB_TOKEN` 产生的提交不触发 workflow（Claude 以 App 身份推送）。仓库根的 `CLAUDE.md` 会被每次运行读取，所以它必须精简；权限要最小化，合并前必须人工审。`/install-github-app` 是快速装 App 的入口，它申请的权限有 13 项，含 Actions 与 Workflows 的读写。

值得一提的是这个仓库自己的做法：`.github/` 下 14 个 workflow 几乎全是 issue 治理自动化（自动 triage、去重、关闭重复、锁定旧 issue），而 `CLAUDE.md` 里定的三条硬性加固规则是：跑 Claude 的 job 必须 `runs-on: ubuntu-24.04-firewall`（带 egress 防火墙的 runner），`.github/egress-firewall.yaml` 白名单且 `mode: enforce`，所有调用 claude-code-action 的步骤必须传 `--permission-mode auto` 并指定 `claude-opus-4-6` 或更新型号，另有 `workflow-hardening.yml` 强制检查这三条。这是"用 agent 管仓库"的一份可运行样本。

### 12.5 对 mod-agent

headless 是 [architecture.md](./architecture.md) ADR-7 定的 CLI-first 一等公民，本文给出两处必须补的规格。第一，**`-p` 默认仍会执行仓库自带 hooks 与 MCP**，这是它的现存风险面而不是我们的；我们的 `--print` 应当从一开始就区分"加载项目扩展"与"不加载"，把 `--bare` 语义作为默认并显式提供开关，同时保留一条 `--project-settings` 之类的 opt-in，理由直接写在 [security.md §3](./security.md) 的不可信输入一节。第二，退出码要出正式契约：0、非 0、以及"被 SIGTERM 打断"这一类必须可区分，否则流水线只能靠 stdout 猜。`stream-json` 的 `parent_tool_use_id` 设计与我们的事件溯源模型天然对齐，建议在 [data-and-events.md §2](./data-and-events.md) 的事件里显式加 `parentCallId` 字段并写清 fork 场景的前缀语义。CI 集成部分，[roadmap.md](./roadmap.md) 的 Phase 4 需要一条"egress 防火墙 runner 加模型与权限模式双约束"的加固要求，这是它拿自己仓库当试验品换来的经验。

## 13. Agent SDK：把它当运行时嵌进自己的产品

### 13.1 定位与许可证

先给一句准确的定位：SDK **不是**另一套 agent 实现，它是"runs the Claude Code binary"的库。`query()` 会启动并监管一个 `claude` 子进程，经 stdio 通信，复用同一个 agent loop 与上下文管理。TS 与 Python 两个包都**捆绑对应版本的原生二进制**，官方原话是"The bundled binary is pinned to the SDK package version, so updating the SDK is how you update the CLI"。

许可证这块两语言不一致，要分开说。TypeScript 包 `@anthropic-ai/claude-agent-sdk`（基线日 npm latest 0.3.300）的 license 字段是 `SEE LICENSE IN README.md`，仓库 `LICENSE.md` 写"All rights reserved. Use is subject to Anthropic's Commercial Terms of Service"，属非 OSI 开源。Python 包 `claude-agent-sdk`（PyPI 0.2.167，`requires_python >=3.10`）仓库里的 LICENSE 文件是 MIT，但 README 与文档同时援引商业条款。两种表述并存这件事本身要记录，选路之前先按更严格的那份评估。

版本史里有三处坑：包名迁移（`@anthropic-ai/claude-code` → `@anthropic-ai/claude-agent-sdk`，Python 的 `claude-code-sdk` → `claude-agent-sdk`）；v0.1.0 的破坏性变更是**默认系统提示改成 minimal**，要旧行为得显式设 preset；以及 **V2 session API（`unstable_v2_createSession`、`unstable_v2_resumeSession`、`unstable_v2_prompt`、`SDKSession`）已经被 removed**，TS 0.3.142 起删除，0.2.x 是最后的兼容版。Python 侧 `ClaudeCodeOptions` 改名 `ClaudeAgentOptions`。另有一条品牌规范：接入方产品**不得自称 Claude Code**。

### 13.2 `query()` 与 Options 分组

```ts
function query({
  prompt,
  options,
}: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}): Query
```

`Options` 约 80 个字段，按用途分组记比按字母记有用：

| 组           | 字段                                                                                                                                                                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份与轮次   | `model`、`fallbackModel`、`effort`、`thinking`、`maxTurns`、`maxBudgetUsd`、`taskBudget`、`betas`                                                                                                                                                                                                                 |
| 工具与权限   | `allowedTools`、`disallowedTools`、`tools`、`toolAliases`、`toolConfig`、`permissionMode`、`permissionPromptToolName`、`permissionPrompts`（`host` 或 `none`）、`canUseTool`、`allowDangerouslySkipPermissions`、`sandbox`、`onElicitation`                                                                       |
| 上下文与扩展 | `systemPrompt`、`agents`、`agent`、`hooks`、`mcpServers`、`strictMcpConfig`、`plugins`、`skills`、`outputFormat`、`settings`、`settingSources`、`managedSettings`、`additionalDirectories`、`cwd`、`env`、`includeHookEvents`、`forwardSubagentText`、`agentProgressSummaries`                                    |
| 会话与持久化 | `continue`、`resume`、`resumeSessionAt`、`resumeDropsTurn`、`forkSession`、`sessionId`、`persistSession`、`title`、`sessionStore`、`sessionStoreFlush`（`batch` 或 `eager`）、`user`                                                                                                                              |
| 进程与调试   | `pathToClaudeCodeExecutable`、`executable`、`executableArgs`、`extraArgs`、`spawnClaudeCodeProcess`、`abortController`、`stderr`、`debug`、`debugFile`、`loadTimeoutMs`、`includePartialMessages`、`promptSuggestions`、`verbatimPrompts`、`enableFileCheckpointing`、`planModeInstructions`、`projectConfigRoot` |

一个必须记住的语义：`env` 是**替换**而不是合并，要保留环境就得写 `{...process.env, ...}`。`outputStyle` 不在 `Options` 里，它走 `settings`。

`Query` 本身是 `AsyncGenerator<SDKMessage, void>`，方法有 20 多个：`interrupt()`、`rewindFiles(userMessageId, {dryRun?})`、`setPermissionMode()`、`setModel()`、`setMaxThinkingTokens()`、`applyFlagSettings()`（仅 TS）、`updateSettings('localSettings'|'userSettings', ...)`、`initializationResult()`、`reinitialize()`、`supportedCommands()`、`supportedModels()`、`supportedAgents()`、`mcpServerStatus()`、`getContextUsage({detail?})`、`readFile(path, {maxBytes?, encoding?})`、`reloadPlugins()`、`reloadSkills()`、`reloadOutputStyles()`、`accountInfo()`、`reconnectMcpServer()`、`toggleMcpServer()`、`setMcpServers()`、`readMcpResource()`、`streamInput(stream)`、`stopTask()`、`close()`。其中 `interrupt()`、`setModel()`、`setPermissionMode()`、`applyFlagSettings()` **只在流式输入模式下可用**，这个约束很容易在集成时才撞上。

Python 侧两条路：`query()` 每次新会话且不支持 interrupt；`ClaudeSDKClient` 复用会话、支持 interrupt，适合连续对话，它是 async context manager，方法名走 snake_case（`receive_response`、`rewind_files`、`get_mcp_status`、`get_context_usage`）。`ClaudeAgentOptions` 是 snake_case dataclass，但 `AgentDefinition` 里的多词字段保留 camelCase。

消息类型 30 多个，主干五个要知道：`SDKAssistantMessage`（带 `message: BetaMessage`、`parent_tool_use_id`、`error?`、`aborted?`、`agent_id?`）、`SDKUserMessage`（带 `priority?: "now"|"next"|"later"`、`tool_use_result?`）、`SDKSystemMessage`（`subtype: "init"`，字段同 §12.2）、`SDKResultMessage`、`SDKPartialAssistantMessage`（`type: "stream_event"`，需 `includePartialMessages`）。

### 13.3 成本 API

三条要点。`total_cost_usd` 是**客户端按 list price 估的，不是账单**，合同价要靠 managed 的 `modelPricing` 覆盖，`inference_geo: "us"` 会按 1.1 倍建模。`usage` 只计主循环，子代理不计；含子代理的是 `modelUsage`，按模型给 `inputTokens`、`outputTokens`、`thinkingTokens?`、`cacheReadInputTokens`、`cacheCreationInputTokens`、`webSearchRequests`、`costUSD`、`contextWindow`、`maxOutputTokens`、`costBasis`（`list`、`managed`、`unknown`）。流式输入模式下每个 turn 吐一个 result，而 `total_cost_usd` 与 `modelUsage` 是**整次调用的累计值**，所以读最新值、不要自己求和，`/clear`、`/reset`、`/new` 会重置；v2.1.277 起 `--resume` 同一会话会带上历史累计。`maxBudgetUsd` 只对本次调用自身生效。

### 13.4 `canUseTool` 与六步评估顺序

SDK 里权限的评估顺序是六步，背下来能省很多调试时间：**hooks → deny 规则 → ask 规则 → permission mode → allow 规则 → `canUseTool`**。其中 hook 的 deny 最优先，而 hook 的 allow 不能越过 deny 与 ask 规则；带 specifier 的 scoped 规则（`Bash(rm *)`）在 `bypassPermissions` 下依然生效。

```ts
canUseTool: async (toolName, input, opts) => {
  if (toolName === "Bash" && /rm\s+-rf/.test(input.command as string))
    return { behavior: "deny", message: "destructive rm is not allowed", interrupt: true }
  return { behavior: "allow", updatedInput: input }
}
```

`opts` 给到 `signal`、`suggestions?`、`blockedPath?`、`mcpServer?`、`decisionReason?`、`defaultToNo?`、`suppressAlwaysAllowRule?`、`toolUseID`、`agentID?`、`requestId`。返回 `allow` 时可带 `updatedInput` 与 `updatedPermissions`；`PermissionUpdate` 的动作有 `addRules`、`replaceRules`、`removeRules`、`setMode`、`addDirectories`、`removeDirectories`，`destination` 取 `userSettings`、`projectSettings`、`localSettings`、`session`、`cliArg`。

两条容易致命的行为要写进集成文档。**权限 prompt 不会超时**，回调不返回就是永久挂住；被 `allowedTools` 或 `bypassPermissions` 预批的调用**永远不会**触发 `canUseTool`（SDK 会发一条 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning）。也就是说：想对每一个工具调用做门禁，唯一可靠的位置是 `PreToolUse` hook。无人值守要么 `permissionPrompts: 'none'`，要么 `permissionMode: 'dontAsk'`。子代理继承父模式，只有父是 `default`、`dontAsk` 或 `plan` 时，其定义里的 `permissionMode` 才生效。

### 13.5 进程内 MCP 工具

自定义工具不用起独立进程，这是 SDK 相对 CLI 最实用的一个能力。

```ts
const server = createSdkMcpServer({
  name: "orders",
  tools: [
    tool("lookup", "Look up an order by id", { id: z.string() }, async ({ id }) => ({
      content: [{ type: "text", text: JSON.stringify(await find(id)) }],
    })),
  ],
})
// options: { mcpServers: { orders: server }, allowedTools: ["mcp__orders__*"] }
```

`tool(name, description, inputSchema, handler, extras?)`，`extras` 支持 `annotations`、`searchHint`、`alwaysLoad`；`createSdkMcpServer({name, version?, instructions?, tools?, alwaysLoad?, timeout?})`。服务器**在进程内运行**，暴露名仍是 `mcp__<server>__<tool>`，必须用 `allowedTools` 预批（通配只能跟在字面 `mcp__<server>__` 之后），否则每次都走权限回调；`permissionMode: "acceptEdits"` **不会**自动批准 MCP 工具。返回内容支持 `text`、`image`、`audio`、`resource`、`resource_link`，其中 image 只接受内联 base64（`data` 加 `mimeType`，**没有 URL 字段**，得自己抓下来再编码），另有 `structuredContent` 与 `isError: true`。Python 对应 `@tool(...)` 装饰器加 `create_sdk_mcp_server()`。

### 13.6 `settingSources` 与托管

`settingSources` 取 `("user"|"project"|"local")[]`。**默认与 CLI 相同，三种全加载**；显式传 `[]` 才关掉。多租户与 CI 场景建议就是 `[]`，否则用户机器上的 `~/.claude/settings.json` 会渗进你的服务。不受它控制的几样要单独关：managed policy（无法关）、`~/.claude.json`（用 `CLAUDE_CONFIG_DIR` 迁移）、auto memory（`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`）、claude.ai connectors（`strictMcpConfig`、`disableClaudeAiConnectors` 或 `ENABLE_CLAUDEAI_MCP_SERVERS=false`）、沙箱的 deny 与 mask。只有 `project` 源会加载 `CLAUDE.md`、项目 hooks 与 `.mcp.json`。

系统提示有四种起点：不设 `systemPrompt` 时是 minimal（注意与 `claude -p` 的完整提示不同）、preset `{type:"preset", preset:"claude_code", append:"...", excludeDynamicSections?:true, snapshot?:boolean}`、custom string 全替换、TS 的 `{type:"custom"}`。`excludeDynamicSections`（需 TS SDK ≥0.2.98）把 per-user 上下文移到首条 user 消息里，目的是让不同用户共享同一份 prompt cache，这是它做规模成本控制的显式手段。`CLAUDE.md` 注入的是会话内容而不是系统提示，与任何 preset 都能叠。

托管部署的形态：一个 session 一个 `claude` 子进程（stdio），transcript、`CLAUDE.md`、artifacts 默认落本地盘。四种模式是 Ephemeral、Long-running、Hybrid（**必须配 `SessionStore`**）、Multi-agent container。起步资源官方给的是每 agent 1 GiB 内存、5 GiB 磁盘、1 CPU，单机容量按 `(host RAM - overhead) / per-session RAM ceiling` 估算。依赖 Python 3.10+ 或 Node.js 18+，多数安装不需要另装 CLI。出网要放行 `api.anthropic.com`（或对应云平台端点）与 MCP 端点，建议走 egress proxy。已知限制四条：没有顶层会话超时（得靠 `maxTurns`）、长会话内存会涨、大规模子代理并发可能触发限流、没有 per-subagent 墙钟截止。冷启动优化有两个 API：`startup()` 预热出 `WarmQuery`，`prewarm()`（标 Alpha，v0.3.282+）配合 `SpareProcess.claim()`，官方给的 spare 进程成本是约 230 到 260MB。

MCP 与 skills 在 SDK 侧的配置：`mcpServers` 支持 `stdio`、`sse`、`http`、`sdk` 四种（另有 `claudeai-proxy`），stdio 与无缓存的 HTTP 会在首轮之前阻塞等待（`MCP_TIMEOUT` 默认 30 秒），已缓存工具列表的远端服务器要到首次调用才连。`skills` 取 `"all"`、字符串数组或不设；设了它 SDK 会自动把 `Skill` 加进 `allowedTools`，但如果你同时给了 `tools`，就得自己把 `'Skill'` 写进去；**没有程序化的 skill 注册 API**，只能落到 `.claude/skills/<name>/SKILL.md` 文件。会话管理的顶层函数是 `listSessions()`、`getSessionMessages()`、`getSessionInfo()`、`renameSession()`、`tagSession()`、`forkSession()`，跨主机续跑靠 `sessionStore` 适配器（mirror 语义，失败发 `mirror_error` 事件）。

### 13.7 对 mod-agent

SDK 这一层恰好就是 mod-agent 的目标形态，所以它的每个设计选择都值得对照读。四点值得直接吸收进 [architecture.md](./architecture.md)。第一，**CLI 与 SDK 是同一个 runtime 的两个前端**，SDK 通过子进程复用 CLI 而不是复制逻辑，这解决了"两边行为漂移"这个几乎必然出现的问题；我们的 Model Gateway 与 Runtime 分层已经具备这个条件，应当把"CLI 与编程接口共用一个内核进程"写成 ADR。第二，`Options` 那份 80 字段的分组表是一份现成的公共 API 需求清单，可以按组去核对 [development-guide.md](./development-guide.md) 里的模块接口是否有对应位置。第三，"预批的调用不会触发 `canUseTool`、要门禁就去 `PreToolUse`"这个坑，正是我们[security.md §4](./security.md) 判定引擎必须**只有一个判定点**的反面教材：两套并存的门禁入口一定会出现被静默跳过的路径。第四，`settingSources: []` 与 `excludeDynamicSections` 说明它把"多租户隔离"与"prompt cache 复用"当成一等配置面，建议进 [model-gateway.md §2](./model-gateway.md) 与 [context-engineering.md §3](./context-engineering.md)。

## 14. 版本演进与容易踩的过时说法

### 14.1 关键节点

v2.1.300 发布于 2026-08-14，CHANGELOG 共 421 个版本节、9,073 行（从 0.2.21 起）。下面这条线只留"会改变你怎么用它"的节点。

| 版本                        | 变化                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 2.0.0                       | `/rewind`、`/usage`、原生 VS Code 扩展、Claude Code SDK 改名 **Claude Agent SDK**、`--agents`                 |
| 2.0.12 / 2.0.20 / 2.0.24    | 插件系统 GA、Skills、**Bash 沙箱**（Linux 与 macOS）                                                          |
| 2.0.17 / 2.0.51 / 2.0.60    | Explore 子代理、Opus 4.5 与桌面版、**后台 agents**                                                            |
| 2.0.62 / 2.0.64 / 2.0.68    | `attribution`（废弃 `includeCoAuthoredBy`）、`.claude/rules/`、企业 managed settings                          |
| 2.0.74                      | LSP 工具（代码智能那一类）                                                                                    |
| 2.1.16 / 2.1.32 / 2.1.63    | 新任务系统四件套、**agent teams 研究预览**、Task 改名 `Agent`、HTTP hooks                                     |
| 2.1.71 / 2.1.76             | `/loop` 与 cron 工具、MCP elicitation 与 `/effort`                                                            |
| 2.1.81 / 2.1.83 / 2.1.84    | **`--bare`**、`managed-settings.d/` drop-in、PowerShell 工具                                                  |
| 2.1.98 / 2.1.111 / 2.1.139  | Monitor 工具、`/ultrareview` 与 `xhigh`、agent view 与 `/goal`                                                |
| 2.1.152 / 2.1.154           | auto mode 不再需要 opt-in、**dynamic workflows** 与 `/workflows`                                              |
| 2.1.197 / 2.1.200 / 2.1.217 | Sonnet 5 成默认（1M 原生窗口）、`default` 改名 **Manual**、子代理默认不再嵌套 spawn（后在 2.1.219 提回 3 层） |
| 2.1.222 / 2.1.224 / 2.1.259 | 移除 `/ultraplan`、`claude self-hosted-runner` 与跨会话 `SendMessage`、`--permission-prompts none`            |
| 2.1.277 / 2.1.283           | **`AGENTS.md` 支持**（以 mod 形式实现）、未配置权限模式的新会话默认进 **auto mode**                           |
| 2.1.287 / 2.1.300           | **Claude Mods GA**（"plugins may now modify deeper behavior"）、`/advisor`                                    |

另有一条独立于上表的暗线：MCP 协议协商在 2.1.292、2.1.295、2.1.299 三次里逐步切到 **2026-07-28** 修订，工具描述上限同期从 2,048 提到 4,096。

### 14.2 网上还在说、官方已经改掉的六件事

这六条是本次核对里反复出现的偏差，写文档或读二手资料时都值得过一遍。

1. **"五个 hook 事件"**：现在是 33 个，另有五种 `type`（`command`、`http`、`mcp_tool`、`prompt`、`agent`）。
2. **"三种权限模式"**：现在是六种，而且默认档位已经从"每次都问"漂移到"分类器代审"。
3. **"Task 工具"**：v2.1.63 起叫 `Agent`，旧名仍可用作别名。
4. **行首 `#` 快速写记忆**：现行文档里已经没有这个语法。
5. **"`CLAUDE.md` 会被 `AGENTS.md` 覆盖 / 二者自动等价"**：都不是，它是有条件的回退读取，且默认策略、配置入口、不触发的 hook 都有明确规定（§3.6）。
6. **"子代理可以无限套 / 默认五层"**：默认三层且可配，历史上 1、3、5 都出现过，取决于版本。

### 14.3 三处仍在互相矛盾的事实

诚实起见的三份，写文档时不要用它们下结论。

安装要求上，README 徽章写 `Node.js-18+`，而 setup 页写 npm 包要求 Node 22 或更高，且低版本只警告不失败。以后者为准。

许可证上，Python SDK 仓库 LICENSE 是 MIT，而 README 与文档援引商业条款，两种表述并存，仓库没有解释优先级。

模型解析上，同一份 `model-config` 页里，同一个别名的解析结果按平台分四组，加上版本门槛（`Sonnet 5.5 requires Claude Code v2.1.284 or later`），任何脱离平台与版本抄下来的"sonnet 就是某型号"都是错的。

## 15. 延伸阅读

| 想接着搞清楚                             | 去读                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 这些机制分别落到我们哪个模块             | 本文各节末的"对 mod-agent"，以及 [architecture.md](./architecture.md)                                                            |
| 权限判定引擎与沙箱基线怎么设计           | [security.md](./security.md)                                                                                                     |
| 主循环、停止与恢复、预算语义             | [agent-loop.md](./agent-loop.md)                                                                                                 |
| 上下文装配、检索与压缩                   | [context-engineering.md](./context-engineering.md)                                                                               |
| 工具契约、MCP 与审批策略                 | [tools-and-extensions.md](./tools-and-extensions.md)                                                                             |
| 子代理与验证循环                         | [verification-and-multiagent.md](./verification-and-multiagent.md)                                                               |
| 目标追达、循环续跑、自动批准             | [autonomy.md](./autonomy.md)                                                                                                     |
| 工作流编排与团队、后台舰队               | [dynamic-workflows.md](./dynamic-workflows.md)、[agent-teams.md](./agent-teams.md)、[background-fleet.md](./background-fleet.md) |
| 横向看别家怎么做同一件事                 | [coding-agents.md](./coding-agents.md)                                                                                           |
| 本文引用了哪些一手页面、页面路径变更对照 | [references.md](./references.md) §15                                                                                             |

> 本文所有事实基线是 Claude Code v2.1.300 与 2026-08-15 抓取的官方文档。这个产品每周发版，如果你按本文某条命令敲不出来，第一反应应该是查版本，而不是改命令。
