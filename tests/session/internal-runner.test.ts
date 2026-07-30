import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { renderRunnerEvent, resetRunnerRenderState } from "@src/session/internal-runner"

describe("internal runner pane rendering", () => {
  beforeEach(() => resetRunnerRenderState())
  afterEach(() => vi.restoreAllMocks())

  test("mirrors structured output and lifecycle events without using pane text as control input", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    renderRunnerEvent({ data: { delta: "partial output", turnId: "turn-1" }, type: "output_text.delta" })
    renderRunnerEvent({ data: { turnId: "turn-1" }, type: "turn.completed" })

    expect(write).toHaveBeenNthCalledWith(1, "partial output")
    expect(write).toHaveBeenNthCalledWith(2, "\n[Turn ✓] completed\n")
  })

  test("renders turn.failed with reason", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    renderRunnerEvent({ data: { reason: "timeout exceeded", turnId: "turn-1" }, type: "turn.failed" })

    expect(write).toHaveBeenCalledWith("[Turn ✗] failed — timeout exceeded\n")
  })

  test("renders turn.interrupted", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    renderRunnerEvent({ data: { turnId: "turn-1" }, type: "turn.interrupted" })

    expect(write).toHaveBeenCalledWith("[Turn ✗] interrupted\n")
  })

  test("renders tool_started activity with [Tool] prefix", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    renderRunnerEvent({
      data: { activity: { kind: "tool_started", label: "Read src/file.ts", turnId: "turn-1" }, turnId: "turn-1" },
      type: "activity",
    })

    expect(write).toHaveBeenCalledWith("[Tool] Read src/file.ts\n")
  })

  test("renders tool_completed activity with checkmark", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    renderRunnerEvent({
      data: { activity: { kind: "tool_completed", label: "Write output.md", turnId: "turn-1" }, turnId: "turn-1" },
      type: "activity",
    })

    expect(write).toHaveBeenCalledWith("[Tool ✓] Write output.md\n")
  })

  test("renders tool_failed activity with cross and sanitized detail", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    renderRunnerEvent({
      data: { activity: { detail: "file not found", kind: "tool_failed", label: "Read missing.ts", turnId: "turn-1" }, turnId: "turn-1" },
      type: "activity",
    })

    expect(write).toHaveBeenCalledWith("[Tool ✗] Read missing.ts — file not found\n")
  })

  test("activity detail is pre-sanitized at adapter level", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    // Activity data arrives already sanitized from adapter (via createActivity)
    renderRunnerEvent({
      data: { activity: { detail: "errormessage", kind: "tool_failed", label: "Bash cmd", turnId: "turn-1" }, turnId: "turn-1" },
      type: "activity",
    })

    expect(write).toHaveBeenCalledWith("[Tool ✗] Bash cmd — errormessage\n")
  })

  test("consecutive activities each occupy one line without blank lines", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    renderRunnerEvent({
      data: { activity: { kind: "tool_started", label: "Read a.ts", turnId: "turn-1" }, turnId: "turn-1" },
      type: "activity",
    })
    renderRunnerEvent({
      data: { activity: { kind: "tool_completed", label: "Read a.ts", turnId: "turn-1" }, turnId: "turn-1" },
      type: "activity",
    })

    expect(write).toHaveBeenNthCalledWith(1, "[Tool] Read a.ts\n")
    expect(write).toHaveBeenNthCalledWith(2, "[Tool ✓] Read a.ts\n")
    expect(write).toHaveBeenCalledTimes(2)
  })

  test("text delta continues streaming after activity without breaking flow", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    renderRunnerEvent({ data: { delta: "before", turnId: "turn-1" }, type: "output_text.delta" })
    renderRunnerEvent({
      data: { activity: { kind: "tool_started", label: "Bash ls", turnId: "turn-1" }, turnId: "turn-1" },
      type: "activity",
    })
    renderRunnerEvent({ data: { delta: "after", turnId: "turn-1" }, type: "output_text.delta" })

    expect(write).toHaveBeenNthCalledWith(1, "before")
    expect(write).toHaveBeenNthCalledWith(2, "\n[Tool] Bash ls\n")
    expect(write).toHaveBeenNthCalledWith(3, "after")
  })
})
