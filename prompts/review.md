已按照文档实现: {{specPath}}, 做下 review, 不要检查构建的产物, 只检查源码。
问题分点整理，同时给出修复思路，不需要给具体实现，不要输出其他内容。

## 输出要求

审查完成后，你必须输出一个**纯 JSON 对象**作为最终回复，不得包含任何说明文字、Markdown code fence 或 STATUS 标记。

JSON 格式如下：

### 通过
```json
{
  "outcome": "completed",
  "summary": "审查通过",
  "review": { "verdict": "pass" }
}
```

### 不通过
```json
{
  "outcome": "completed",
  "summary": "审查不通过，列出主要问题",
  "review": { "verdict": "fail" },
  "report": "详细问题列表和修复思路"
}
```

### 需人工核查
当有无法从 diff 中确认的项时：
```json
{
  "outcome": "completed",
  "summary": "部分项需人工核查",
  "review": {
    "verdict": "needs_check",
    "cannotVerifySummary": "无法验证的项说明"
  },
  "report": "详细审查结果"
}
```

若同时有需修复项与 ⚠️ 项，verdict 选择 `fail`（修复项优先）。
