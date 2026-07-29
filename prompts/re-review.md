第 {{round}} 轮审查。

上一轮指出的问题，已做了修改，验证修复是否正确。

## 输出要求

审查完成后，你必须输出一个**纯 JSON 对象**作为最终回复，不得包含任何说明文字、Markdown code fence 或 STATUS 标记。

JSON 格式：

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
  "summary": "审查不通过",
  "review": { "verdict": "fail" },
  "report": "详细问题列表"
}
```

### 需人工核查
```json
{
  "outcome": "completed",
  "summary": "需人工核查",
  "review": {
    "verdict": "needs_check",
    "cannotVerifySummary": "无法验证的项"
  }
}
```

若同时有需修复项与 ⚠️ 项，verdict 选择 `fail`（修复项优先）。
