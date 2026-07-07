第 {{round}} 轮 review 进入「需人工核查」（REVIEW_NEEDS_CHECK）。Controller / 人类核查后要求你补充处理或说明。

请先回顾实现进度记录（若有），确认当前完成状态后再继续。

## Controller 说明

{{controllerNotes}}

## Reviewer 原始输出

{{reviewOutput}}

## 工作约束

- 仅处理 Controller 说明与 reviewer 中**已确认的问题**；`⚠️ Cannot verify` 项若 Controller 未要求修改，不要猜测性大改
- **TDD**：若需新行为，先写失败测试
- 若不清楚 Controller 或 reviewer 的要求，先输出 `STATUS: IMPLEMENT_ASK` 并附上问题，不要猜测
- 完成后输出 `STATUS: IMPLEMENT_DONE`
