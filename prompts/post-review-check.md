第 {{round}} 轮 review 结果为 **{{reviewStatus}}**。Review 已通过或进入需人工核查阶段；在流程继续前，请确认本次改动能通过项目的静态检查。

请先回顾当前实现进度记录，恢复上下文后再继续。

## 任务

检查并确保本次改动能通过 **TypeScript 类型检查** 与 **lint 检查**（若项目配置了其中任一项）。

### 如何探测

自行查看项目配置，例如：

- **TypeScript**：`tsconfig.json`、`package.json` 中的 `typecheck` / `tsc` 等 script
- **Lint**：`eslint.config.*`、`.eslintrc.*`、`biome.json`、`package.json` 中的 `lint` script 等

仅当项目**确实存在**对应配置或 script 时才运行；没有则跳过该项。

### 执行与修复

1. 运行探测到的 typecheck / lint 命令
2. 若有报错，修复后重新运行，直至通过或确认项目未配置该项
3. 修复仅针对类型与 lint 问题，不要扩大 scope 做无关重构
4. 及时 commit 修复

## 收尾工作
如果 Review 通过，一定要把代码 commit

## 工作约束

- 需要做修复并校验

## 输出要求

完成检查后，你必须输出一个**纯 JSON 对象**作为最终回复，不得包含任何说明文字、Markdown code fence 或 STATUS 标记。

### 检查通过或需要用户输入
```json
{
  "outcome": "completed",
  "summary": "静态检查通过"
}
```

### 需要用户输入（如不清楚使用哪条命令）
```json
{
  "outcome": "needs_input",
  "summary": "需要确认",
  "request": {
    "question": "要问用户的问题",
    "allowFreeform": true
  }
}
```

### 失败
```json
{
  "outcome": "failed",
  "summary": "检查失败",
  "failure": { "message": "错误详情" }
}
```