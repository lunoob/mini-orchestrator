第 {{round}} 轮 review 未通过。

请先读取 `task_plan.md` 与 `progress.md` 恢复进度，再按下方反馈修改。

## Review 反馈

{{reviewOutput}}

## 接收反馈（必须遵循）

{{reviseSkills}}

## 修复优先级

1. **Critical** — 本轮必须全部修复
2. **Important** — 本轮必须全部修复
3. **Minor** — 顺手修；否则记入 `progress.md` 待后续处理

不清楚的反馈项：**先问清再动手**，不要猜。

## 工作约束

- **planning-with-files**：修复后更新 `task_plan.md` / `progress.md`
- **TDD**：新行为先写失败测试、确认失败、再写最少实现
- 逐项修复，每项修完跑相关测试
- 全部 Critical/Important 处理完毕且自审通过后，输出 `STATUS: IMPLEMENT_DONE`
