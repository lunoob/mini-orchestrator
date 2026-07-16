import { describe, expect, it } from "vitest"

import { shouldNotifyIssueComplete, shouldSkipIssue } from "./issues.js"

describe("shouldSkipIssue", () => {
  it("skips finish issues", () => {
    expect(shouldSkipIssue({ title: "Done", specPath: "/x.md", state: "finish" })).toBe(true)
  })

  it("does not skip ready issues", () => {
    expect(shouldSkipIssue({ title: "Todo", specPath: "/x.md", state: "ready" })).toBe(false)
  })
})

describe("shouldNotifyIssueComplete", () => {
  it("notifies when more issues remain after this one", () => {
    expect(shouldNotifyIssueComplete(0, 3)).toBe(true)
    expect(shouldNotifyIssueComplete(1, 3)).toBe(true)
  })

  it("does not notify for the last issue", () => {
    expect(shouldNotifyIssueComplete(2, 3)).toBe(false)
    expect(shouldNotifyIssueComplete(0, 1)).toBe(false)
  })
})
