第 {{round}} 轮审查。

上一轮指出的问题，已做了修改，验证修复是否正确。

## 状态信号

按下列优先级选择**一个**状态（互斥）：

- **通过**：`STATUS: REVIEW_PASS`
- **需人工核查**：`STATUS: REVIEW_NEEDS_CHECK`
- **不通过**：`STATUS: REVIEW_FAIL`

若同时有需修复项与 ⚠️ 项，输出 `STATUS: REVIEW_FAIL`（修复项优先）。

{{outputFormat}}
