---
name: issue-config
description: 基于已讨论完成的上下文与 issue 文档，生成编排器 issue 模式配置草案供用户确认
disable-model-invocation: true
---

# Issue 配置生成器

## 概述

根据当前上下文中的 issue 文档路径与讨论结论，整理出编排器的 `issue` 模式配置，供用户确认后使用。

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

## 共用配置说明

除 `issues[]` 外，配置中的 `projectDir`、`implementer`、`reviewer`、`maxReviewRounds` 等字段应在讨论中约定一个共用值，避免每项 issue 重复填写。

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

## 已知限制

- issues 按数组顺序串行执行，不做并行调度
- 任一 issue 进入 `REVIEW_FAIL` 耗尽轮数后，后续 issue 不执行
- 共用配置字段（projectDir、implementer、reviewer）在讨论中应一次性约定，skill 不会逐项提示
