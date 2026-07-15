# mini-orchestrator

在 Herdr pane 内运行的最小 TypeScript 编排脚本，串起 implementer 与 reviewer agent：

1. implementer 读 spec 并完成编码
2. 编排器生成 **review package**（git diff 文件），交给 reviewer
3. reviewer 审查后输出状态信号（`REVIEW_PASS` / `REVIEW_FAIL` / `REVIEW_NEEDS_CHECK`）
4. review 失败时回到 implementer，按 review 反馈修复
5. 最多循环固定轮数

支持 **issue 队列模式**：按 `issues[]` 数组顺序串行执行多个 issue，每个 issue 使用独立的 agent 对，issue 间通过 git baseline 隔离变更。

Review 流程设计参考 [superpowers](https://github.com/obra/superpowers) 的 `requesting-code-review` / `subagent-driven-development`。

## 目录结构

```text
mini-orchestrator/
├── src/
│   ├── agent/
│   │   ├── index.ts           # herdr 封装：start / send / sendTaskAndWait / waitForIdle
│   │   ├── subprocess.ts      # herdr 子进程调用
│   │   └── session.ts         # 工作流 session 目录管理
│   ├── cli/
│   │   └── index.ts           # 参数解析与 --help
│   ├── config/
│   │   └── load.ts            # 配置与 prompt 加载
│   ├── git/
│   │   └── index.ts           # git 基线与命令封装
│   ├── lib/
│   │   ├── prompt-delimiters.ts  # 输出分隔符常量
│   │   └── utils.ts           # STATUS 解析、verdict、模板渲染
│   ├── notify/
│   │   └── index.ts           # 工作流结束通知
│   ├── review/
│   │   ├── checkpoint.ts      # needs_check checkpoint 读写
│   │   ├── needs-check.ts     # REVIEW_NEEDS_CHECK 交互与 LLM 暂停
│   │   └── package.ts         # 生成 diff 审查包
│   ├── skills/
│   │   └── install-skill.ts   # skill 安装/卸载核心逻辑
│   ├── workflow/
│   │   ├── index.ts           # 工作流入口
│   │   ├── issues.ts          # issue 队列调度
│   │   ├── review-context.ts  # review 上下文与 baseline
│   │   ├── review-loop.ts     # review / revise / needs_check 循环
│   │   ├── resume.ts          # checkpoint 恢复
│   │   └── types.ts           # workflow 内部类型
│   ├── main.ts                # CLI 入口
│   └── types.ts
├── prompts/
│   ├── implement.md
│   ├── review.md
│   ├── revise.md
│   ├── re-review.md
│   ├── controller-implementer.md   # needs_check → revise 专用
│   ├── controller-re-review.md     # needs_check → retry-review 专用
│   ├── post-review-check.md        # REVIEW_PASS / NEEDS_CHECK 后 typecheck / lint
│   └── partials/
│       ├── implement-output.md     # implement 类 prompt 输出格式
│       └── review-output.md        # review 类 prompt 输出格式
├── scripts/
│   └── install-skill.ts       # skill 安装 CLI 入口
├── skills/
│   └── run-issue/
│       └── SKILL.md           # 生成 issue 配置草案
├── run-post-spec.ts           # CLI 入口（薄包装，实际逻辑在 src/）
├── workflow.example.json
├── workflow.issue.example.json
├── vitest.config.ts
└── package.json
```

运行时会在 `projectDir/.orchestrator/` 下生成：

| 文件/目录 | 时机 |
|-----------|------|
| `review-round-{n}-{timestamp}.md` | 每轮 review 前 |
| `needs-check-round-{n}-{timestamp}.json` | LLM 模式下 REVIEW_NEEDS_CHECK 暂停时 |

### 任务完成检测

编排器通过 **Herdr agent 状态** 判断 agent 是否完成当前轮次，再从 pane output 解析 `STATUS:` 驱动流程分支：

1. `sendTask` 发送 prompt
2. `herdr agent wait --status working` 确认 prompt 已被接收（超时未进入 working 会重发一次）
3. `herdr agent wait --status idle` 等待 agent 完成（含 2 秒缓冲 + `agent list` 二次确认）
4. `readAgentOutput` 读取 pane 最近输出（默认 280 行）
5. 从分隔符块（`---IMPLEMENT_RESULT_START---` / `---REVIEW_RESULT_START---` 等）内解析 `STATUS:`

| 角色 | 输出分隔符 | 状态标记 |
|------|-----------|----------|
| implementer | `---IMPLEMENT_RESULT_START---` … `END---` | `IMPLEMENT_DONE` / `IMPLEMENT_ASK` |
| reviewer | `---REVIEW_RESULT_START---` … `END---` | `REVIEW_PASS` / `REVIEW_FAIL` / `REVIEW_NEEDS_CHECK` |

任务完成超时为 30 分钟（`waitForIdle` 默认超时）。

## Issue 队列

配置文件通过顶层的 `issues[]` 数组定义多个阶段：

```json
{
  "issues": [
    { "title": "Step 1: Setup database schema",  "specPath": "/path/to/specs/db-schema.md" },
    { "title": "Step 2: Implement API endpoints", "specPath": "/path/to/specs/api-endpoints.md" }
  ]
}
```

- issue 按数组顺序**串行**执行
- 每个 issue 创建一对全新的 implementer + reviewer agent，issue 完成后销毁
- 当前 issue 的 review 通过后，git baseline 推进到 `HEAD`，后续 issue 的 diff 只包含其自身变更
- 任一 issue 耗尽 review 轮数后，整个工作流停止，后续 issue 不执行
- `needs_check` 暂停后 resume，继续的是当前 issue（而非跳到下一个）

## Review 流程

```mermaid
flowchart TD
    A[记录 baseline SHA] --> B[Implementer 实现]
    B --> C[生成 review package]
    C --> D[Reviewer 审查]
    D -->|REVIEW_PASS| E0[Implementer 跑 typecheck / lint]
    E0 --> E[完成 exit 0]
    D -->|REVIEW_FAIL| F[Implementer revise]
    F --> G{已达最大轮数?}
    G -->|否| C
    G -->|是| H[失败 exit 1]
    D -->|REVIEW_NEEDS_CHECK| I0[Implementer 跑 typecheck / lint]
    I0 --> I{needs-check-mode}
    I -->|interactive| J[终端询问 4 选 1]
    I -->|llm| K[写 checkpoint 并退出 exit 2]
    K --> L[外层 agent 问用户]
    L --> M[--resume-from 恢复]
    J --> N{用户选择}
    M --> N
    N -->|approve| E
    N -->|abort| H
    N -->|revise| O[controller 说明 → implementer]
    N -->|retry-review| P[同轮带补充上下文重审]
    O --> C
    P --> D
```

每轮 review 前，编排器在 `projectDir/.orchestrator/` 生成 diff 审查包。基线为工作流启动时的 `HEAD`（若当时尚无 commit，则从 git 空树 SHA 对比到当前 `HEAD`）。reviewer **先读该文件**再审查。

### Review package 内容

审查包为 Markdown，通常包含：

- **Commits** — `base..head` 范围内的 commit 列表
- **Diff Stat / Diff** — 完整 diff（`-U10` 上下文）
- **Uncommitted Changes**（若有）— `git status`、工作区与暂存区的 stat / diff

非 git 项目或无法生成 diff 时，review prompt 会降级为提示 reviewer 直接审查工作区改动。

### 审查结果

Reviewer 通过输出 `STATUS: REVIEW_PASS` / `REVIEW_FAIL` / `REVIEW_NEEDS_CHECK` 标记状态。编排器只解析这些显式标记和 `⚠️ Cannot verify from diff:` 段落，不做内容启发式判断。

| 状态 | 含义 | 编排器行为 |
|------|------|------------|
| `REVIEW_PASS` | 审查通过 | implementer 校验 typecheck / lint（若有）→ 结束 |
| `REVIEW_NEEDS_CHECK` | reviewer 无法仅从 diff 验证部分要求 | implementer 校验 typecheck / lint（若有）→ 暂停并询问用户（见下） |
| `REVIEW_FAIL` | 存在需修复项 | 发回 implementer revise，进入下一轮 review |

### REVIEW_NEEDS_CHECK 交互

Reviewer 无法从 diff 单独验证的项**不等于实现缺陷**。编排器会暂停并展示 4 个选项：

| 选项 | 含义 |
|------|------|
| `approve` | 人工确认通过，结束工作流 |
| `revise` | 补充说明后发回 implementer（需填写说明），**下一轮** review |
| `retry-review` | 带补充上下文让 reviewer **同轮**重审（需填写说明，不计入新轮次） |
| `abort` | 中止工作流 |

**默认模式（`--needs-check-mode interactive`）**：脚本在终端打印选项并等待输入，选完后继续执行。

**LLM 模式（`--needs-check-mode llm`）**：脚本写入 `projectDir/.orchestrator/needs-check-round-*.json` checkpoint，输出 `STATUS: ORCHESTRATOR_NEEDS_CHECK` 与 `CHECKPOINT: <path>`，以 **exit code 2** 退出。外层 agent 询问用户后，用 `--resume-from` 带上用户选择继续：

```bash
start-orchestrator \
  --resume-from "$PROJECT_DIR/.orchestrator/needs-check-round-1-....json" \
  --needs-check-action retry-review \
  --needs-check-notes "已在本地跑通 E2E，行为符合 spec"
```

恢复时 `--config` 可省略（checkpoint 内保存了 `configPath`）；`revise` 从下一轮继续 review，`retry-review` 在同一轮用 `controller-re-review` prompt 重审。

`approve` 当前 issue 后，若队列中还有后续 issue，编排器会自动继续执行下一项。

### Review 通过后静态检查

当 reviewer 输出 `REVIEW_PASS` 或 `REVIEW_NEEDS_CHECK` 后，编排器会向 implementer 发送 `post-review-check` prompt，要求其自行探测并运行项目的 TypeScript 类型检查与 lint（若存在对应配置或 `package.json` script）。implementer 负责修复问题并重复校验；编排器**不解析**检查输出，仅以 `IMPLEMENT_DONE` / `IMPLEMENT_ASK` 判断任务是否结束。

`REVIEW_NEEDS_CHECK` 时，静态检查在暂停询问用户**之前**执行，避免把类型或 lint 问题留给人工核查。

## 运行方式

先复制示例配置并修改其中的 `projectDir`、`issues[].specPath`、`implementer.command`、`reviewer.command`：

```bash
cp workflow.issue.example.json workflow.local.json
```

然后运行：

```bash
pnpm tsx run-post-spec.ts --config workflow.local.json
pnpm tsx run-post-spec.ts --help          # 不需要 HERDR_ENV=1
pnpm start -- --config workflow.local.json  # 等价于 tsx ./src/main.ts
```

也可以用别名（若 shell 已配置 `start-orchestrator` 指向 `run-post-spec.ts`，默认读取当前目录下的 `workflow.local.json`）：

```bash
start-orchestrator
```

### 退出码

| Code | 含义 |
|------|------|
| `0` | 工作流正常结束（review 通过或人工 approve） |
| `1` | 失败（配置错误、review 耗尽轮数、用户 abort 等） |
| `2` | LLM 模式下 REVIEW_NEEDS_CHECK 暂停，等待 `--resume-from` |

## CLI 参数

CLI 参数优先级高于 workflow 配置文件中的同名字段。

| 参数 | 必填 | 说明 |
|------|------|------|
| `--config` | 首次启动必填；resume 时可省略 | workflow 配置文件的绝对或相对路径 |
| `--projectDir` | 否 | 项目目录，覆盖配置中的 `projectDir` |
| `--maxReviewRounds` | 否 | 最大 review 轮数，覆盖配置中的 `maxReviewRounds`（默认 8） |
| `--needs-check-mode` | 否 | `interactive`（默认）或 `llm` |
| `--resume-from` | 否 | 从 needs_check checkpoint 恢复（需配合 `--needs-check-action`） |
| `--needs-check-action` | resume 时必填 | `approve` \| `revise` \| `retry-review` \| `abort` |
| `--needs-check-notes` | `revise` / `retry-review` 时必填 | 补充说明 |
| `-h`, `--help` | 否 | 显示使用帮助（不需要 `HERDR_ENV=1`） |

## 配置说明

```json
{
  "projectDir": "/absolute/path/to/project",
  "issues": [
    {
      "title": "Step 1: Setup database schema",
      "specPath": "/absolute/path/to/specs/db-schema.md"
    },
    {
      "title": "Step 2: Implement API endpoints",
      "specPath": "/absolute/path/to/specs/api-endpoints.md"
    }
  ],
  "maxReviewRounds": 4,
  "implementer": {
    "name": "implementer",
    "command": "cursor --model composer",
    "agentReadyPattern": "Cursor Agent"
  },
  "reviewer": {
    "name": "reviewer",
    "command": "codex --model gpt-5.5",
    "agentReadyPattern": "codex",
    "updateCommand": "codex update"
  },
  "prompts": {
    "implement": "./prompts/implement.md",
    "review": "./prompts/review.md",
    "revise": "./prompts/revise.md"
  }
}
```

`prompts.controllerImplementer`、`prompts.controllerReReview` 与 `prompts.postReviewCheck` 为可选项，省略时使用默认路径（见 `src/config/load.ts` 中的常量）。

`prompts.outputFormatImplement` / `prompts.outputFormatReview`（可选）：自定义 implement / review 类 prompt 的输出格式 partial。省略时使用 `prompts/partials/implement-output.md` 与 `prompts/partials/review-output.md`。partial 中可用 `{{delimiterStart}}`、`{{delimiterEnd}}` 占位符，加载时由编排器注入与解析逻辑一致的标记（见 `src/prompt-delimiters.ts`）。

`implementer.agentReadyPattern` / `reviewer.agentReadyPattern`（可选）：`agent start` 后、`send` 首条 prompt 前，除等待 `idle` 外，再用 `herdr wait output --match` 等待 pane 输出中出现该文本，避免 agent UI 尚未就绪时 prompt 丢失。任务完成后，编排器通过 `herdr agent wait --status idle` 判定完成，并从 output 解析 `STATUS:`。

常见示例：Cursor Agent 用 `"Cursor Agent"`，Codex 用 `"codex"` 或启动横幅中的特征字符串。省略时仅依赖 `idle` 状态等待。

`implementer.updateCommand` / `reviewer.updateCommand`（可选）：启动 agent 前先执行一次的命令。用于 agent 需要先 update 再启动的场景（如 `codex update`），避免 update 完成后 pane 关闭导致后续流程失败。仅 workflow 首次启动 agent 前执行一次；不会为每个 issue 重复执行。

## Prompt 模板变量

- `implement.md`
  - `{{specPath}}`
  - `{{maxReviewRounds}}`
- `review.md`
  - `{{round}}`
  - `{{specPath}}`
  - `{{baseSha}}` / `{{headSha}}`
  - `{{diffFileSection}}` — diff 文件路径或降级说明
- `revise.md`
  - `{{round}}`
  - `{{reviewOutput}}`
- `controller-implementer.md`
  - `{{round}}`
  - `{{controllerNotes}}`
  - `{{reviewOutput}}`
- `controller-re-review.md`
  - `{{round}}`
  - `{{specPath}}`
  - `{{baseSha}}` / `{{headSha}}`
  - `{{diffFileSection}}`
  - `{{controllerNotes}}`
  - `{{reviewOutput}}`
- `post-review-check.md`
  - `{{round}}`
  - `{{reviewStatus}}` — `REVIEW_PASS` 或 `REVIEW_NEEDS_CHECK`

## Skill 安装

仓库内 `skills/run-issue/` 提供了手动调用的技能。通过安装脚本可将 skill 部署到 `~/.agents/skills/`，注册为斜杠命令。

### 安装命令

```bash
pnpm run install-skill               # 以软链接安装
pnpm run install-skill -- --mode copy # 以复制模式安装
pnpm run install-skill -- --force     # 覆盖已有安装
```

安装目标：`~/.agents/skills/<skill-name>/`

软链接与复制模式的区别：

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| `symlink`（默认） | 在 `~/.agents/skills/` 创建指向仓库 `skills/` 的软链接 | 仓库更新后自动生效，无需重新安装 |
| `copy` | 将 skill 文件复制到 `~/.agents/skills/` | 目标环境无法创建软链接（如某些 CI、容器），或需要独立副本 |

### 卸载

```bash
pnpm run uninstall-skill             # 卸载软链接安装的 skill
pnpm run uninstall-skill -- --force   # 强制卸载（含复制模式目录）
```

## 开发

```bash
pnpm test            # vitest run
pnpm run typecheck   # tsc --noEmit
```

## 当前限制

- 流程推进由 **Herdr `agent_status`（working/idle）** 与 output 中的 `STATUS:` 标记共同驱动；不依赖任务状态文件或 `report-task` 命令。
- 任务完成超时为 30 分钟（`waitForIdle` 默认超时）。
- 后台 pane（`--no-focus`）上 `herdr agent wait` 的事件推送可能不可靠；若出现提前结束或长时间卡住，需检查 Herdr 版本与 pane 状态。
- Agent 输出须包含约定分隔符与 `STATUS:` 行；编排器从最后一组分隔符块内解析，未遵守格式时可能误判或仅 warn 后继续。
- `REVIEW_NEEDS_CHECK` 在 LLM 模式下依赖 checkpoint 恢复；resume 须复用原 implementer/reviewer pane（勿关闭 Herdr session）。
- 非 git 项目或尚无 commit 时，review package 仅含未提交变更说明；reviewer 审查工作区改动。
- Issue 队列为串行执行；并行调度不在此版本范围内。
- `splitCommand` 只覆盖常见引号场景，复杂 shell 语法还不适合直接塞进 `command`。
