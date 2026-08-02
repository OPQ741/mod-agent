# Model Gateway · 模型接入与提示词管理

> 统一封装多模型差异，隔离 provider，是成本与质量的关键杠杆。

## 1. 模型适配层

```ts
interface ModelProvider {
  id: string;
  capabilities: {
    toolCalling: boolean;
    streaming: boolean;
    structuredOutput: boolean;
    vision: boolean;
  };
  generate(input: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
```

业务层只依赖统一的 `ModelRequest / ModelResponse`，每个 Provider 负责协议映射。统一处理：工具调用解析、内容块、流式结束原因、token 用量、请求 ID、限流、超时、错误分类、结构化输出与模型特定差异。MVP 先只接一个 Provider 建立可靠基线。

## 2. 模型路由策略

初期固定默认模型，之后按自己的评测数据考虑：

- 低风险摘要 / 简单分类用便宜模型；
- 复杂仓库推理与多文件修改用强编码模型；
- 大上下文 / 视觉需求选对应能力模型；
- 高成本模型触发前依据预算与任务风险决定；
- 故障切换必须重新校验工具调用与上下文兼容性，**不能假设不同模型工具行为一致**。

> 不要只看厂商公开榜单选默认模型。用自己的真实仓库任务集测成功率、延迟、成本、修复轮数与副作用风险。成本锚点参考：公开榜单上 agentic 修复平均约 \$0.86/题。

## 3. 提示词版本管理

- system policy、任务规划、工具说明、总结提示分层存放；
- 每个提示词带 `prompt_id`、`version`、`content_hash`；
- Trace 记录实际使用的版本与模型配置；
- Prompt 改动必须跑离线回归集；
- **仓库规则与 Skill 内容作为不可信 / 低信任上下文单独添加，不拼进 system policy 取得同等信任。**

## 4. 结构化输出

对计划、终止结论、风险分类与交付摘要用 Schema（Zod）约束；解析失败可有限重试或走安全失败路径。工具调用仍需执行端二次校验——**JSON 合法不等于权限合法**。
