第 {{round}} 轮审查。

上一轮指出的问题，已做了修改，验证修复是否正确。

**你的整个回复必须是一个 JSON 对象**。将分析内容写入 `report` 字段。

## 状态信号

在 JSON 中标记**一个**状态：

- **通过**：`{"outcome":"completed","summary":"Review 通过","review":{"verdict":"pass"},"report":"分析..."}`
- **需人工核查**：`{"outcome":"needs_input","summary":"需人工核查","request":{"question":"无法自动验证的具体问题","allowFreeform":true},"report":"分析..."}`
- **不通过**：`{"outcome":"completed","summary":"发现需修复项","review":{"verdict":"fail"},"report":"分析..."}`

若同时有需修复项与 ⚠️ 项，使用 `verdict: "fail"`（修复项优先）。

{{outputFormat}}
