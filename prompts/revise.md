第 {{round}} 轮 review 未通过。
请先回顾实现进度记录（若有），确认当前完成状态后再按下方反馈修改。

## Review 反馈
issue 标签中包含了反馈的问题和解决思路，按照提到的问题和思路进行修复:

<issue>
{{reviewOutput}}
</issue>

## 工作约束
- 逐项修复，每项修完跑相关测试
- 禁止自动执行 git commit 完成代码提交

## 输出要求

完成修复后，你必须输出一个**纯 JSON 对象**作为最终回复，不得包含任何说明文字、Markdown code fence 或 STATUS 标记。

JSON 格式：
```json
{
  "outcome": "completed",
  "summary": "简述修复内容"
}
```
