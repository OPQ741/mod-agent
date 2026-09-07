# Usage · 使用说明（面向使用者）

> 本文从使用者的角度带你走完一次任务：怎样开会话、怎样把需求说清楚、看到审批时如何判断，以及被打断后怎样继续。运行机制放在专题文档中；需要时再沿链接深入。
>
> 读完后，你可以用一个小需求跑通完整流程，在四种任务模式之间选择，看懂审批提示，写好项目规则，并在长任务被打断后安全恢复。

> 项目阶段：**代码阶段**。下面的命令、配置项与快捷键已经随 `src/cli/` 落地，但仍在演进：以 `mod --help` 与 `/help` 的实际输出为准，本文说明设计意图与使用场景。

## 读法

第一次阅读先跟着 §2 的完整示例走一遍，再按需要查看任务模式和命令清单。实际行为以 `mod --help` 与 `/help` 的输出为准；本文说明设计意图与使用场景。

## 1. 装好之后第一次启动

`mod` 会启动一个持久会话。你在会话中描述需求，Agent 根据当前权限读取代码、修改文件并运行验证。首次启动若尚未配置凭证，会引导完成模型配置。

```text
$ mod
mod-agent v0.0.0-dev  ·  工作区 D:\repos\shopfront  ·  分支 feat/checkout
首次运行：未检测到模型凭证。
? 选择模型供应商  Anthropic
? 粘贴 API Key（输入不回显，仅写入 ~/.mod/credentials，不进命令行参数）  ********
✓ 已就绪，默认模型 sonnet · 默认模式 plan
输入需求即开始，Ctrl-D 退出，/help 看命令。

> _
```

`--help` 会列出全部启动参数，`/help` 列出会话内的斜杠命令。这两处才是权威清单，本页 §4 只是带注释的摘录。有一点现在就要讲明：模型凭证只从配置文件或环境变量读，绝不作为命令行参数传入，否则它会出现在进程列表与 shell 历史里（[security.md §5](./security.md)）。

```text
$ mod --help
用法: mod [选项] [需求]

  --print "<需求>"           单次跑到底，结果打到 stdout（headless）
  --output-format <fmt>      text | json | stream-json
  --auto <low|medium|high>   静态放权档位
  --mode <ask|plan|...>      任务模式
  --model <id>               指定模型
  --worktree / --no-worktree 是否为任务开独立 worktree
  --resume <id> / --continue 恢复 / 续跑会话
  --bare                     无人值守最小面
  --version, -V              版本
  --help, -h                 本帮助
```

## 2. 一次典型任务的全程走查

这是全文主干。例子选一个小而具体的需求：给一个 CLI 加一个 `--json` 输出选项，并补上测试。全程对应 [index.md](./index.md) 的六个阶段：提需求、探索、计划、改、验证、交付。

```text
> 给 reports 子命令加一个 --json 选项，输出机器可读结果，并补一个测试
[探索] rg --json 命中 4 个文件 · 读 cli/reports.ts · 读 AGENTS.md · 读 tests/reports.test.ts
[计划] 1. 在 parseArgs 里加 --json 分支  2. reports() 增 json 出参  3. 新增 tests/reports.json.test.ts
       影响 2 文件 + 1 测试文件 · 预计改动 ~40 行
按 Enter 按计划执行 · e 编辑计划 · Esc 取消

> （Enter）
[改] 写 cli/reports.ts（精确替换，1 处命中）      [审批] 允许一次 / 本会话放行 / 拒绝 / 改参数 > 允许一次
[改] 写 tests/reports.json.test.ts
[验证] npm run typecheck ✓   npm run test reports ✗（exit 1：json 出参少一个换行）
[自修] 回到 [改] 修 reports() 的序列化，再跑一次
[验证] npm run typecheck ✓   npm run test reports ✓（新增 2 用例通过）
[交付] 改动 3 文件 · +41/-3 · base 9f2a1c → worktree 分支 agent/checkout-7b
diff 已生成，输入 /diff 逐文件审 · /restore 回退 · 满意后自己合分支

> /diff
cli/reports.ts        +22/-1
tests/reports.json.test.ts  +19/-0
```

从这个例子记住四件事就够了：计划阶段只给方案；是否需要批准取决于当前模式；验证失败会在预算允许的范围内回到修改；合并分支永远由人完成。修复循环的预算规则见 [agent-loop.md §6](./agent-loop.md)。

