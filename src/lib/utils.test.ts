import { describe, expect, it } from "vitest"

import { extractOutcomeSummary, render, stripAgentOutcome } from "./utils.js"

describe("render", () => {
  it("replaces provided keys only", () => {
    expect(render("{{a}} and {{b}}", { a: "1" })).toBe("1 and {{b}}")
  })

  it("supports spaced placeholders", () => {
    expect(render("{{ specPath }}", { specPath: "/tmp/spec.md" })).toBe("/tmp/spec.md")
  })
})

describe("stripAgentOutcome", () => {
  it("removes trailing JSON outcome block", () => {
    expect(stripAgentOutcome('晴天\n{"outcome":"completed"}')).toBe("晴天")
  })

  it("keeps normal JSON that is not at the end", () => {
    expect(stripAgentOutcome('{"key":"val"}\n晴天\n{"outcome":"completed"}')).toBe('{"key":"val"}\n晴天')
  })

  it("returns original when no JSON at end", () => {
    expect(stripAgentOutcome("no json here")).toBe("no json here")
  })
})

describe("extractOutcomeSummary", () => {
  it("shows REVIEW_PASS for completed with pass verdict", () => {
    const output = '{"outcome":"completed","summary":"ok","review":{"verdict":"pass"}}'
    expect(extractOutcomeSummary(output)).toBe("REVIEW_PASS")
  })

  it("shows REVIEW_FAIL for completed with fail verdict", () => {
    const output = '{"outcome":"completed","summary":"bad","review":{"verdict":"fail"}}'
    expect(extractOutcomeSummary(output)).toBe("REVIEW_FAIL")
  })

  it("shows IMPLEMENT_DONE for completed without review", () => {
    const output = '{"outcome":"completed","summary":"done"}'
    expect(extractOutcomeSummary(output)).toBe("IMPLEMENT_DONE")
  })

  it("shows question for needs_input", () => {
    const output = '{"outcome":"needs_input","summary":"help","request":{"question":"Which way?","allowFreeform":true}}'
    expect(extractOutcomeSummary(output)).toContain("Which way?")
  })

  it("shows error for failed", () => {
    const output = '{"outcome":"failed","summary":"failed","failure":{"message":"API error"}}'
    expect(extractOutcomeSummary(output)).toContain("API error")
  })
})
