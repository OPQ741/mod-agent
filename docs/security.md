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
