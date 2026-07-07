---
name: issue-config
description: 基于已讨论完成的上下文与 issue 文档，生成编排器 issue 模式配置草案供用户确认
---

# Issue 配置生成器

## 概述

在讨论完成、issue 文档就绪后，手动调用此 skill，根据当前上下文中的 issue 文档路径与讨论结论，整理出编排器的 `issue` 模式配置，供用户确认后使用。

**核心原则：** 只生成配置，不替用户启动编排器。

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
  "maxReviewRounds": 4,
  "implementer": {
    "name": "implementer",
    "command": "<agent 命令>"
  },
  "reviewer": {
    "name": "reviewer",
    "command": "<agent 命令>"
  },
  "prompts": {
    "implement": "<implement prompt 路径>",
    "review": "<review prompt 路径>",
    "revise": "<revise prompt 路径>"
  }
}
```

- `issues[]` 按顺序排列，对应编排器的串行执行顺序
- `title` 使用讨论中确定的 issue 名称（通常与 spec 文档标题一致）
- `specPath` 指向 issue 所对应的 spec 文档

## 边界（不做什么）

- **不做需求澄清**：issue 应当已经在讨论中完全确认；skill 不承担「这个需求是什么」的分析工作
- **不写代码**：只生成配置，不实现 issue 中的任何功能
- **不启动编排器**：配置输出给用户确认后，由用户自行启动编排器
- **不修改已有配置**：生成的是新配置草案，不修改用户现有 `workflow.local.json`
- **不承诺并行**：第一版只输出串行顺序，不做并行调度

## 使用流程

1. 与用户/LLM 讨论完成所有 issue 文档与实施方案
2. 确认每个 issue 的 title 与 specPath
3. 手动调用此 skill（`/issue-config`）
4. skill 根据上下文整理出配置草案
5. 用户确认配置，或提出修改意见
6. 用户将确认后的配置保存为 `workflow.local.json`
7. 用户手动运行编排器：`npx tsx run-post-spec.ts --config workflow.local.json`

## 共用配置说明

除 `issues[]` 外，配置中的 `projectDir`、`implementer`、`reviewer`、`maxReviewRounds`、`prompts` 等字段应在讨论中约定一个共用值，避免每项 issue 重复填写。

## 示例

### 输入上下文

```
讨论结论：
  项目：/home/user/my-project
  issue 1: 数据库 schema 搭建 → specs/db-schema.md
  issue 2: API 端点实现 → specs/api-endpoints.md
  issue 3: 前端集成 → specs/frontend.md
  agent: implementer 用 cursor --model composer，reviewer 用 codex --model gpt-5.5
  prompts: 使用仓库默认
```

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
  "maxReviewRounds": 4,
  "implementer": {
    "name": "implementer",
    "command": "cursor --model composer"
  },
  "reviewer": {
    "name": "reviewer",
    "command": "codex --model gpt-5.5"
  },
  "prompts": {
    "implement": "./prompts/implement.md",
    "review": "./prompts/review.md",
    "revise": "./prompts/revise.md"
  }
}
```

## 已知限制

- issues 按数组顺序串行执行，不做并行调度
- 任一 issue 进入 `REVIEW_FAIL` 耗尽轮数后，后续 issue 不执行
- 共用配置字段（projectDir、implementer、reviewer）在讨论中应一次性约定，skill 不会逐项提示
