# herdr-orchestrator

一个最小可运行的 TypeScript 编排脚本，用来串起：

1. implementer agent 读 spec 并编码
2. reviewer agent 做 code review
3. review 失败时回到 implementer 继续修改
4. 最多循环固定轮数

## 目录结构

```text
mini-orchestrator/
├── prompts
│   ├── implement.md
│   ├── review.md
│   └── revise.md
├── run-post-spec.ts
└── workflow.example.json
```

## 运行方式

先复制示例配置：

```bash
cp workflow.example.json workflow.local.json
```

然后修改：

- `projectDir`
- `specPath`
- `implementer.command`
- `reviewer.command`

最后在 `HERDR_ENV=1` 的环境里执行：

```bash
npx tsx run-post-spec.ts --config workflow.local.json
```

也可以用别名（默认读取当前目录下的 `workflow.local.json`）：

```bash
start-orchestrator
start-orchestrator --reuse-current-pane --specPath ./spec.md
```

### 复用当前 pane 作为 reviewer

如果希望 review 阶段直接使用当前 herdr pane（不再额外 `agent start` 一个 reviewer pane），在 reviewer pane 里运行脚本并加上 `--reuse-current-pane`：

```bash
npx tsx run-post-spec.ts \
  --config workflow.local.json \
  --reuse-current-pane
```

脚本会调用 `herdr pane current` 获取当前 pane 的 `pane_id`，并向该 pane 发送 review prompt。此模式下只会新建 implementer pane；`workflow.json` 里的 `reviewer` 配置不会被用来启动 agent，但建议保留以便切换回默认模式。

## CLI 参数

CLI 参数优先级高于 workflow 配置文件中的同名字段。

| 参数 | 必填 | 说明 |
|------|------|------|
| `--config` | 是 | workflow 配置文件的绝对或相对路径 |
| `--projectDir` | 否 | 项目目录，覆盖配置中的 `projectDir` |
| `--specPath` | 否 | spec 文件路径，覆盖配置中的 `specPath` |
| `--maxReviewRounds` | 否 | 最大 review 轮数，覆盖配置中的 `maxReviewRounds` |
| `--reuse-current-pane` | 否 | 复用当前 herdr pane 作为 reviewer，不新建 reviewer pane |

## 配置说明

`projectDir`、`specPath`、`maxReviewRounds` 可在配置文件中设置，也可通过 CLI 传入（CLI 优先）。至少需要为每个字段提供一种来源。

```json
{
  "projectDir": "/absolute/path/to/project",
  "specPath": "/absolute/path/to/spec.md",
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

## Prompt 模板变量

- `implement.md`
  - `{{specPath}}`
  - `{{maxReviewRounds}}`
- `review.md`
  - `{{round}}`
- `revise.md`
  - `{{round}}`
  - `{{reviewOutput}}`

## 当前限制

- 通过 `STATUS: IMPLEMENT_DONE`、`STATUS: REVIEW_PASS`、`STATUS: REVIEW_FAIL` 判断流程。
- 当前只支持一条固定工作流，不是通用任务编排引擎。
- `splitCommand` 只覆盖常见引号场景，复杂 shell 语法还不适合直接塞进 `command`。
