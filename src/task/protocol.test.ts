import { describe, expect, it } from "vitest"

import { TASK_STATUSES_BY_ROLE } from "./index.js"

describe("TASK_STATUSES_BY_ROLE", () => {
  it("implementer only allows IMPLEMENT_DONE and IMPLEMENT_ASK", () => {
    expect(TASK_STATUSES_BY_ROLE.implementer).toEqual(["IMPLEMENT_DONE", "IMPLEMENT_ASK"])
  })

  it("reviewer only allows REVIEW_PASS, REVIEW_FAIL, REVIEW_NEEDS_CHECK", () => {
    expect(TASK_STATUSES_BY_ROLE.reviewer).toEqual(["REVIEW_PASS", "REVIEW_FAIL", "REVIEW_NEEDS_CHECK"])
  })
})
