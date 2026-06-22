# 上游来源

- 来源：https://github.com/obra/superpowers/tree/main/skills/test-driven-development
- 初始同步 commit：`main`（2026-06-22）
- 本地改动：
  - 全文译为中文
  - description 改为实现阶段自动适用（与 superpowers 上游一致）
  - 移除 `disable-model-invocation`（由 orchestrator 在 implement 阶段注入）
  - 「写了实现就删」改为：若已有实现，先补失败测试；若立刻通过，加强测试或重写

## 同步建议

1. 查看上游 `skills/test-driven-development/` 的变更
2. 更新 `references/upstream/`（若使用分层结构）或对照 diff 合并到本目录
3. 保留上述本地改动原则
