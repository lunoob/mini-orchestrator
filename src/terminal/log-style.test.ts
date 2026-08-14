import { describe, expect, it } from "vitest"

import { colorizeLogMessage } from "./log-style.js"

describe("colorizeLogMessage", () => {
  it("colors a bracketed log prefix without coloring the message body", () => {
    const result = colorizeLogMessage("[Agent] Starting update")

    expect(result).toMatch(/^\x1b\[38;5;\d+m\[Agent\]\x1b\[0m Starting update$/)
  })

  it("uses the same color for the same prefix", () => {
    const first = colorizeLogMessage("[Agent] first").match(/^\x1b\[38;5;(\d+)m/)?.[1]
    const second = colorizeLogMessage("[Agent] second").match(/^\x1b\[38;5;(\d+)m/)?.[1]

    expect(first).toBeDefined()
    expect(second).toBe(first)
  })

  it("uses different colors for different prefixes", () => {
    const agent = colorizeLogMessage("[Agent] message").match(/^\x1b\[38;5;(\d+)m/)?.[1]
    const workflow = colorizeLogMessage("[Workflow] message").match(/^\x1b\[38;5;(\d+)m/)?.[1]

    expect(agent).not.toBe(workflow)
  })

  it("leaves unprefixed output unchanged", () => {
    expect(colorizeLogMessage("raw agent output")).toBe("raw agent output")
  })

  it("colors prefixes on each physical line", () => {
    const result = colorizeLogMessage("[Agent] first\n[Issue] second")

    expect(result).toMatch(/\x1b\[0m first\n\x1b\[38;5;\d+m\[Issue\]\x1b\[0m second/)
  })
})
