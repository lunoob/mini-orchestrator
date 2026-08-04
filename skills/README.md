# Skill 说明

mini-orch 自带以下 skill。可以使用 `mini-orch skill list` 查看，也可以按名称单独安装：

```bash
mini-orch skill install --skill <skill-name> --agent <agent-name>
```

## Skill 列表

| Skill | 作用 | 依赖 |
| --- | --- | --- |
| `test-driven-development` | 实现新功能、修复 bug 或重构时，先写失败测试，再用最少代码让测试通过。 | 无 |
| `writing-agent-issues` | 将讨论结论或 PRD 整理成可直接交给实现 agent 执行的 issue，并写入 `.agent-plans/`。 | `test-driven-development`（生成的 issue 要求实现 agent 使用） |
| `run-issue` | 根据已有 issue 文档生成编排器配置，确认后启动 issue 模式工作流。 | `writing-agent-issues`（推荐作为前置步骤；也可以直接使用已有 issue 文档） |
| `run-integration-tests` | 分析当前改动是否需要集成测试，并列出测试项和前置条件。 | 无 |

> `run-integration-tests` 是项目中的安装名称；它的 skill 元数据名称是 `evaluate-integration-tests`。

## 安装示例

安装完整工作流所需的 skill：

```bash
mini-orch skill install \
  --skill test-driven-development \
  --skill writing-agent-issues \
  --skill run-issue \
  --agent codex
```

只安装集成测试评估 skill：

```bash
mini-orch skill install --skill run-integration-tests --agent cursor
```

支持的 agent：`codex`、`claude-code`、`cursor`。不指定 `--skill` 或 `--agent` 时，命令会分别通过 Space 多选 skill 和 agent。
