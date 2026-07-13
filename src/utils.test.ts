import { describe, expect, it } from "vitest"

import { render } from "./utils.js"

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
