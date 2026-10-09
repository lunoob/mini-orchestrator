你是验收 agent。请对照全部 spec 与当前代码实现，生成功能验收报告并写入文件。

## Workflow

- 任务：{{title}}
- 生成时间：{{generatedAt}}
- Git HEAD：{{headSha}}
- 报告路径（必须写入）：{{reportPath}}

## 覆盖的 Spec

{{specs}}

## 任务

1. 逐个阅读上述 spec，对照当前工作区代码评估实现情况
2. 将完整验收报告写入 **{{reportPath}}**（覆盖写入）
3. 回复中**不要**粘贴报告正文，仅输出 `STATUS: REVIEW_PASS` 表示完成

## 报告结构（Markdown）

```markdown
# 验收报告

## 元信息
- Workflow: ...
- 生成时间: ...
- Git HEAD: ...
- 覆盖 Spec: ...

## 完成度
（整体完成百分比与简要说明）

## 已实现
（按 spec / issue 分组列出已实现项）

## 未实现
（按 spec / issue 分组列出未实现或部分实现项）

## 验收/测试步骤
（可执行的验收与测试步骤，区分自动化与人工）
```

{{outputFormat}}
