---
name: evaluate-integration-tests
description: >-
  分析当前代码改动，判断是否需要补充集成测试；若需要，列出所有集成测试项及前置条件。
  仅手动调用。Use when the user asks to evaluate integration test needs for current changes.
disable-model-invocation: true
---

# 任务
根据本次任务改动分析，判断现有单元测试是否足够，是否需要补充集成测试。输出结论、测试项清单与前置条件。

# 可询问
如果不清晰任务内容是什么，应该询问用户再继续
