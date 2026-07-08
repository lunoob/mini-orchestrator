已按照文档实现: {{specPath}}, 做下 review。
问题分点整理，只需要输出问题部分，不要输出其他内容。

## 状态信号（编排器读取）

按下列优先级选择**一个**状态（互斥）：

- **通过**：`STATUS: REVIEW_PASS`
- **需人工核查**：`STATUS: REVIEW_NEEDS_CHECK`
- **不通过**：`STATUS: REVIEW_FAIL`

若同时有需修复项与 ⚠️ 项，输出 `STATUS: REVIEW_FAIL`（修复项优先）。

## 输出
1. 先输出起始前缀: ---REVIEW_RESULT_START---
2. 再输出其他内容
3. 最后输出结束后缀: ---REVIEW_RESULT_END---
