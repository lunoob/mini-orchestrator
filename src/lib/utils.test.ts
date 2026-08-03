import { describe, expect, it } from "vitest"

import { extractStatusSummary, render, stripStatus } from "./utils.js"

describe("render", () => {
  it("replaces provided keys only", () => {
    expect(render("{{a}} and {{b}}", { a: "1" })).toBe("1 and {{b}}")
  })

  it("supports spaced placeholders", () => {
    expect(render("{{ specPath }}", { specPath: "/tmp/spec.md" })).toBe("/tmp/spec.md")
  })
})

describe("stripStatus", () => {
  it("removes STATUS line and keeps body", () => {
    expect(stripStatus("晴天\nSTATUS: IMPLEMENT_DONE", "implementer")).toBe("晴天")
  })

  it("returns original when no STATUS line", () => {
    expect(stripStatus("no status here", "implementer")).toBe("no status here")
  })
})

describe("extractStatusSummary", () => {
  it("shows STATUS for implementer done", () => {
    expect(extractStatusSummary("STATUS: IMPLEMENT_DONE", "implementer")).toBe("IMPLEMENT_DONE")
  })

  it("shows REVIEW_PASS for reviewer", () => {
    expect(extractStatusSummary("STATUS: REVIEW_PASS", "reviewer")).toBe("REVIEW_PASS")
  })

  it("shows no status when missing", () => {
    expect(extractStatusSummary("nothing", "reviewer")).toBe("(no status)")
  })
})
