import { describe, expect, it } from "vitest"

import { formatCommandDuration } from "./command-duration.js"

describe("formatCommandDuration", () => {
  it("formats the final command duration as a workflow log line", () => {
    expect(formatCommandDuration(3_723_000)).toBe("\n\n[Workflow] Total duration: 01:02:03")
  })
})
