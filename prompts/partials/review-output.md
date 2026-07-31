## 输出

**你的整个回复必须是一个 JSON 对象**（不要用 markdown 代码块包裹，不要包含 JSON 之外的文本）。

### 通过

{"outcome":"completed","summary":"Review 通过，无问题","review":{"verdict":"pass"},"report":"问题列表和修复思路..."}

### 不通过（需修复）

{"outcome":"completed","summary":"发现需修复的问题","review":{"verdict":"fail"},"report":"问题列表和修复思路..."}

### 需人工核查

{"outcome":"needs_input","summary":"无法自动验证","request":{"question":"具体无法验证的问题描述","allowFreeform":true},"report":"问题列表..."}

或等价地使用 `review.verdict: "needs_check"`：

{"outcome":"completed","summary":"部分项需人工判断","review":{"verdict":"needs_check"},"report":"问题列表..."}

### 失败

{"outcome":"failed","summary":"无法继续","failure":{"message":"具体失败原因"}}

字段说明：
- `outcome`（必填）：`"completed"` / `"needs_input"` / `"failed"`
- `summary`（必填）：简短描述
- `report`（建议）：问题列表、修复思路等详细分析
- `review`：`outcome: "completed"` 时必填，`verdict` 为 `"pass"` / `"fail"` / `"needs_check"`；可选 `cannotVerifySummary`
- `request`：`outcome: "needs_input"` 时必填，`question` 和 `allowFreeform` 必填
- `failure`：`outcome: "failed"` 时必填，`message` 必填

**重要：** 不要用 markdown 代码块。整个回复就是 JSON 本身。