## 3. 四种任务模式怎么切

mod-agent 把"agent 的手能伸多远"分成四档：`ask`、`plan`、`edit`、`autopilot`。语义权威在 [overview.md §1.2](./overview.md)，这里只讲用户侧差别。

| 模式        | 能改文件 | 能跑命令     | 什么时候停下来问你             | 适合什么                     |
| ----------- | -------- | ------------ | ------------------------------ | ---------------------------- |
| `ask`       | 否       | 否（仅只读） | 每次想动手都会停，因为它不能动 | 摸清代码、解释链路、只读侦察 |
| `plan`      | 否       | 否           | 出完计划等你确认               | 中大型改动前先对齐思路       |
| `edit`      | 是       | 是（受审批） | 高风险动作、交付前             | 日常改代码，默认档           |
| `autopilot` | 是       | 是（预算内） | 只在强制审批点和撞线时停       | 明确目标下连跑多轮修复       |

切换用 `/mode <ask|plan|edit|autopilot>`，或启动时 `mod --mode edit`（此二处为本文首次成文的设计约定）。默认是 `plan`，不是无边界全自动：人与管理员的授权范围，优先级永远高于模型提出的动作。

档位只是会话级默认值，不是不可撤销的开关：可以随时用 `/mode` 切换，也可以在单次审批时改变某个动作的决定。`autopilot` 会多做一些自动修复，但最终交付仍要由人审阅。

`autopilot` 也省不掉强制审批点，它省的是中间那些逐次确认。别把 `--auto low/medium/high` 当成同一件事：那是静态预批档位（哪些操作提前标为放行，[security.md §3.1](./security.md)），而 Auto Mode 是对"规则没命中、本该弹框"的动作由分类器实时裁决的动态自治（[autonomy.md §3](./autonomy.md)）。静态档位决定哪些不用问，Auto Mode 决定剩下那些能不能不问人也放行。

## 4. 命令清单

### 4.1 会话内斜杠命令

