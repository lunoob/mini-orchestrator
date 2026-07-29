import { describe, expect, it } from "vitest"

import { parseAgentOutcome, formatAgentOutcome } from "@src/workflow/agent-outcome"

describe("testStatus outcome parsing", () => {
  it("parses completed outcome from agent output", () => {
    const outcome = formatAgentOutcome({
      outcome: "completed",
      summary: "佛山今天多云，气温 28°C",
    })

    const parsed = parseAgentOutcome(outcome, "implementer")
    expect(parsed.outcome).toBe("completed")
    expect(parsed.summary).toContain("佛山")
  })

  it("parses needs_input outcome", () => {
    const outcome = formatAgentOutcome({
      outcome: "needs_input",
      summary: "需要确认城市",
      request: {
        question: "查询哪个城市的天气？",
        allowFreeform: true,
      },
    })

    const parsed = parseAgentOutcome(outcome, "implementer")
    expect(parsed.outcome).toBe("needs_input")
    expect(parsed.request?.question).toContain("城市")
  })

  it("parses failed outcome", () => {
    const outcome = formatAgentOutcome({
      outcome: "failed",
      summary: "无法获取天气数据",
      failure: { message: "API 请求超时" },
    })

    const parsed = parseAgentOutcome(outcome, "implementer")
    expect(parsed.outcome).toBe("failed")
    expect(parsed.failure?.message).toContain("超时")
  })

  it("rejects invalid JSON format", () => {
    expect(() => parseAgentOutcome("这不是 JSON", "implementer")).toThrow(/JSON/i)
  })

  it("rejects output with STATUS markers", () => {
    // 旧格式应该被拒绝
    const oldFormat = `---IMPLEMENT_RESULT_START---
STATUS: IMPLEMENT_DONE
完成
---IMPLEMENT_RESULT_END---`
    expect(() => parseAgentOutcome(oldFormat, "implementer")).toThrow()
  })
})
