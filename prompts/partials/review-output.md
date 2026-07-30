## 输出

必须输出状态标记。在最终回复中，独占一行输出：

```
STATUS: <状态值>
```

合法状态：`REVIEW_PASS`、`REVIEW_FAIL`、`REVIEW_NEEDS_CHECK`

- `REVIEW_PASS`：review 通过
- `REVIEW_FAIL`：review 不通过
- `REVIEW_NEEDS_CHECK`：需人工核查

**重要：** 整段输出中只能有一个 STATUS 行。多个 STATUS 行或缺失 STATUS 行都会导致输出无效。
