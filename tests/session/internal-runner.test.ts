import { afterEach, describe, expect, test, vi } from "vitest"

import { renderRunnerEvent } from "@src/session/internal-runner"

describe("internal runner pane rendering", () => {
  afterEach(() => vi.restoreAllMocks())

  test("mirrors structured output and lifecycle events without using pane text as control input", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    renderRunnerEvent({ data: { delta: "partial output", turnId: "turn-1" }, type: "output_text.delta" })
    renderRunnerEvent({ data: { turnId: "turn-1" }, type: "turn.completed" })

    expect(write).toHaveBeenNthCalledWith(1, "partial output")
    expect(write).toHaveBeenNthCalledWith(2, "\n[Session] turn turn-1 completed\n")
  })
})
