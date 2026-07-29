import { describe, expect, it } from "vitest"

import { shouldNotifyIssueComplete, shouldSkipImplement, shouldSkipIssue } from "@src/workflow/issues"

describe("shouldSkipIssue", () => {
  it("skips finish issues", () => {
    expect(shouldSkipIssue({ title: "Done", specPath: "/x.md", state: "finish" })).toBe(true)
  })

  it("does not skip ready or review issues", () => {
    expect(shouldSkipIssue({ title: "Todo", specPath: "/x.md", state: "ready" })).toBe(false)
    expect(shouldSkipIssue({ title: "InReview", specPath: "/x.md", state: "review" })).toBe(false)
  })
})

describe("shouldSkipImplement", () => {
  it("skips implement for review issues", () => {
    expect(shouldSkipImplement({ title: "InReview", specPath: "/x.md", state: "review" })).toBe(true)
  })

  it("does not skip implement for ready issues", () => {
    expect(shouldSkipImplement({ title: "Todo", specPath: "/x.md", state: "ready" })).toBe(false)
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
