已按照文档实现: {{specPath}}, 做下 review, 不要检查构建的产物, 只检查源码。

按下列优先级选择**一个**状态（互斥），输出对应 STATUS 标记：

- **通过**：`STATUS: REVIEW_PASS`
- **需人工核查**：`STATUS: REVIEW_NEEDS_CHECK`
- **不通过**：`STATUS: REVIEW_FAIL`

若同时有需修复项与无法验证项，使用 `STATUS: REVIEW_FAIL`（修复项优先）。

{{outputFormat}}
