import { describe, expect, test } from "vitest"

import {
  createActivity,
  formatActivity,
  sanitizeDetail,
  sanitizeLabel,
  type AgentActivity,
} from "@src/session/activity"

describe("sanitizeDetail", () => {
  test("returns undefined for undefined input", () => {
    expect(sanitizeDetail(undefined)).toBeUndefined()
  })

  test("passes through short clean text unchanged", () => {
    expect(sanitizeDetail("hello world")).toBe("hello world")
  })

  test("strips all control characters including newline and tab", () => {
    expect(sanitizeDetail("a\x00b\x01c\x1fd")).toBe("abcd")
    expect(sanitizeDetail("a\tb\nc")).toBe("abc")
  })

  test("truncates text exceeding max length with ellipsis", () => {
    const long = "x".repeat(300)
    const result = sanitizeDetail(long, 100)
    expect(result).toHaveLength(100)
    expect(result).toMatch(/\.\.\.$/)
  })

  test("uses default max of 200 when not specified", () => {
    const long = "x".repeat(250)
    const result = sanitizeDetail(long)
    expect(result).toHaveLength(200)
  })

  test("does not truncate text at or below max length", () => {
    const exact = "x".repeat(200)
    expect(sanitizeDetail(exact)).toBe(exact)
  })
})

describe("sanitizeLabel", () => {
  test("strips control characters", () => {
    expect(sanitizeLabel("a\x00b\x01c")).toBe("abc")
  })

  test("truncates to default max of 120", () => {
    const long = "x".repeat(150)
    expect(sanitizeLabel(long)).toHaveLength(120)
  })

  test("uses custom max length", () => {
    expect(sanitizeLabel("hello", 3)).toBe("...")
  })
})

describe("createActivity", () => {
  test("creates activity with sanitized label and detail", () => {
    const activity = createActivity("tool_started", "Read\x00file.ts", "turn-1", "some\x01detail")
    expect(activity).toEqual({
      detail: "somedetail",
      kind: "tool_started",
      label: "Readfile.ts",
      turnId: "turn-1",
    })
  })

  test("handles undefined detail", () => {
    const activity = createActivity("tool_completed", "Write file.ts", "turn-1")
    expect(activity.detail).toBeUndefined()
  })

  test("truncates long label", () => {
    const longLabel = "x".repeat(200)
    const activity = createActivity("tool_started", longLabel, "turn-1")
    expect(activity.label).toHaveLength(120)
  })
})

describe("formatActivity", () => {
  test("formats tool_started activity", () => {
    const activity: AgentActivity = {
      kind: "tool_started",
      label: "Read src/session/store.ts",
      turnId: "turn-1",
    }
    expect(formatActivity(activity)).toBe("[Tool] Read src/session/store.ts")
  })

  test("formats tool_completed activity with checkmark", () => {
    const activity: AgentActivity = {
      kind: "tool_completed",
      label: "Write prompts/implement.md",
      turnId: "turn-1",
    }
    expect(formatActivity(activity)).toBe("[Tool ✓] Write prompts/implement.md")
  })

  test("formats tool_failed activity with cross", () => {
    const activity: AgentActivity = {
      kind: "tool_failed",
      label: "Bash pnpm test",
      turnId: "turn-1",
    }
    expect(formatActivity(activity)).toBe("[Tool ✗] Bash pnpm test")
  })

  test("formats notice activity", () => {
    const activity: AgentActivity = {
      kind: "notice",
      label: "Agent paused for input",
      turnId: "turn-1",
    }
    expect(formatActivity(activity)).toBe("[Notice] Agent paused for input")
  })

  test("includes sanitized detail when present", () => {
    const activity: AgentActivity = {
      detail: "file not found",
      kind: "tool_failed",
      label: "Read missing.ts",
      turnId: "turn-1",
    }
    expect(formatActivity(activity)).toBe("[Tool ✗] Read missing.ts — file not found")
  })

  test("omits detail when undefined", () => {
    const activity: AgentActivity = {
      kind: "tool_started",
      label: "Bash ls",
      turnId: "turn-1",
    }
    expect(formatActivity(activity)).toBe("[Tool] Bash ls")
  })
})
