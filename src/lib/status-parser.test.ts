import { describe, expect, it } from "vitest"

import { extractStatus, parseStatus } from "./status-parser.js"

describe("extractStatus", () => {
  it("extracts implementer status from a line", () => {
    expect(extractStatus("做了实现\nSTATUS: IMPLEMENT_DONE", "implementer")).toBe("IMPLEMENT_DONE")
  })

  it("extracts reviewer status", () => {
    expect(extractStatus("STATUS: REVIEW_NEEDS_CHECK", "reviewer")).toBe("REVIEW_NEEDS_CHECK")
  })

  it("returns null when no status", () => {
    expect(extractStatus("随便输出", "implementer")).toBeNull()
  })

  it("rejects status not valid for role", () => {
    expect(extractStatus("STATUS: REVIEW_PASS", "implementer")).toBeNull()
    expect(extractStatus("STATUS: IMPLEMENT_DONE", "reviewer")).toBeNull()
  })

  it("allows spaces around status key", () => {
    expect(extractStatus("STATUS:   IMPLEMENT_ASK", "implementer")).toBe("IMPLEMENT_ASK")
  })

  it("finds status anywhere in output", () => {
    expect(extractStatus("前言\nSTATUS: IMPLEMENT_FAILED\n结尾", "implementer")).toBe("IMPLEMENT_FAILED")
  })
})

describe("parseStatus", () => {
  it("returns body without STATUS lines", () => {
    expect(parseStatus("问题列表\nSTATUS: REVIEW_FAIL", "reviewer").body).toBe("问题列表")
  })

  it("keeps body when no status", () => {
    expect(parseStatus("没有状态", "implementer").body).toBe("没有状态")
  })
})