| 命令                                 | 作用                                                                                                            | 依据                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/goal <目标>`                       | 给一个可判定目标，自跑外循环直到达成或判不可能                                                                  | [autonomy.md §1](./autonomy.md)                                                        |
| `/loop [间隔/dynamic] <任务>`        | 定时或自排程续跑，如 `/loop 10m 检查 CI 状态`                                                                   | [autonomy.md §2](./autonomy.md)                                                        |
| `/schedule <任务>`                   | 把循环改成脱离会话的云端计划，关会话也不停                                                                      | [autonomy.md §2.4](./autonomy.md)                                                      |
| `/bg`                                | 把当前会话摘到后台常驻，终端立刻腾出来                                                                          | [background-fleet.md §2](./background-fleet.md)                                        |
| `ultracode`（写在需求里）            | 本轮 opt-in 成动态工作流，模型现写脚本 fan-out                                                                  | [dynamic-workflows.md §8](./dynamic-workflows.md)                                      |
| `/effort ultracode`                  | 会话级常驻开启工作流编排                                                                                        | [dynamic-workflows.md §8](./dynamic-workflows.md)                                      |
| `/workflows`                         | 看每个工作流的实时 phase 与进度                                                                                 | [dynamic-workflows.md §8](./dynamic-workflows.md)                                      |
| `/mode <ask\|plan\|edit\|autopilot>` | 切换任务模式                                                                                                    | 本文约定                                                                               |
| `/output-style <name>`               | 切换输出风格（Default / Proactive / Concise / Explanatory / Learning / 自定义）；与 `/mode` 是两个正交轴        | [system-prompt.md §6.1](./system-prompt.md)                                            |
| `/model <id>`                        | 切换当前会话用的模型                                                                                            | 本文约定                                                                               |
| `/rename <name>`                     | 给当前会话命名，之后可用 `--resume <name>` 直接续跑                                                             | Claude Code `sessions.md` 实证：exact match 直启、ambiguous 打开 picker                |
| `/branch [name]`                     | 从当前 turn 复制一份会话到新 ID（原 transcript 不动），适合"我想试另一种做法但不想丢掉现有进度"                 | Claude Code `sessions.md` 实证；见 [agent-loop.md §5.1](./agent-loop.md) 会话语义      |
| `/diff` `/review`                    | 逐文件审 agent 这次的改动                                                                                       | [code-editing.md §5](./code-editing.md)                                                |
| `/restore`                           | 把改动退回某个检查点（三种退法见 §7）                                                                           | [code-editing.md §3.1](./code-editing.md)                                              |
| `/rules`                             | 查看当前拼进上下文的项目规则及来源                                                                              | 本文约定                                                                               |
| `/context`                           | 打开上下文体检面板：本次会话真正加载了哪些规则文件、多少 MCP 工具、每类内容占多少 token、超上限时给腾空间的建议 | Claude Code `context-window.md` 实证；配置漂移时的第一排查入口                         |
| `/doctor`                            | 只读诊断：解析有效配置、检查凭据、跑一次 `hello` 冒烟；`/doctor prompt-audit` 审计规则文件陈旧与自相矛盾        | Claude Code `debug-your-config.md` 实证                                                |
| `/usage` `/status`                   | 查看当前会话花费、缓存命中、剩余预算                                                                            | 本文约定（成本口径见 [observability-evaluation.md §2](./observability-evaluation.md)） |
| `/compact`                           | 手动压缩历史，逼近上下文上限前腾出空间                                                                          | 本文约定（机制见 context-engineering.md §5）                                           |
| `/resume` `/sessions`                | 找回历史会话                                                                                                    | 本文约定（存储见 data-and-events.md）                                                  |
| `/help`                              | 全部命令                                                                                                        | 本文约定                                                                               |

### 4.2 启动参数（CLI flags）

| 参数                                            | 作用                                                     | 依据                                      |
| ----------------------------------------------- | -------------------------------------------------------- | ----------------------------------------- |
| `--print "<需求>"`                              | headless 单次跑到底，把结果打到 stdout，供脚本/CI 调用   | ADR-7 · coding-agents.md §5.9             |
| `--output-format text\|json\|stream-json`       | headless 输出格式，`json` 带成本、`stream-json` 逐事件吐 | [agent-loop.md §6.3](./agent-loop.md)     |
| `--auto low\|medium\|high`                      | 静态放权档位，决定哪些动作预批为放行                     | [security.md §3.1](./security.md)         |
| `--mode <四档>`                                 | 启动即选定任务模式                                       | 本文约定                                  |
| `--model <id>` `--provider <id>`                | 指定模型与供应商                                         | [model-gateway.md §1](./model-gateway.md) |
| `--worktree` / `--no-worktree`                  | 是否为本次任务开独立 Git worktree（默认开）              | [code-editing.md §3](./code-editing.md)   |
| `--cwd <dir>`                                   | 指定工作区目录                                           | 本文约定                                  |
| `--resume <id>` / `--continue`                  | 恢复指定会话 / 接着上次会话跑                            | 本文约定                                  |
| `--settings <file\|json>` `--mcp-config <file>` | 显式注入配置与 MCP（CI 推荐）                            | [security.md §3.1](./security.md)         |
| `--bare`                                        | 无人值守最小面，不自动加载任何仓库自带扩展与规则         | [security.md §3.1](./security.md)         |
| `--skip-permissions-unsafe`                     | 移除全部护栏，仅限一次性隔离容器                         | [security.md §3.1](./security.md)         |

带"本文约定"的行是本页第一次把它们写死，实现时若与专题冲突以专题为准。`--print` 与 `--output-format` 的语义不是拍脑袋：headless 是 ADR-7 定的 CLI-first 一等公民，事件流直接序列化成 `stream-json`，退出码即成败（0 成功、非 0 失败，2 表示被人主动打断，[agent-loop.md §6.3](./agent-loop.md)）。

### 4.3 配置文件（settings.json）

启动参数是一次性的，长期偏好落在配置文件里。分层的权威在 [security.md §4.1](./security.md)：托管策略 > 命令行 `--settings` > 团队 `.mod/settings.json` > 用户 `~/.mod/settings.json` > 项目 `settings.local.json`。下面这份是本文第一次把配置项成清单列出，实现时以各专题为准。

```jsonc
{
  "model": "your-model-id", // 默认模型
  "provider": "anthropic", // 供应商；API Key 只走 env 或 credentials 文件
  "mode": "plan", // 默认任务模式
  "auto": "medium", // 静态放权档位 low|medium|high
  "worktree": true, // 每任务独立 worktree
  "respectGitignore": true, // 禁止读写 gitignored 路径
  "permissions": {
    "allow": ["Read(**)", "Exec(git status:*)"],
    "ask": ["Write(**/.env*)"],
    "deny": ["Exec(sudo:*)"], // deny 永远优先，任何模式翻不了案
  },
  "budget": {
    "max_cost_usd": 2.0, // 单任务花费上限
    "max_rounds": 30, // 单任务最大轮次
  },
  "checkpoint": false, // 影子快照，默认关；开了才敢让 agent 连跑
}
```

三个字段值得单独点一下：`permissions` 的合并语义是 `allow` 跨层取并集、`deny`/`ask` 优先且立即生效，团队能给你放权、绝不能越权替你解禁；`budget` 两项在 §8 讲成本时展开；`checkpoint` 默认关闭，因为快照占磁盘、会拖慢每次提交，它与自动批准是捆绑设计，开了才敢让 agent 连续自主干活（[code-editing.md §3.1](./code-editing.md)）。

## 5. 审批对话框长什么样

agent 要写文件、跑命令、联网，而当前档位判为"该问人"时，弹一个框。权限判定的规则引擎是权威（[security.md §4.2](./security.md)），这里只讲你会看到什么、能选什么。

```text
[审批] 运行命令：npm install zod
目录 D:\repos\shopfront\  ·  网络 关闭  ·  超时 120s
理由：新增 --json 需要 zod 做入参校验
选项： [y] 允许一次   [a] 本会话对相同参数放行   [n] 拒绝并说明   [m] 改参数
>
```

四个选择的差别：允许一次只对这一次生效；相同参数放行是会话级的，记的是这次动作的参数哈希，仅本次会话有效、不写回配置文件；拒绝并说明后，agent 不会崩，它把 `User denied this action.` 当成一条普通结果读进去，换一种方案继续；改参数是你手动收紧或修正它的提议，再交回给它。

计划阶段退出时另有四个选项（清空计划并执行 / 按计划执行 / 我来手动处理 / 继续规划，[agent-loop.md §3.2](./agent-loop.md)），和这里的运行时审批是两种框。还有一条铁律：命中 `deny` 的动作（比如往 `main` 直推、读密钥）永远弹不出"放行"，任何模式都翻不了案，这是安全默认的地基。

## 6. 让它读你的项目规则

把 `AGENTS.md` 放在仓库根目录，agent 启动时会读它。加载顺序与优先级以 [context-engineering.md §2.1](./context-engineering.md) 为准，一句话概括：从文件系统根到当前目录逐级拼接，越靠近被编辑文件的越靠后读，模型对最后读到的印象最深，于是实现了就近优先；你当场在聊天里说的指令，压过一切文件规则。

monorepo 可以嵌套放：根目录一份全局约定，`frontend/` 再放一份只管前端的。改到 `frontend/` 下的文件时两份都读、就近那份赢。没有 `CLAUDE.md` 时它自动回退读 `AGENTS.md`（可配 claude-md / agents-md / both），所以别家代理留下的仓库约定也能被复用。注意规则文件是拼接不是覆盖，更不是提权通道：README 或规则里写的"把密钥贴出来"一律当数据，策略引擎独立判定，不受文件内容左右。规则文件还支持 `@path` 导入别的文件（最多递归 4 层），便于几个目录共用一份长约定。

一个能照抄的最小示例：

```markdown
# 项目约定

