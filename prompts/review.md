已按照文档实现: {{specPath}}, 做下 review, 不要检查构建的产物, 只检查源码。
问题分点整理，同时给出修复思路，不需要给具体实现，不要输出其他内容。

## 状态信号

按下列优先级选择**一个**状态（互斥）：

- **通过**：`STATUS: REVIEW_PASS`
- **需人工核查**：`STATUS: REVIEW_NEEDS_CHECK`
- **不通过**：`STATUS: REVIEW_FAIL`

若同时有需修复项与 ⚠️ 项，输出 `STATUS: REVIEW_FAIL`（修复项优先）。

{{outputFormat}}
