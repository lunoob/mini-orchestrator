## 输出

任务结束时（或需要询问用户时），在输出中标记状态行（不要用 markdown 代码块包裹，也不要输出 JSON）：

```
STATUS: IMPLEMENT_DONE
```

状态标记说明：
- `STATUS: IMPLEMENT_DONE` — 完成全部实现且通过提交前自审
- `STATUS: IMPLEMENT_ASK` — spec 或需求不清楚，需要向用户提问确认；输出后**停止等待**，不要自行继续
- `STATUS: IMPLEMENT_FAILED` — 无法继续执行

规则：
- STATUS 行必须是输出中独立的一行，格式为 `STATUS: <状态>`
- 其他内容（说明、进度、问题描述等）以普通文本输出即可
- 当需要用户决策/无法验证时，输出对应 ASK 标记并停止；**回答用户问题后请停下，等待编排器继续指令，不要自行继续执行**
