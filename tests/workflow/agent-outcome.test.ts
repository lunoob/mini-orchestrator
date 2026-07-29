import { describe, expect, it } from "vitest"

import {
  parseAgentOutcome,
  formatAgentOutcome,
  type AgentOutcome,
  type ImplementerOutcome,
  type ReviewerOutcome,
} from "@src/workflow/agent-outcome"

describe("parseAgentOutcome", () => {
  describe("implementer outcomes", () => {
    it("parses a valid completed outcome", () => {
      const json = JSON.stringify({
        outcome: "completed",
        summary: "实现完成",
      })
      const result = parseAgentOutcome(json, "implementer")
      expect(result).toEqual({
        outcome: "completed",
        summary: "实现完成",
      })
    })

    it("parses a valid needs_input outcome with request", () => {
      const json = JSON.stringify({
        outcome: "needs_input",
        summary: "需要确认",
        request: {
          question: "是否使用默认配置？",
          options: [
            { id: "yes", label: "是" },
            { id: "no", label: "否" },
          ],
          allowFreeform: false,
        },
      })
      const result = parseAgentOutcome(json, "implementer")
      expect(result).toEqual({
        outcome: "needs_input",
        summary: "需要确认",
        request: {
          question: "是否使用默认配置？",
          options: [
            { id: "yes", label: "是" },
            { id: "no", label: "否" },
          ],
          allowFreeform: false,
        },
      })
    })

    it("parses a valid failed outcome with failure message", () => {
      const json = JSON.stringify({
        outcome: "failed",
        summary: "实现失败",
        failure: { message: "无法找到依赖包" },
      })
      const result = parseAgentOutcome(json, "implementer")
      expect(result).toEqual({
        outcome: "failed",
        summary: "实现失败",
        failure: { message: "无法找到依赖包" },
      })
    })
  })

  describe("reviewer outcomes", () => {
    it("parses a valid completed outcome with pass verdict", () => {
      const json = JSON.stringify({
        outcome: "completed",
        summary: "审查通过",
        review: { verdict: "pass" },
      })
      const result = parseAgentOutcome(json, "reviewer")
      expect(result).toEqual({
        outcome: "completed",
        summary: "审查通过",
        review: { verdict: "pass" },
      })
    })

    it("parses a valid completed outcome with fail verdict", () => {
      const json = JSON.stringify({
        outcome: "completed",
        summary: "审查不通过",
        review: { verdict: "fail" },
      })
      const result = parseAgentOutcome(json, "reviewer")
      expect(result).toEqual({
        outcome: "completed",
        summary: "审查不通过",
        review: { verdict: "fail" },
      })
    })

    it("parses a valid completed outcome with needs_check verdict and cannotVerifySummary", () => {
      const json = JSON.stringify({
        outcome: "completed",
        summary: "部分无法验证",
        review: {
          verdict: "needs_check",
          cannotVerifySummary: "无法从 diff 中确认数据库迁移是否正确",
        },
      })
      const result = parseAgentOutcome(json, "reviewer")
      expect(result).toEqual({
        outcome: "completed",
        summary: "部分无法验证",
        review: {
          verdict: "needs_check",
          cannotVerifySummary: "无法从 diff 中确认数据库迁移是否正确",
        },
      })
    })
  })

  describe("validation errors", () => {
    it("rejects empty string", () => {
      expect(() => parseAgentOutcome("", "implementer")).toThrow(/为空/)
    })

    it("rejects non-JSON text", () => {
      expect(() => parseAgentOutcome("这不是JSON", "implementer")).toThrow(/JSON/i)
    })

    it("rejects JSON with surrounding text", () => {
      const text = '这是我的回答：\n{"outcome":"completed","summary":"完成"}\n以上。'
      expect(() => parseAgentOutcome(text, "implementer")).toThrow()
    })

    it("rejects markdown code fence containing JSON", () => {
      const text = '```json\n{"outcome":"completed","summary":"完成"}\n```'
      expect(() => parseAgentOutcome(text, "implementer")).toThrow()
    })

    it("rejects multiple JSON objects", () => {
      const text = '{"outcome":"completed","summary":"1"}\n{"outcome":"completed","summary":"2"}'
      expect(() => parseAgentOutcome(text, "implementer")).toThrow()
    })

    it("rejects when outcome field is missing", () => {
      const json = JSON.stringify({ summary: "完成" })
      expect(() => parseAgentOutcome(json, "implementer")).toThrow(/outcome/i)
    })

    it("rejects when summary field is missing", () => {
      const json = JSON.stringify({ outcome: "completed" })
      expect(() => parseAgentOutcome(json, "implementer")).toThrow(/summary/i)
    })

    it("rejects invalid outcome value", () => {
      const json = JSON.stringify({ outcome: "unknown", summary: "test" })
      expect(() => parseAgentOutcome(json, "implementer")).toThrow(/outcome/i)
    })

    it("rejects needs_input without request", () => {
      const json = JSON.stringify({ outcome: "needs_input", summary: "需要输入" })
      expect(() => parseAgentOutcome(json, "implementer")).toThrow(/request/i)
    })

    it("rejects failed without failure", () => {
      const json = JSON.stringify({ outcome: "failed", summary: "失败" })
      expect(() => parseAgentOutcome(json, "implementer")).toThrow(/failure/i)
    })

    it("rejects options with missing id", () => {
      const json = JSON.stringify({
        outcome: "needs_input",
        summary: "需要输入",
        request: {
          question: "选择？",
          options: [{ label: "A" }],
          allowFreeform: false,
        },
      })
      expect(() => parseAgentOutcome(json, "implementer")).toThrow(/id/i)
    })

    it("rejects options with non-string label", () => {
      const json = JSON.stringify({
        outcome: "needs_input",
        summary: "需要输入",
        request: {
          question: "选择？",
          options: [{ id: "a", label: 123 }],
          allowFreeform: false,
        },
      })
      expect(() => parseAgentOutcome(json, "implementer")).toThrow(/label/i)
    })

    it("rejects options with non-array type", () => {
      const json = JSON.stringify({
        outcome: "needs_input",
        summary: "需要输入",
        request: {
          question: "选择？",
          options: "not-an-array",
          allowFreeform: false,
        },
      })
      expect(() => parseAgentOutcome(json, "implementer")).toThrow(/options.*数组/)
    })

    it("rejects allowFreeform false without options", () => {
      const json = JSON.stringify({
        outcome: "needs_input",
        summary: "需要输入",
        request: {
          question: "选择？",
          allowFreeform: false,
        },
      })
      expect(() => parseAgentOutcome(json, "implementer")).toThrow(/allowFreeform.*false.*options/)
    })

    it("rejects allowFreeform false with empty options", () => {
      const json = JSON.stringify({
        outcome: "needs_input",
        summary: "需要输入",
        request: {
          question: "选择？",
          options: [],
          allowFreeform: false,
        },
      })
      expect(() => parseAgentOutcome(json, "implementer")).toThrow(/allowFreeform.*false.*options/)
    })

    it("allows allowFreeform true without options", () => {
      const json = JSON.stringify({
        outcome: "needs_input",
        summary: "需要输入",
        request: {
          question: "请输入？",
          allowFreeform: true,
        },
      })
      const result = parseAgentOutcome(json, "implementer")
      expect(result.outcome).toBe("needs_input")
    })

    it("rejects cannotVerifySummary with non-string type", () => {
      const json = JSON.stringify({
        outcome: "completed",
        summary: "审查",
        review: { verdict: "needs_check", cannotVerifySummary: 123 },
      })
      expect(() => parseAgentOutcome(json, "reviewer")).toThrow(/cannotVerifySummary/)
    })

    it("rejects non-string report", () => {
      const json = JSON.stringify({
        outcome: "completed",
        summary: "完成",
        report: 123,
      })
      expect(() => parseAgentOutcome(json, "implementer")).toThrow(/report/)
    })

    it("rejects non-string request.recommendation", () => {
      const json = JSON.stringify({
        outcome: "needs_input",
        summary: "需要输入",
        request: {
          question: "选择？",
          allowFreeform: false,
          recommendation: 123,
        },
      })
      expect(() => parseAgentOutcome(json, "implementer")).toThrow(/recommendation/)
    })

    it("rejects non-string request.inputHint", () => {
      const json = JSON.stringify({
        outcome: "needs_input",
        summary: "需要输入",
        request: {
          question: "选择？",
          allowFreeform: false,
          inputHint: 123,
        },
      })
      expect(() => parseAgentOutcome(json, "implementer")).toThrow(/inputHint/)
    })
  })

  describe("role validation", () => {
    it("rejects implementer outputting review verdict", () => {
      const json = JSON.stringify({
        outcome: "completed",
        summary: "完成",
        review: { verdict: "pass" },
      })
      expect(() => parseAgentOutcome(json, "implementer")).toThrow(/review/i)
    })

    it("rejects reviewer completed without review field", () => {
      const json = JSON.stringify({
        outcome: "completed",
        summary: "审查完成",
      })
      expect(() => parseAgentOutcome(json, "reviewer")).toThrow(/review/i)
    })

    it("rejects reviewer with invalid verdict value", () => {
      const json = JSON.stringify({
        outcome: "completed",
        summary: "审查完成",
        review: { verdict: "unknown" },
      })
      expect(() => parseAgentOutcome(json, "reviewer")).toThrow(/verdict/i)
    })
  })

  describe("edge cases", () => {
    it("trims whitespace around JSON", () => {
      const json = '  \n  {"outcome":"completed","summary":"完成"}  \n  '
      const result = parseAgentOutcome(json, "implementer")
      expect(result.outcome).toBe("completed")
    })

    it("includes role and truncated original in error messages", () => {
      const longText = "x".repeat(200) + "这不是JSON"
      try {
        parseAgentOutcome(longText, "implementer")
        expect.fail("should have thrown")
      } catch (e) {
        const msg = (e as Error).message
        expect(msg).toContain("implementer")
        expect(msg.length).toBeLessThan(longText.length + 100)
      }
    })
  })
})

