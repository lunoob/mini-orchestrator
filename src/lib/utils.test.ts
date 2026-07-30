import { describe, expect, it } from "vitest"

import {
  extractStatusLines,
  parseImplementStatus,
  parseReviewVerdict,
  render,
  stripStatusLines,
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
    const output = "Some text\nSTATUS: IMPLEMENT_DONE\nMore text"
    expect(parseImplementStatus(output)).toBe("done")
  })

  it("detects IMPLEMENT_ASK", () => {
    const output = "Question?\nSTATUS: IMPLEMENT_ASK"
    expect(parseImplementStatus(output)).toBe("needs_input")
  })

  it("returns unknown when STATUS is missing", () => {
    expect(parseImplementStatus("no status here")).toBe("unknown")
  })
})

describe("parseReviewVerdict", () => {
  it("parses review status from plain output", () => {
    const output = "Looks good.\nSTATUS: REVIEW_PASS"

    expect(parseReviewVerdict(output).kind).toBe("pass")
  })
})

describe("stripStatusLines", () => {
  it("removes indented STATUS lines", () => {
    const output = "天气晴\n  STATUS: IMPLEMENT_DONE\n"
    expect(stripStatusLines(output)).toBe("天气晴")
    expect(stripStatusLines(output)).not.toMatch(/STATUS:/)
  })

  it("removes STATUS after literal \\n escapes", () => {
    const output = "天气晴\\n\\n  STATUS: IMPLEMENT_DONE\\n\\n"
    const result = stripStatusLines(output)
    expect(result).toContain("天气晴")
    expect(result).not.toMatch(/STATUS:/)
    expect(result).not.toContain("\\n")
  })
})

describe("extractStatusLines", () => {
  it("keeps only STATUS markers from review output", () => {
    const output = [
      "### Summary",
      "Looks good overall.",
      "STATUS: REVIEW_PASS",
      "extra trailing notes",
    ].join("\n")

    expect(extractStatusLines(output)).toBe("STATUS: REVIEW_PASS")
  })

  it("keeps indented STATUS lines and trims them", () => {
    const output = "body\n  STATUS: REVIEW_NEEDS_CHECK\n"
    expect(extractStatusLines(output)).toBe("STATUS: REVIEW_NEEDS_CHECK")
  })

  it("returns empty string when STATUS is missing", () => {
    expect(extractStatusLines("no status here")).toBe("")
  })
})
