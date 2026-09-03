import { afterEach, describe, expect, it, vi } from "vitest"

import {
  applyLogDecoration,
  colorizeLogMessage,
  decorateLogMessage,
  isDecoratedLogMessage,
  resetLogDateState,
} from "./log-style.js"

describe("decorateLogMessage", () => {
  afterEach(() => {
    resetLogDateState()
    vi.useRealTimers()
  })

  it("adds HH:mm:ss before structured log lines", () => {
    vi.setSystemTime(new Date("2026-09-03T10:49:03"))

    expect(decorateLogMessage('[Agent] Starting "implementer"')).toBe(
      '10:49:03 [Agent] Starting "implementer"',
    )
  })

  it("leaves unprefixed output unchanged", () => {
    vi.setSystemTime(new Date("2026-09-03T10:49:03"))

    expect(decorateLogMessage("raw agent output")).toBe("raw agent output")
  })

  it("inserts a date line when the day changes", () => {
    vi.setSystemTime(new Date("2026-09-03T23:58:00"))
    decorateLogMessage("[Workflow] Task done")

    vi.setSystemTime(new Date("2026-09-04T00:05:00"))
    expect(decorateLogMessage("[Agent] Bootstrap OK")).toBe(
      "2026-09-04\n00:05:00 [Agent] Bootstrap OK",
    )
  })

  it("does not insert a date line for the first structured log", () => {
    vi.setSystemTime(new Date("2026-09-04T00:05:00"))

    expect(decorateLogMessage("[Agent] Bootstrap OK")).toBe(
      "00:05:00 [Agent] Bootstrap OK",
    )
  })

  it("skips decoration when the message is already decorated", () => {
    const decorated = "10:49:03 [Agent] Starting"

    expect(applyLogDecoration(decorated)).toBe(decorated)
    expect(isDecoratedLogMessage(decorated)).toBe(true)
  })

  it("recognizes decorated messages that start with a date line", () => {
    const decorated = "2026-09-04\n00:05:00 [Agent] Bootstrap OK"

    expect(isDecoratedLogMessage(decorated)).toBe(true)
    expect(applyLogDecoration(decorated)).toBe(decorated)
  })
})

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

  it("colors structured prefixes after a timestamp", () => {
    const result = colorizeLogMessage("10:49:03 [Agent] Starting update")

    expect(result).toMatch(/^10:49:03 \x1b\[38;5;\d+m\[Agent\]\x1b\[0m Starting update$/)
  })
})
