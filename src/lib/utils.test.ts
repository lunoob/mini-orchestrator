import { describe, expect, it } from "vitest"

import {
  extractImplementResult,
  extractReviewResult,
  parseImplementStatus,
  parseReviewVerdict,
  render,
} from "./utils.js"

describe("render", () => {
  it("replaces provided keys only", () => {
    const result = render("{{a}} and {{b}}", { a: "1" })

    expect(result).toBe("1 and {{b}}")
  })

  it("supports spaced placeholders", () => {
    const result = render("{{ specPath }}", { specPath: "/tmp/spec.md" })

    expect(result).toBe("/tmp/spec.md")
  })
})

describe("parseImplementStatus", () => {
  it("detects IMPLEMENT_DONE", () => {
    const output = "---IMPLEMENT_RESULT_START---\nSTATUS: IMPLEMENT_DONE\n---IMPLEMENT_RESULT_END---"
    expect(parseImplementStatus(extractImplementResult(output))).toBe("done")
  })

  it("detects IMPLEMENT_ASK", () => {
    const output = "---IMPLEMENT_RESULT_START---\nSTATUS: IMPLEMENT_ASK\n---IMPLEMENT_RESULT_END---"
    expect(parseImplementStatus(extractImplementResult(output))).toBe("needs_input")
  })

  it("returns unknown when STATUS is missing", () => {
    expect(parseImplementStatus(extractImplementResult("no status here"))).toBe("unknown")
  })
})

describe("parseReviewVerdict", () => {
  it("parses review status from delimited output", () => {
    const output = [
      "---REVIEW_RESULT_START---",
      "STATUS: REVIEW_PASS",
      "---REVIEW_RESULT_END---",
    ].join("\n")

    expect(parseReviewVerdict(extractReviewResult(output)).kind).toBe("pass")
  })
})
