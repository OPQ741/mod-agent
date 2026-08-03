# Security · 沙箱、权限与安全架构

> Agent 天然要读不可信内容，prompt injection 是最高危的入口。这篇讲威胁模型、沙箱基线与安全验收。

## 1. 威胁模型

至少考虑：恶意 / 误导用户输入、仓库内 prompt injection、恶意依赖脚本、工具参数注入、路径穿越、符号链接逃逸、网络访问 / SSRF、密钥泄漏、资源耗尽、MCP Server 被攻陷、模型误生成危险命令、重试造成重复副作用。

## 2. 关键实证（为什么防护必须落框架层）

- **IssueTrojanBench**：66.5% 的恶意 issue 穿透 Cursor / Claude Code / Codex 全部 agent 与模型层防护；且拒绝几乎都来自 LLM 自身而非框架。靠 prompt 提示模型警惕基本无效。
- **真实事件**：Clinejection（恶意 issue 标题做 CI/CD 缓存投毒、外泄凭证）；RoguePilot（issue 隐藏 HTML 注释诱导仓库接管）；还有诱导 agent 写 `.vscode/settings.json` 开 `autoApprove` 持久化、诱导读私有仓库再经公开 PR 外送等。
- **Claude Code 漏洞教训**：Bash 子进程做了 Bubblewrap 沙箱，但 Read 工具未受同等约束，可读 `/proc/self/environ` 窃取 `ANTHROPIC_API_KEY`。环境 scrub 必须覆盖所有工具读取路径，不只是 Bash。
- **Agents Rule of Two**（Microsoft）：同时满足「读不可信输入 + 访问敏感密钥 + 对外变更/通信」三者是高危组合，不可同时成立。

## 3. 沙箱基线

- 每任务独立容器 / 更强隔离环境；工作目录只挂载该任务授权的工作区；
- 非 root 用户；rootless Docker、只读根文件系统、默认 seccomp、去除多余 capabilities；
- 限制 CPU、内存、进程数、磁盘、文件数、日志量、运行时长与并发；
- 默认关闭网络；确有装包需求时按域名 / IP / 端口及阶段临时开放出口；
- 不挂载 Docker Socket、宿主机 home、SSH agent、云凭证目录等高权限资源；
- 不向任务容器注入通用 API key；远程操作由服务端凭证代理执行；
- 命令与子进程做生命周期管理，取消时终止整个进程组；
- 对输出中的 ANSI 控制符、二进制、超长日志做处理，防终端 / UI 注入与资源耗尽。

### 3.1 沙箱安全与网络过滤的业界实证

**fail-closed（失败即关闭）原则（Devin 官方文档原文，出处：https://docs.devin.ai/cli/reference/configuration/config-file ）**：当隔离执行环境无法建立时（例如沙箱工具在平台不可用），CLI 应**拒绝启动任务**，而不是降级为裸跑——原文："If `--sandbox` is passed but sandbox resolution fails… the CLI will refuse to start rather than running unsandboxed." 这是「隔离意图永不被静默绕过」的安全底线。

**网络分级过滤（出处同上）**：

- `allowed_domains` 白名单（空 = 不过滤）、`denied_domains` 黑名单（**优先级更高**）、`network_mode`：`full`（全方法）/ `limited`（仅 GET / HEAD / OPTIONS）；
- 域名通配：`example.com` 精确、`*.example.com` 任意子域（不含 apex）、`.example.com` 含 apex 与任意子域；
- 与 §5 的 allowlist 互补：Devin 在本机 loopback 起受控代理，把所有联网请求按名单过滤，连「只能发 GET 不能 POST」都能限制。

**执行权限分三集合（Devin，出处同上）**：

```json
{ "permissions": {
    "allow": ["Read(**)", "Exec(git)"],
    "deny":  ["Exec(sudo)"],
    "ask":   ["Write(**/.env*)"] } }
```

- `allow` 自动放行 / `deny` 硬拒绝 / `ask` 每次弹确认；规则形如 `Read(...)` / `Write(...)` / `Exec(...)`；
- 配套开关 `respect_gitignore`：开启后禁止工具读写 gitignored 路径；
- 项目级可提交（团队共用）+ `*.local.json` gitignore（个人覆盖）分层。

**自治等级逐级放权（Factory Droid CLI 参考，出处：https://docs.factory.ai/droid-cli/cli-reference.md ）**：

