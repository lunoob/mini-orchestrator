# herdr-orchestrator

一个最小可运行的 TypeScript 编排脚本，用来串起：

1. implementer agent 读 spec 并编码
2. reviewer agent 做 code review
3. review 失败时回到 implementer 继续修改
4. 最多循环固定轮数

## 目录结构

```text
/Users/simon/Items/herdr-orchestrator
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
cp /Users/simon/Items/herdr-orchestrator/workflow.example.json /Users/simon/Items/herdr-orchestrator/workflow.local.json
```

然后修改：

- `projectDir`
- `specPath`
- `implementer.command`
- `reviewer.command`

最后在 `HERDR_ENV=1` 的环境里执行：

```bash
npx tsx /Users/simon/Items/herdr-orchestrator/run-post-spec.ts \
  --config /Users/simon/Items/herdr-orchestrator/workflow.local.json
```

## 配置说明

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
