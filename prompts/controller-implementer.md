第 {{round}} 轮 review 进入「需人工核查」（REVIEW_NEEDS_CHECK）。Controller / 人类核查后要求你补充处理或说明。

请先读取 `task_plan.md` 与 `progress.md` 恢复进度。

## Controller 说明

{{controllerNotes}}

## Reviewer 原始输出

{{reviewOutput}}

## 接收反馈（必须遵循）

{{reviseSkills}}

## 工作约束

- 仅处理 Controller 说明与 reviewer 中**已确认的问题**；`⚠️ Cannot verify` 项若 Controller 未要求修改，不要猜测性大改
- **planning-with-files**：处理后更新 `task_plan.md` / `progress.md`
- **TDD**：若需新行为，先写失败测试
- 完成后输出 `STATUS: IMPLEMENT_DONE`
