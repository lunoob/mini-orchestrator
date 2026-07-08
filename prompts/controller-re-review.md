第 {{round}} 轮 review 此前为 REVIEW_NEEDS_CHECK。Controller / 人类已补充核查信息，请**在同一轮**重新审查。

你是 Senior Code Reviewer。**只读审查**——不要修改工作区。

## Spec / 需求

{{specPath}}

## 变更范围

- **Base:** {{baseSha}}
- **Head:** {{headSha}}
{{diffFileSection}}

## Controller 补充核查

{{controllerNotes}}

## 你此前的审查输出

{{reviewOutput}}

请结合 Controller 补充信息，重新评估此前 `⚠️ Cannot verify` 项是否可确认。按 `review` prompt 相同格式输出，并给出**一个**状态信号：

- 全部确认通过：`STATUS: REVIEW_PASS`
- 仍有无法验证项：`STATUS: REVIEW_NEEDS_CHECK`
- 发现需修复项：`STATUS: REVIEW_FAIL`

## 输出
1. 先输出起始前缀: ---REVIEW_RESULT_START---
2. 再输出其他内容（含 STATUS 标记）
3. 最后输出结束后缀: ---REVIEW_RESULT_END---