describe("formatAgentOutcome", () => {
  it("formats a completed implementer outcome", () => {
    const outcome: ImplementerOutcome = {
      outcome: "completed",
      summary: "实现完成",
    }
    const result = formatAgentOutcome(outcome)
    expect(JSON.parse(result)).toEqual(outcome)
  })

  it("formats a needs_input outcome with request", () => {
    const outcome: ImplementerOutcome = {
      outcome: "needs_input",
      summary: "需要确认",
      request: {
        question: "是否继续？",
        allowFreeform: true,
      },
    }
    const result = formatAgentOutcome(outcome)
    expect(JSON.parse(result)).toEqual(outcome)
  })

  it("formats a reviewer pass outcome", () => {
    const outcome: ReviewerOutcome = {
      outcome: "completed",
      summary: "审查通过",
      review: { verdict: "pass" },
    }
    const result = formatAgentOutcome(outcome)
    expect(JSON.parse(result)).toEqual(outcome)
  })

  it("produces valid JSON with proper indentation", () => {
    const outcome: ImplementerOutcome = {
      outcome: "completed",
      summary: "测试",
    }
    const result = formatAgentOutcome(outcome)
    expect(result).toContain("\n")
    expect(JSON.parse(result)).toEqual(outcome)
  })
})

describe("roundtrip", () => {
  it("format then parse preserves implementer outcome", () => {
    const original: ImplementerOutcome = {
      outcome: "needs_input",
      summary: "需要用户输入",
      request: {
        question: "选择方案",
        options: [
          { id: "a", label: "方案A", description: "简单方案" },
          { id: "b", label: "方案B" },
        ],
        allowFreeform: false,
        inputHint: "请选择 a 或 b",
      },
    }
    const formatted = formatAgentOutcome(original)
    const parsed = parseAgentOutcome(formatted, "implementer")
    expect(parsed).toEqual(original)
  })

  it("format then parse preserves reviewer outcome", () => {
    const original: ReviewerOutcome = {
      outcome: "completed",
      summary: "需人工核查",
      report: "部分代码逻辑无法从 diff 中确认",
      review: {
        verdict: "needs_check",
        cannotVerifySummary: "数据库迁移脚本需要人工确认",
      },
    }
    const formatted = formatAgentOutcome(original)
    const parsed = parseAgentOutcome(formatted, "reviewer")
    expect(parsed).toEqual(original)
  })
})
