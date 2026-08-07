import { describe, expect, it } from "vitest"

import type { WorkflowSnapshot } from "../workflow/events.js"
import { calculateLayout, formatStatusLine, getStringDisplayWidth } from "./layout.js"

const createSnapshot = (overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot => ({
  workflowTitle: "",
  issueIndex: 0,
  issueCount: 3,
  issueTitle: "Auth",
  phase: "implement",
  reviewRound: 1,
  maxReviewRounds: 8,
  implementerStatus: "working",
  reviewerStatus: "idle",
  elapsedMs: 65000,
  needsInput: null,
  terminalState: null,
  startedAt: Date.now() - 65000,
  ...overrides,
})

describe("getStringDisplayWidth", () => {
  it("returns 0 for empty string", () => {
    expect(getStringDisplayWidth("")).toBe(0)
  })

  it("returns correct width for ASCII", () => {
    expect(getStringDisplayWidth("hello")).toBe(5)
    expect(getStringDisplayWidth("abc")).toBe(3)
  })

  it("returns 2 for each CJK character", () => {
    expect(getStringDisplayWidth("中文")).toBe(4)
    expect(getStringDisplayWidth("Duration")).toBe(8)
  })

  it("handles mixed ASCII and CJK", () => {
    expect(getStringDisplayWidth("Duration: 00:00:00")).toBe(18)
    expect(getStringDisplayWidth("IMP:working")).toBe(11)
  })

  it("ignores ANSI escape sequences in width calculation", () => {
    const withAnsi = "\x1b[31mhello\x1b[0m"
    expect(getStringDisplayWidth(withAnsi)).toBe(5)
  })

  it("handles emoji as width 2", () => {
    expect(getStringDisplayWidth("👍")).toBe(2)
  })
})

describe("formatStatusLine", () => {
  it("formats issue progress", () => {
    const snap = createSnapshot({ issueIndex: 2, issueCount: 5, issueTitle: "Dashboard" })
    const line = formatStatusLine(snap, 80)

    expect(line).toContain("Issue: 3/5")
    expect(line).toContain("Dashboard")
  })

  it("includes workflow title when provided", () => {
    const snap = createSnapshot({ workflowTitle: "实现用户登录功能" })
    const line = formatStatusLine(snap, 80)

    expect(line).toContain("实现用户登录功能")
  })

  it("formats phase", () => {
    const snap = createSnapshot({ phase: "review" })
    const line = formatStatusLine(snap, 80)

    expect(line).toContain("review")
  })

  it("displays final-review and final-fix phases", () => {
    expect(formatStatusLine(createSnapshot({ phase: "final-review" }), 80)).toContain("final-review")
    expect(formatStatusLine(createSnapshot({ phase: "final-fix" }), 80)).toContain("final-fix")
  })

  it("formats review round", () => {
    const snap = createSnapshot({ reviewRound: 3, maxReviewRounds: 8 })
    const line = formatStatusLine(snap, 80)

    expect(line).toContain("R3/8")
  })

  it("formats elapsed time as HH:MM:SS", () => {
    const snap = createSnapshot({ elapsedMs: 3661000 }) // 1h 1m 1s
    const line = formatStatusLine(snap, 80)

    expect(line).toContain("Duration: 01:01:01")
  })

  it("formats elapsed time with zero values", () => {
    const snap = createSnapshot({ elapsedMs: 0 })
    const line = formatStatusLine(snap, 80)

    expect(line).toContain("Duration: 00:00:00")
  })

  it("formats elapsed time at 65 seconds", () => {
    const snap = createSnapshot({ elapsedMs: 65000 })
    const line = formatStatusLine(snap, 80)

    expect(line).toContain("Duration: 00:01:05")
  })

  it("formats implementer status", () => {
    const snap = createSnapshot({ implementerStatus: "working" })
    const line = formatStatusLine(snap, 80)

    expect(line).toContain("IMP:working")
  })

  it("formats reviewer status", () => {
    const snap = createSnapshot({ reviewerStatus: "completed" })
    const line = formatStatusLine(snap, 80)

    expect(line).toContain("REV:completed")
  })

  it("includes needs_input info when present", () => {
    const snap = createSnapshot({
      implementerStatus: "needs_input",
      needsInput: {
        agent: "implementer",
        provider: "claude",
        reason: "Which database?",
      },
    })
    const line = formatStatusLine(snap, 80)

    expect(line).toContain("implementer")
    expect(line).toContain("Which database?")
  })

  it("splits multi-line reason into separate segments", () => {
    const snap = createSnapshot({
      implementerStatus: "needs_input",
      needsInput: {
        agent: "implementer",
        provider: "claude",
        reason: "Line 1\nLine 2\nLine 3",
      },
    })
    const line = formatStatusLine(snap, 80)

    // Each line of reason should appear as a separate segment
    expect(line).toContain("Line 1")
    expect(line).toContain("Line 2")
    expect(line).toContain("Line 3")
  })

  it("shows terminal state when present", () => {
    const snap = createSnapshot({ terminalState: "completed" })
    const line = formatStatusLine(snap, 80)

    expect(line).toContain("completed")
  })

  it("shows terminal state failed", () => {
    const snap = createSnapshot({ terminalState: "failed" })
    const line = formatStatusLine(snap, 80)

    expect(line).toContain("failed")
  })

  it("shows terminal state paused", () => {
    const snap = createSnapshot({ terminalState: "paused" })
    const line = formatStatusLine(snap, 80)

    expect(line).toContain("paused")
  })
})

describe("calculateLayout", () => {
  it("fits all fields on one line when terminal is wide enough", () => {
    const snap = createSnapshot()
    const layout = calculateLayout(snap, 120, 24)

    expect(layout.lines).toHaveLength(1)
    expect(layout.panelHeight).toBe(1)
  })

  it("wraps fields when terminal is narrow", () => {
    const snap = createSnapshot()
    const layout = calculateLayout(snap, 40, 24)

    // Should wrap to multiple lines
    expect(layout.lines.length).toBeGreaterThan(1)
    expect(layout.panelHeight).toBeGreaterThan(1)
  })

  it("calculates log height correctly", () => {
    const snap = createSnapshot()
    const layout = calculateLayout(snap, 80, 24)

    expect(layout.logHeight).toBe(24 - layout.panelHeight - 1)
  })

  it("reserves one row between the log area and status panel", () => {
    const layout = calculateLayout(createSnapshot(), 80, 24)

    expect(layout.logHeight + layout.panelHeight).toBe(23)
  })

  it("adjusts panel height for needs_input details", () => {
    const snap = createSnapshot({
      implementerStatus: "needs_input",
      needsInput: {
        agent: "implementer",
        provider: "claude",
        reason: "Which database?",
      },
    })
    const layout = calculateLayout(snap, 80, 24)

    // Panel should be taller for needs_input
    const normalLayout = calculateLayout(createSnapshot(), 80, 24)
    expect(layout.panelHeight).toBeGreaterThanOrEqual(normalLayout.panelHeight)
  })

  it("counts multi-line reason lines in panel height", () => {
    const singleLine = createSnapshot({
      implementerStatus: "needs_input",
      needsInput: { agent: "implementer", provider: "claude", reason: "One line" },
    })
    const multiLine = createSnapshot({
      implementerStatus: "needs_input",
      needsInput: { agent: "implementer", provider: "claude", reason: "Line 1\nLine 2\nLine 3" },
    })
    const singleLayout = calculateLayout(singleLine, 80, 24)
    const multiLayout = calculateLayout(multiLine, 80, 24)

    // Multi-line reason should produce more panel lines
    expect(multiLayout.panelHeight).toBeGreaterThan(singleLayout.panelHeight)
  })

  it("handles very narrow terminal", () => {
    const snap = createSnapshot()
    const layout = calculateLayout(snap, 20, 24)

    // Should still produce valid layout
    expect(layout.panelHeight).toBeGreaterThanOrEqual(1)
    expect(layout.logHeight).toBeGreaterThanOrEqual(0)
  })

  it("handles very short terminal", () => {
    const snap = createSnapshot()
    const layout = calculateLayout(snap, 80, 5)

    // Panel should have minimum height
    expect(layout.panelHeight).toBeGreaterThanOrEqual(1)
    expect(layout.logHeight).toBeGreaterThanOrEqual(0)
  })

  it("does not truncate issue title", () => {
    const longTitle = "A".repeat(100)
    const snap = createSnapshot({ issueTitle: longTitle })
    const layout = calculateLayout(snap, 40, 24)

    // All lines should fit within terminal width
    for (const line of layout.lines) {
      // Allow some flexibility for wrapping
      expect(line.length).toBeLessThanOrEqual(45)
    }
  })

  it("does not truncate action text", () => {
    const snap = createSnapshot({
      implementerStatus: "needs_input",
      needsInput: {
        agent: "implementer",
        provider: "claude",
        reason: "A very long reason that should not be truncated even on narrow terminals",
      },
    })
    const layout = calculateLayout(snap, 40, 24)

    // Should include the full reason
    const allText = layout.lines.join(" ")
    expect(allText).toContain("A very long reason")
  })

  it("correctly wraps lines with CJK characters using display width", () => {
    const snap = createSnapshot({
      issueTitle: "认证系统重构",
      phase: "implement",
    })
    const layout = calculateLayout(snap, 30, 24)

    // Each line should fit within 30 display cells
    for (const line of layout.lines) {
      expect(getStringDisplayWidth(line)).toBeLessThanOrEqual(30)
    }
  })

  it("handles CJK issue title without truncation", () => {
    const longCjkTitle = "这是一个非常长的中文标题需要被正确换行处理"
    const snap = createSnapshot({ issueTitle: longCjkTitle })
    const layout = calculateLayout(snap, 30, 24)

    // All title characters should be present
    const allText = layout.lines.join("")
    expect(allText).toContain("这是一个非常长的中文标题需要被正确换行处理")
  })
})
