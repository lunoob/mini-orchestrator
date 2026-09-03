---
name: run-issue
description: >-
  基于已讨论完成的上下文与 issue 文档，生成编排器 issue 模式配置草案供用户确认，
  确认后保存配置文件并输出执行命令。
disable-model-invocation: true
---

# Issue 配置生成器

## 概述

根据当前上下文中的 issue 文档路径与讨论结论，整理出编排器的 `issue` 模式配置，供用户确认后使用。确认后保存配置文件并输出执行命令，由用户自行启动编排器。

## 输入

- 当前上下文中已讨论完成的一个或多个 issue 文档路径（`.md` 或其他可读格式）
- 讨论过程中确定的实施顺序
- 用户在讨论中约定的共同配置项（projectDir、agents、maxRounds 等）

## finalGate 策略

根据 `issues` 数量自动决定 `enableFinalGate`：

| `issues.length` | `enableFinalGate` | `agents` |
|-----------------|-------------------|----------|
| 1 | `false` | 仅 `implementer`、`reviewer` |
| ≥ 2 | `true` | 还需 `gateReviewer`、`gateFixer` |

- 单 issue：各 issue 阶段的 review + post-check 已足够，无需全局终审；acceptance 复用 issue reviewer session
- 多 issue：全部 issue 完成后需全局 finalGate 审查，再跑 acceptance（复用 gateReviewer session）

用户若在确认阶段明确要求覆盖默认策略，可按用户要求调整。

## 输出

输出一版编排器 `issue` 模式配置 JSON，格式如下：

```json
{
  "title": "<本次任务描述>",
  "projectDir": "<项目目录>",
  "issues": [
    {
      "title": "<Issue 标题>",
      "specPath": "<issue 文档绝对路径>"
    }
  ],
  "maxRounds": {
    "workflow": 30,
    "finalGate": 20
  },
  "enableFinalGate": "<见 finalGate 策略：1 个 issue 为 false，≥2 个为 true>",
  "enableAcceptanceReport": true,
  "agents": {
    "implementer": {
      "name": "implementer",
      "agent": "codex",
      "model": "gpt-5.6-luna",
      "effort": "xhigh"
    },
    "reviewer": {
      "name": "reviewer",
      "agent": "cursor",
      "model": "cursor-grok-4.6-high"
    },
    "gateReviewer": "<仅 enableFinalGate 为 true 时填写>",
    "gateFixer": "<仅 enableFinalGate 为 true 时填写>"
  }
}
```

- `title`：描述本次 workflow 任务，用于终端展示和系统通知
- `issues[]` 按顺序排列，对应编排器的串行执行顺序
- `issues[].title` 使用讨论中确定的 issue 名称（通常与 spec 文档标题一致）
- `specPath` 指向 issue 所对应的 spec 文档
- `projectDir` 使用当前的项目目录
- `enableFinalGate`：按 [finalGate 策略](#finalgate-策略) 填写，不要自行根据复杂度判断
- `enableAcceptanceReport`：默认 `true`；关闭后 workflow 结束时不生成验收报告
- `agents.gateReviewer` / `agents.gateFixer`：仅当 `enableFinalGate: true` 时出现在配置中
- 如出现其他配置项没提供，可以采用上述的配置做 fallback

## 工作流

生成配置草案 → 展示给用户确认（含 finalGate 说明）→ 用户确认后保存配置 → 输出执行命令

### 1. 展示草案并确认

向用户展示完整的配置草案，并**说明 finalGate 开启/关闭的原因**（issue 数量与是否需要全局终审），然后**询问是否确认**。允许用户请求修改。

说明示例：

- 单 issue：`本次仅 1 个 issue，已关闭 finalGate；单 issue 的 review + acceptance 即可覆盖验收。`
- 多 issue：`本次共 N 个 issue，已开启 finalGate；全部 issue 完成后需做全局审查，再输出验收报告。`

| 用户回答 | 行为 |
|----------|------|
| 需要修改 | 按用户要求修改后重新展示确认 |
| 确认 | 进入下一步——保存配置并输出执行命令 |

### 2. 保存配置

用户确认后，将配置文件保存到第一个 issue 的 `specPath` 所在目录，文件名为 `<Issue 标题>_workflow.issue.json`，
文件名最好使用蛇形命名法（snake_case），防止文件名出现空格等情况，导致程序识别错误。

> 例：若 `issues[0].specPath` 为 `/home/user/my-project/specs/db-schema.md`，则配置保存至 `/home/user/my-project/specs/db-schema_workflow.issue.json`。

记录 `CONFIG_PATH` = 已保存配置文件的**绝对路径**。

### 3. 输出执行命令

向用户输出以下命令，由用户自行在终端执行；本 skill 不代为启动编排器：

```bash
mini-orch --config "'"$CONFIG_PATH"'"
```

## 示例

### 输出草案（多 issue）

```json
{
  "title": "用户认证功能开发",
  "projectDir": "/home/user/my-project",
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
  "maxRounds": {
    "workflow": 8,
    "finalGate": 20
  },
  "enableFinalGate": true,
  "enableAcceptanceReport": true,
  "agents": {
    "implementer": {
      "name": "implementer",
      "agent": "cursor",
      "model": "composer-2.5"
    },
    "reviewer": {
      "name": "reviewer",
      "agent": "codex",
      "model": "gpt-5.6-luna",
      "effort": "high"
    },
    "gateReviewer": {
      "name": "final-reviewer",
      "agent": "codex",
      "model": "gpt-5.6-terra",
      "effort": "high"
    },
    "gateFixer": {
      "name": "final-fixer",
      "agent": "cursor",
      "model": "composer-2.5"
    }
  }
}
```

配套说明：`本次共 3 个 issue，已开启 finalGate；全部 issue 完成后做全局审查，再生成验收报告。`

### 保存路径示例

配置文件保存至：
```
/home/user/my-project/specs/数据库 Schema 搭建_workflow.issue.json
```

## 已知限制

- issues 按数组顺序串行执行，不做并行调度
- 任一 issue 进入 `REVIEW_FAIL` 耗尽轮数后，后续 issue 不执行
- 共用配置字段（projectDir、agents、maxRounds）在讨论中应一次性约定，skill 不会逐项提示
