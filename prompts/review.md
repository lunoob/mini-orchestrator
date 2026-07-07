已按照文档实现: {{specPath}}, 做下 review。
问题分点整理，只需要输出问题部分，不要输出其他内容。

## 状态信号（编排器读取）

按下列优先级选择**一个**状态（互斥）：

- **通过**（spec ✅、quality Approved、无 Critical/Important、无 ⚠️ Cannot verify）：`STATUS: REVIEW_PASS`
- **需人工核查**（无 Critical/Important、spec 未 ❌、quality 非 Needs fixes，但存在 ⚠️ Cannot verify）：`STATUS: REVIEW_NEEDS_CHECK`
- **不通过**（存在 Missing/Extra/Misunderstood、Critical、Important，或 quality Needs fixes）：`STATUS: REVIEW_FAIL`

若同时有需修复项与 ⚠️ 项，输出 `STATUS: REVIEW_FAIL`（修复项优先）。
