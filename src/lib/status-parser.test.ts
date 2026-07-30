import { describe, expect, it } from "vitest"

import { parseAgentOutput } from "./status-parser.js"

describe("parseAgentOutput", () => {
  describe("implementer output", () => {
    it("returns completed for single IMPLEMENT_DONE", () => {
      const result = parseAgentOutput("Some text\nSTATUS: IMPLEMENT_DONE\nMore text", "implementer")
      expect(result.status).toBe("completed")
      expect((result as { statusValue: string }).statusValue).toBe("IMPLEMENT_DONE")
      expect(result.output).toContain("STATUS: IMPLEMENT_DONE")
    })

    it("returns needs_input for IMPLEMENT_ASK", () => {
      const result = parseAgentOutput("Question?\nSTATUS: IMPLEMENT_ASK", "implementer")
      expect(result.status).toBe("needs_input")
      expect((result as { statusValue: string }).statusValue).toBe("IMPLEMENT_ASK")
    })

    it("returns invalid_output when no STATUS present", () => {
      const result = parseAgentOutput("Just some text\nNo status here", "implementer")
      expect(result.status).toBe("invalid_output")
      expect("reason" in result).toBe(true)
    })

    it("returns invalid_output when multiple STATUS lines present", () => {
      const result = parseAgentOutput(
        "STATUS: IMPLEMENT_DONE\nSTATUS: IMPLEMENT_ASK",
        "implementer",
      )
      expect(result.status).toBe("invalid_output")
      if ("reason" in result) {
        expect(result.reason).toContain("多个")
      }
    })

    it("returns invalid_output for unknown STATUS value", () => {
      const result = parseAgentOutput("STATUS: UNKNOWN_STATUS", "implementer")
      expect(result.status).toBe("invalid_output")
    })

    it("recognizes STATUS anywhere in output", () => {
      const result = parseAgentOutput(
        "Beginning text\nMiddle text\nSTATUS: IMPLEMENT_DONE\nEnd text",
        "implementer",
      )
      expect(result.status).toBe("completed")
    })

    it("recognizes indented STATUS lines", () => {
      const result = parseAgentOutput("  STATUS: IMPLEMENT_DONE", "implementer")
      expect(result.status).toBe("completed")
    })
  })

  describe("reviewer output", () => {
    it("returns completed for REVIEW_PASS", () => {
      const result = parseAgentOutput("All good\nSTATUS: REVIEW_PASS", "reviewer")
      expect(result.status).toBe("completed")
      expect((result as { statusValue: string }).statusValue).toBe("REVIEW_PASS")
    })

    it("returns completed for REVIEW_FAIL (completed = 有了明确结论)", () => {
      const result = parseAgentOutput("Needs work\nSTATUS: REVIEW_FAIL", "reviewer")
      expect(result.status).toBe("completed")
      expect((result as { statusValue: string }).statusValue).toBe("REVIEW_FAIL")
    })

    it("returns needs_input for REVIEW_NEEDS_CHECK", () => {
      const result = parseAgentOutput("Cannot verify\nSTATUS: REVIEW_NEEDS_CHECK", "reviewer")
      expect(result.status).toBe("needs_input")
      expect((result as { statusValue: string }).statusValue).toBe("REVIEW_NEEDS_CHECK")
    })

    it("returns invalid_output for implementer-only STATUS in reviewer output", () => {
      const result = parseAgentOutput("STATUS: IMPLEMENT_DONE", "reviewer")
      expect(result.status).toBe("invalid_output")
    })
  })

  describe("edge cases", () => {
    it("handles empty output", () => {
      const result = parseAgentOutput("", "implementer")
      expect(result.status).toBe("invalid_output")
    })

    it("handles literal \\n in output", () => {
      const result = parseAgentOutput(
        "text\\nSTATUS: IMPLEMENT_DONE\\nmore",
        "implementer",
      )
      expect(result.status).toBe("completed")
    })

    it("multiple same legal status still counts as invalid", () => {
      const result = parseAgentOutput(
        "STATUS: IMPLEMENT_DONE\nSTATUS: IMPLEMENT_DONE",
        "implementer",
      )
      expect(result.status).toBe("invalid_output")
    })
  })
})