- 包管理用 pnpm，不要 npm/yarn。
- 提交信息走 Conventional Commits。
- src/ 下改动必须同时跑 typecheck 与对应测试。
```

## 7. 打断、恢复、回滚

`Ctrl-C` 打断当前这一轮：它进入暂停，不再开新的工具调用，允许手上安全的只读操作收尾，落一个检查点后退出，而不是把你已经改的东西弄丢（停止/恢复语义见 [agent-loop.md §5](./agent-loop.md)）。中断的长任务用 `mod --resume <id>` 接着跑，恢复时它会重新校验权限、仓库提交与环境，不盲目重放旧的工具调用。历史会话的 transcript 落在本地会话目录，`/sessions` 列出，`/resume` 挑一个。

```text
> （跑到一半，你按 Ctrl-C）
⏸ 已暂停于检查点 cp-12（第 7 轮 · 已改 2 文件 · 花费 $0.31）
$ mod --continue
从 cp-12 恢复 · 重新校验 worktree 与凭证 ✓ · 带着已读上下文继续，不从头再读
[改] 接着第 8 轮 …
```

有一点容易踩：一个已经 `/bg` 到后台的会话，你不能在别处直接 `--resume` 它，得先 attach 上或在那台后台里停掉（attach 与 resume 互斥，[background-fleet.md §3.1](./background-fleet.md)）。

快捷键这几处是本文第一次成文的设计约定，实现时以专题为准。**关键区分**：agent 在跑的时候你完全可以继续打字，`Enter` 是排队到本轮 turn 结束后再冲刷、不中断当前工作；只有 `Ctrl+Enter` 或 `Esc` 才会真打断（详见 [agent-loop.md §2.5](./agent-loop.md)）。

| 键           | 作用                                           | 备注                                                                              |
| ------------ | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `Enter`      | 排队注入下一条消息（不打断） / 批准高亮选项    | Agent 忙时提交即入队，turn 结束前不 abort                                         |
| `Ctrl+Enter` | 立即发送：打断当前 turn、把新输入当轮起点      | 走 AbortController → 落 checkpoint → 重启 turn                                    |
| `Esc`        | 中断当前生成，**保留已完成的工作**             | 已改文件不回滚；关闭审批框（不是退出会话）                                        |
| `Ctrl-C`     | 暂停这一轮 / 中断流式生成                      | 落检查点后退出，可 `--continue`                                                   |
| `Ctrl-B`     | 把当前正在跑的 Bash 或子 agent 摘到后台        | 主循环继续响应；对齐 [background-fleet.md](./background-fleet.md)                 |
| `Ctrl-O`     | 展开 transcript viewer，看 thinking 与工具细节 | 只读视图，不改任何东西                                                            |
| `e`          | 在计划处进入编辑                               | 改完再放行                                                                        |
| `Tab`        | 审批框里附加"为什么批 / 为什么拒"的评论        | 一次审计证据，随 `approval.decided` 落库（[agent-loop.md §2.5](./agent-loop.md)） |
| `Ctrl-D`     | 退出会话                                       | 已发生的副作用不假装回滚                                                          |

回退分三种，不是一把梭（[code-editing.md §3.1](./code-editing.md)）：

| 操作         | 文件     | 对话历史     | 什么时候用           |
| ------------ | -------- | ------------ | -------------------- |
| Restore 文件 | 退回快照 | 保留         | 代码改坏了，想换思路 |
| Restore 任务 | 保留     | 删掉之后消息 | 代码没错，但聊跑偏了 |
| 两者都退     | 退回快照 | 删掉之后消息 | 从干净状态完全重来   |

回退不可逆，操作前会给你一份 Compare diff 确认。你最关心的一条：你在未提交状态下的改动它会不会覆盖。答案是不会。执行前它先取 `git status` 记录你的 dirty state，为任务单独开一个 Git worktree，不在你的工作区里混写；即便被迫在本机目录内干，也只按路径白名单改授权文件，绝不用 `git reset --hard` / `git clean -fd` 清场（[code-editing.md §3](./code-editing.md)）。

## 8. 管住成本

先给结论：agent 烧钱的大头是重复发送的输入上下文，不是输出，而一个跑到底的长任务往往占掉总成本的大半（成因见 [research.md §3.3](./research.md)，路由账见 [model-gateway.md §2.1](./model-gateway.md)）。所以省钱的第一招不是换便宜模型，是先摸清情况再放开写。

设预算：配置项 `budget.max_cost_usd` 与 `budget.max_rounds` 给一个任务设硬上限（这两个键是本文首次成文），`/goal` 循环另有迭代数与花费两道刹车，任一触顶即停并汇报（[autonomy.md §1.4](./autonomy.md)）。看花费：headless 的 `--output-format json` 返回体里带 `usage` 与 `total_cost_usd`，交互模式在任务收尾的交付报告里列这一单花了多少。最容易烧钱的是验证失败的自动循环，即改一次跑一次测试反复几十轮，所以上 `autopilot` 或 `/goal` 前先设好上限。

省法：先用 `ask` 或 `plan` 只读摸清改动面，确认范围后再切 `edit` 放开写。多轮任务里 agent 会自动压缩历史（[context-engineering.md §5](./context-engineering.md)），这一步无需你操心，但别在快撞上限时又贴一整个大文件进去。之所以值得抠上下文：agent 的成本是复利的，上下文每一步都要重发，减一次后面每一步都在省；很多时候省下来的不只是钱，是原本会因上下文耗尽而做不成的长任务。

## 9. 典型场景速查

1. **修一个 bug 并跑测试到绿**：直接说现象加复现步骤，用 `edit`；要它自己试到全绿就上 `/goal 让 npm test 全绿`，并设好迭代上限。
2. **跨多文件重命名**：用 `plan` 先看它列出的影响面，确认没误伤，再切 `edit` 执行；改动铺得过大会触发二次计划审查。
3. **给老仓库补测试**：`edit` 下指名模块，要求"新测试真实运行、不许为了变绿改测试断言"，测试文件的改动会在验证层单独告警。
4. **边写边审的探索式改动**：停在 `plan`，每轮只让它出计划不改文件，你读完再逐条放行到 `edit`。
5. **下班前挂一个长任务**：`/goal` 定可判定目标加预算，`/bg` 摘到后台，收尾时它会 commit 功能分支、push、开 draft PR，但绝不直推主干（[background-fleet.md §7](./background-fleet.md)）。
6. **CI 里无人值守跑一遍**：`mod --print "<需求>" --output-format stream-json --bare --settings ci.json`，不加载仓库自带扩展与规则，退出码 0/非 0 直接给流水线分支。
7. **只想读懂代码不想动手**：`/mode ask` 后问"解释这个页面的请求链路"，它只查不改，结论带文件路径与符号证据。
8. **盯一个会自己变的信号**：`/loop 10m 检查 CI 状态`，红了就报；要跑完这一整个下午就 `/bg` 摘到后台，或 `/schedule` 转成脱离会话的云端计划。
9. **Coding Agent 与 UI 自动验证**：修改代码后启动开发服务，打开真实页面，执行交互测试、记录截图并检查控制台错误。对于视觉问题，再将实际渲染与设计参考进行对比，形成“修改 → 验证 → 修复”的闭环。

## 10. 常见问题与边界

这一节把"它到底管到哪、不该指望它什么"摊开讲。

- **它不会做什么**：不自动部署生产、不合并主干、不碰线上数据，也不 force-push（[overview.md §1](./overview.md)）。后台任务收尾会 commit 到功能分支并开 draft PR，但合不合永远等你点头。
- **什么时候该人来**：需求含糊到没法判定验收、影响面横跨多个系统、涉及不可逆的数据迁移或安全决策。这时 agent 负责把方案和证据摆到你面前，拍板是你的。
- **为什么某些动作非要审批**：agent 读的 README、issue、网页全是不可信输入，光靠提示模型警惕挡不住注入，防线必须落在框架层（[security.md §2](./security.md)）。
- **它自述"已完成"为什么不算数**：一切以仓库自带的类型检查、lint、测试真实跑过并留痕为准，这是验证驱动原则（[overview.md §2](./overview.md) 第 3 条）。
- **它会不会读走我的密钥**：工作区之外的任意文件读不到，`.env*`、`~/.ssh/**`、云凭证目录默认拒读或每次问你；密钥也从不写进命令行参数（[security.md §3](./security.md)、[security.md §5](./security.md)）。
- **为什么第一次进目录要我点"信任"**：团队提交在仓库里的 `allow` 规则，得你确认这个目录可信后才生效，防止陌生仓库里一份配置就给自己开后门；但 `deny` 不受此限，立即生效（[security.md §4.1](./security.md)）。

## 11. 延伸阅读

| 想搞清楚什么                 | 去读                                |
| ---------------------------- | ----------------------------------- |
| 四档模式与产品边界           | [overview.md §1.2](./overview.md)   |
| 目标追达、循环续跑、自动批准 | [autonomy.md](./autonomy.md)        |
| 沙箱、权限分级、审批判定     | [security.md](./security.md)        |
| 停止/恢复/预算的状态机       | [agent-loop.md §5](./agent-loop.md) |
| 实现节奏与哪些能力尚未落地   | [roadmap.md](./roadmap.md)          |

> 再强调一次：本文是用户手册规格，命令与参数随实现演进，细节以 `mod --help` 为准。与某个专题的定论冲突时以那篇专题为准，本页负责把它们缝成一条"用户怎么敲"的线。
