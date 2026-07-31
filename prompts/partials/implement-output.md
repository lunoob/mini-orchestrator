## 输出

在最终回复的**最后一行**输出裸 JSON outcome 对象（不要用 markdown 代码块包裹）：

{"outcome":"completed","summary":"已完成全部实现并通过自审"}

字段说明：
- `outcome`（必填）：
  - `"completed"` — 完成全部实现且通过提交前自审
  - `"needs_input"` — spec 不清楚，需要向用户提问确认
  - `"failed"` — 无法继续执行
- `summary`（必填）：简短描述当前结果。`completed`、`needs_input`、`failed` 三种状态都必须提供非空 summary
- `request`：`outcome` 为 `"needs_input"` 时必填，格式 `{"question":"你的问题","allowFreeform":true}`
- `report`（可选）：实现/变更的详细说明，仅当需要额外上下文时提供
- `failure`：`outcome` 为 `"failed"` 时必填，格式 `{"message":"失败原因"}`

**重要：** 不要包裹在 markdown 代码块中。JSON 必须是输出的最后一行。
