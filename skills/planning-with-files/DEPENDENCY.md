# 外部依赖

本 skill **不内置于** mini-orchestrator。编排器在 implement 阶段从外部路径读取并注入 prompt 正文。

| 项 | 值 |
|----|-----|
| 路径 | 自动按 implementer 环境选择 |
| 作用 | 从 spec 派生 `task_plan.md`，用 `progress.md` / `findings.md` 持久化进度 |
| 运行时 | Cursor 侧 hooks 自动维护 planning 文件（需在真实项目中完成适配） |

自动选择规则：

- `codex` → `~/.codex/skills/planning-with-files/SKILL.md`
- `claude` → `~/.claude/plugins/marketplaces/planning-with-files/skills/planning-with-files/SKILL.md`
- `cursor` → `~/.cursor/skills/planning-with-files/SKILL.md`

安装与适配说明见仓库根目录 [README.md](../../README.md#skill-依赖)。
