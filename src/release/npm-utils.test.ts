import { describe, expect, it, vi } from "vitest"

import { ensureNpmVersionPublished } from "./npm-utils.js"

describe("ensureNpmVersionPublished", () => {
  it("preserves version mismatch errors", () => {
    const exec = vi.fn().mockReturnValue("1.0.1\n")

    expect(() => ensureNpmVersionPublished("mini-orch", "1.0.0", exec)).toThrow(
      "npm registry returned version 1.0.1 for mini-orch@1.0.0, expected 1.0.0.",
    )
  })

  it("reports unpublished versions when npm view fails", () => {
    const exec = vi.fn(() => {
      throw new Error("404 Not Found")
    })

    expect(() => ensureNpmVersionPublished("mini-orch", "1.0.0", exec)).toThrow(
      "Version 1.0.0 is not published to npm. Run pnpm publish before release:git.",
    )
  })
})