| 等级 | 用途 | 放权内容 |
| --- | --- | --- |
| （默认） | 只读侦察 | 文件读取、git diff、环境检查 |
| `--auto low` | 安全编辑 | 建 / 改文件、格式化、非破坏命令 |
| `--auto medium` | 本地开发 | 装依赖、build / test、本地 git commit |
| `--auto high` | CI/CD 编排 | git push、部署脚本、长时操作 |
| `--skip-permissions-unsafe` | 仅一次性隔离容器 | 移除全部护栏 |

官方注记："Only raise access when the environment is safe."——权限跟着环境危险度逐级解锁，默认只读。

**CI / 无人值守的最小面（Claude Code `--bare`，出处：https://code.claude.com/docs/en/headless ）**：CI 与脚本默认推荐 bare 模式——不自动加载 hooks / skills / 自定义命令 / subagent / 插件 / MCP / auto memory / CLAUDE.md，不读本机 OAuth 与钥匙串，必须显式给 API key；需要的设置用 `--settings <file|json>`、MCP 用 `--mcp-config` 显式注入。安全含义：避免「仓库里一份 `.mcp.json` 在你从未信任的文件夹里被静默执行」。

**agent 产出的工作流默认不自动跑（GitHub Copilot，出处：https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github ）**：Copilot 云端代理 push 后，GitHub Actions **默认不自动执行**——因为 workflow 可能有权限访问敏感密钥，而 agent 可能改过 `.github/workflows/`；需人亲眼看过改动后手动点「Approve and run workflows」。凡 agent 改动涉及工作流定义 / 密钥读取路径时，评审界面显式提示。

## 4. 命令执行层

不把模型生成的一整段文本交给有宿主机权限的 shell。接口采用可审查结构：

```ts
interface CommandRequest {
  executable: string;
  args: string[];
  cwd: string;                  // 必须位于授权工作区
  env?: Record<string, string>; // 仅白名单变量
  timeoutMs: number;
  networkProfile: "none" | "package_registry" | "approved_domains";
  reason: string;
}
```

确需 shell 的 package scripts 在沙箱内执行，靠命令风险分类、网络策略与容器权限约束。shell 字符串安全不只是引号转义问题。破坏性命令硬策略拒绝或人工审批，不依赖模型自我约束。

### 4.1 配置优先级与权限规则合并（Claude Code settings 实证，出处：https://code.claude.com/docs/en/settings ）

配置分层（高 → 低）：**托管策略 > 命令行 `--settings` > 团队 `.mod/settings.json` > 用户 `~/.mod/settings.json` > 项目 `settings.local.json`**。

权限规则合并语义：

- `allow` 列表跨层取**并集**；`deny` / `ask` 优先且**立即生效**（不需要信任文件夹）；
- 团队提交的 `allow` 规则需用户「信任文件夹」后才生效；`deny` 不受此限——即「团队可以放权，但绝不能越权替你解禁」；
- 个人例外写 `settings.local.json`，自动加进 git exclude，不污染团队。

**命令层的前缀双表（Kilo Code 实证，出处：https://kilo.ai/docs/features/auto-approving-actions ）**：自动执行终端命令用「前缀白名单 + 前缀黑名单」两张表，**黑名单永远优先**——即使白名单写了 `*`（放开全部）也照样拦下；危险前缀（sudo、rm -rf 类）应主动进黑名单；生产 / 敏感数据场景禁止 `*`。

## 5. 网络、密钥与外部数据

- 外网域名走 allowlist，拒绝云元数据地址、localhost / 私有网段；区分公司内网白名单与普通互联网；
- 密钥只在需要的服务端工具中短暂使用；日志与模型上下文做脱敏；secret 不写工作区或命令行参数；
- MCP Server 用最小 OAuth scope，校验来源，必要时独立网络出口；
- 文件内容、MCP 工具描述、模型输出都不等于可信策略；策略引擎独立判定权限；
- 所有写入、命令、外部调用都写审计事件，含操作者、任务、工具、参数摘要、审批关联与结果。

## 6. 安全验收清单

- [ ] 无法读取工作区之外的任意文件；
- [ ] 无法访问被禁主机目录、Docker Socket 与凭证；
- [ ] 网络关闭时出网失败；allowlist 外域名访问失败；
- [ ] 提示注入无法使 Agent 读密钥或绕过工具授权；
- [ ] 拒绝审批后不会继续执行该动作；
- [ ] 取消任务后不再启动新命令；
- [ ] 多任务之间无目录、凭证、事件、产物越权；
- [ ] 通过故障注入验证恢复能力：超时、重复消息、Worker 崩溃、队列重复投递。
