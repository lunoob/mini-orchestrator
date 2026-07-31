已按照文档实现: {{specPath}}, 做下 review, 不要检查构建的产物, 只检查源码。

**你的整个回复必须是一个 JSON 对象**（不要包含 JSON 之外的任何文本）。将问题列表和修复思路写入 `report` 字段。

## 状态信号

按下列优先级选择**一个**状态（互斥），在 JSON 的 `review.verdict` 中标记：

- **通过**：`{"outcome":"completed","summary":"Review 通过","review":{"verdict":"pass"},"report":"问题列表和修复思路..."}`
- **需人工核查**：`{"outcome":"needs_input","summary":"需人工核查","request":{"question":"无法自动验证的具体问题","allowFreeform":true},"report":"问题列表..."}`
- **不通过**：`{"outcome":"completed","summary":"发现需修复项","review":{"verdict":"fail"},"report":"问题列表和修复思路..."}`

若同时有需修复项与 ⚠️ 项，使用 `verdict: "fail"`（修复项优先）。

{{outputFormat}}
