第 {{round}} 轮 review 未通过（存在需 implementer 修复的 Critical / Important 或 spec / quality 问题）。

请先回顾实现进度记录（若有），确认当前完成状态后再按下方反馈修改。

## Review 反馈

{{reviewOutput}}

## 修复优先级

1. **Critical** — 本轮必须全部修复
2. **Important** — 本轮必须全部修复
3. **Minor** — 顺手修；否则记入进度记录待后续处理

不清楚的反馈项：**先输出 `STATUS: IMPLEMENT_ASK` 并附上问题再等人工处理**，不要猜。

## 工作约束

- **TDD**：新行为先写失败测试、确认失败、再写最少实现
- 逐项修复，每项修完跑相关测试
- 全部 Critical/Important 处理完毕且自审通过后，输出 `STATUS: IMPLEMENT_DONE`
