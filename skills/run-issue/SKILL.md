---
name: run-issue
description: 基于已讨论完成的上下文与 issue 文档，生成编排器 issue 模式配置草案供用户确认，确认后保存配置并启动编排器
disable-model-invocation: true
---

# Issue 配置生成器

## 概述

根据当前上下文中的 issue 文档路径与讨论结论，整理出编排器的 `issue` 模式配置，供用户确认后使用。确认后保存配置文件，并自动启动编排器执行。

## 输入

- 当前上下文中已讨论完成的一个或多个 issue 文档路径（`.md` 或其他可读格式）
- 讨论过程中确定的实施顺序
- 用户在讨论中约定的共同配置项（projectDir、implementer、reviewer 等）

## 输出

输出一版编排器 `issue` 模式配置 JSON，格式如下：

```json
{
  "projectDir": "<项目目录>",
  "mode": "issue",
  "issues": [
    {
      "title": "<Issue 标题>",
      "specPath": "<issue 文档绝对路径>"
    }
  ],
  "maxReviewRounds": "<number>",
  "implementer": {
    "name": "implementer",
    "command": "<agent 命令>"
  },
  "reviewer": {
    "name": "reviewer",
    "command": "<agent 命令>"
  }
}
```

- `issues[]` 按顺序排列，对应编排器的串行执行顺序
- `title` 使用讨论中确定的 issue 名称（通常与 spec 文档标题一致）
- `specPath` 指向 issue 所对应的 spec 文档
- `projectDir` 使用当前的项目目录
- `maxReviewRounds` 没有提供则使用 8
- `implementer` 没有提供则使用 "claude --model haiku"
- `reviewer` 没有提供则使用 "codex --model gpt-5.4"

## 工作流

生成配置草案 → 展示给用户确认 → 用户确认后保存配置 → 自动启动编排器

### 1. 展示草案并确认

向用户展示完整的配置草案，并**询问是否确认**。允许用户请求修改。

| 用户回答 | 行为 |
|----------|------|
| 需要修改 | 按用户要求修改后重新展示确认 |
| 确认 | 进入下一步——保存配置并启动编排器 |

### 2. 保存配置

用户确认后，将配置文件保存到第一个 issue 的 `specPath` 所在目录，文件名为 `<Issue 标题>_workflow.issue.json`。

> 例：若 `issues[0].specPath` 为 `/home/user/my-project/specs/db-schema.md`，则配置保存至 `/home/user/my-project/specs/db-schema_workflow.issue.json`。

记录 `CONFIG_PATH` = 已保存配置文件的**绝对路径**。

### 3. 启动编排器

使用 `start-orchestrator` 启动编排器，传入已保存的配置文件：

```bash
zsh -ic 'start-orchestrator \
  --config "'"$CONFIG_PATH"'" \
  --needs-check-mode llm'
```

> `start-orchestrator` 在 implement / review 阶段会通过 herdr **阻塞等待** Herdr pane 内的 implementer / reviewer agent 完成；此期间脚本**几乎不向 stdout 输出**。这是正常行为，**不等于卡住**。

等待期间**不要**向用户反复发送状态旁白，**不要**去读项目文件探查进度；仅以 exit code 为准。若用户主动询问，简短说明即可。

## 示例

### 输出草案

```json
{
  "projectDir": "/home/user/my-project",
  "mode": "issue",
  "issues": [
    {
      "title": "数据库 Schema 搭建",
      "specPath": "/home/user/my-project/specs/db-schema.md"
    },
    {
      "title": "API 端点实现",
      "specPath": "/home/user/my-project/specs/api-endpoints.md"
    },
    {
      "title": "前端集成",
      "specPath": "/home/user/my-project/specs/frontend.md"
    }
  ],
  "maxReviewRounds": 8,
  "implementer": {
    "name": "implementer",
    "command": "claude --model haiku"
  },
  "reviewer": {
    "name": "reviewer",
    "command": "codex --model gpt-5.4"
  }
}
```

### 保存路径示例

配置文件保存至：
```
/home/user/my-project/specs/数据库 Schema 搭建_workflow.issue.json
```

## 已知限制

- issues 按数组顺序串行执行，不做并行调度
- 任一 issue 进入 `REVIEW_FAIL` 耗尽轮数后，后续 issue 不执行
- 共用配置字段（projectDir、implementer、reviewer）在讨论中应一次性约定，skill 不会逐项提示
