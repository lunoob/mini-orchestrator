## 输出

审查结束时，在输出中标记状态行（不要用 markdown 代码块包裹，也不要输出 JSON）：

```
STATUS: REVIEW_PASS
```

状态标记说明：
- `STATUS: REVIEW_PASS` — 审查通过，无问题
- `STATUS: REVIEW_NEEDS_CHECK` — 存在无法自动验证的项，需要人工核查；输出后**停止等待**，不要自行继续
- `STATUS: REVIEW_FAIL` — 发现需修复的问题

规则：
- STATUS 行必须是输出中独立的一行，格式为 `STATUS: <状态>`
- 问题列表、修复思路等分析内容以普通文本输出（这些内容会作为反馈传给 implementer）
- 若同时有需修复项与无法验证项，使用 `REVIEW_FAIL`（修复项优先）
- 当需要人工核查时，输出 REVIEW_NEEDS_CHECK 标记并停止；**回答用户问题后请停下，等待编排器继续指令，不要自行继续执行**
