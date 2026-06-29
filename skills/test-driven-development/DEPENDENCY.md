# 外部依赖

本 skill **不内置于** mini-orchestrator。编排器在 implement 阶段从外部路径读取并注入 prompt 正文。

| 项 | 值 |
|----|-----|
| 路径 | `~/.agents/skills/test-driven-development/SKILL.md` |
| 作用 | TDD 铁律：先写失败测试、最少实现、红-绿-重构 |
| 辅助文档 | 同目录 `testing-anti-patterns.md`（由 SKILL 正文引用，implementer 按需阅读） |

安装与同步说明见仓库根目录 [README.md](../../README.md#skill-依赖)。
