第 {{round}} 轮审查。

上一轮指出了需要修复的问题，实现 agent 已做了修改，本次请验证修复是否正确。

## 状态信号（编排器读取）

按下列优先级选择**一个**状态（互斥）：

- **通过**：`STATUS: REVIEW_PASS`
- **需人工核查**：`STATUS: REVIEW_NEEDS_CHECK`
- **不通过**：`STATUS: REVIEW_FAIL`

若同时有需修复项与 ⚠️ 项，输出 `STATUS: REVIEW_FAIL`（修复项优先）。

## 输出

1. 先输出起始前缀: ---REVIEW_RESULT_START---
2. 再输出审查结果（只输出问题列表，不要输出分析过程）
3. 最后输出结束后缀: ---REVIEW_RESULT_END---
