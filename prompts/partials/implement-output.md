## 输出

必须输出状态标记。在最终回复中，独占一行输出：

```
STATUS: <状态值>
```

合法状态：`IMPLEMENT_DONE`、`IMPLEMENT_ASK`

- `IMPLEMENT_DONE`：完成全部实现且通过提交前自审
- `IMPLEMENT_ASK`：spec 不清楚，需要提问确认

**重要：** 整段输出中只能有一个 STATUS 行。多个 STATUS 行或缺失 STATUS 行都会导致输出无效。
