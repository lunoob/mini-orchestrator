import { describe, expect, it } from "vitest"

import { shouldSkipIssue } from "./issues.js"

describe("shouldSkipIssue", () => {
  it("skips finish issues", () => {
    expect(shouldSkipIssue({ title: "Done", specPath: "/x.md", state: "finish" })).toBe(true)
  })

  it("does not skip ready issues", () => {
    expect(shouldSkipIssue({ title: "Todo", specPath: "/x.md", state: "ready" })).toBe(false)
  })
})
