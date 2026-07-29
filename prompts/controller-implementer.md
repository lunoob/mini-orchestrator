第 {{round}} 轮 review 进入「需人工核查」（REVIEW_NEEDS_CHECK）。Controller / 人类核查后要求你补充处理或说明。

请先回顾实现进度记录（若有），确认当前完成状态后再继续。

## Controller 说明

{{controllerNotes}}

## Reviewer 原始输出

{{reviewOutput}}

## 工作约束

- 仅处理 Controller 说明与 reviewer 中**已确认的问题**；`⚠️ Cannot verify` 项若 Controller 未要求修改，不要猜测性大改
- **TDD**：若需新行为，先写失败测试

## 输出要求

完成工作后，你必须输出一个**纯 JSON 对象**作为最终回复，不得包含任何说明文字、Markdown code fence 或 STATUS 标记。

### 正常完成
```json
{
  "outcome": "completed",
  "summary": "简述完成的工作"
}
```

### 需要用户输入（如不清楚要求）
```json
{
  "outcome": "needs_input",
  "summary": "需要确认",
  "request": {
    "question": "要问的问题",
    "allowFreeform": true
  }
}
```
