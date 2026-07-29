import { describe, expect, it } from "vitest"

import {
  render,
  getErrorMessage,
  splitCommand,
} from "@src/lib/utils"

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

describe("getErrorMessage", () => {
  it("extracts message from Error instances", () => {
    expect(getErrorMessage(new Error("test error"))).toBe("test error")
  })

  it("converts non-Error values to string", () => {
    expect(getErrorMessage("string error")).toBe("string error")
    expect(getErrorMessage(42)).toBe("42")
    expect(getErrorMessage(null)).toBe("null")
  })
})

describe("splitCommand", () => {
  it("splits simple command", () => {
    expect(splitCommand("codex --model gpt-5.5")).toEqual(["codex", "--model", "gpt-5.5"])
  })

  it("handles quoted arguments", () => {
    expect(splitCommand('codex --prompt "hello world"')).toEqual(["codex", "--prompt", "hello world"])
  })

  it("handles single quotes", () => {
    expect(splitCommand("codex --prompt 'hello world'")).toEqual(["codex", "--prompt", "hello world"])
  })

  it("handles empty input", () => {
    expect(splitCommand("")).toEqual([])
  })
})
