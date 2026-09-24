import { describe, expect, it } from "vitest"

import {
  formatAgentStart,
  formatIntegrationFailure,
  formatIntegrationStart,
  formatUpdateFailure,
  formatUpdateStart,
} from "./log-messages.js"

describe("agent log messages", () => {
  it("describes an update command without a role name", () => {
    expect(formatUpdateStart("cursor-agent update")).toBe(
      "[Agent] Running update: cursor-agent update",
    )
    expect(formatUpdateStart("cursor-agent update")).not.toContain(" for ")
  })

  it("describes an integration command without a role name", () => {
    expect(formatIntegrationStart("cursor")).toBe(
      "[Agent] Running herdr integration: herdr integration cursor",
    )
    expect(formatIntegrationStart("cursor")).not.toContain(" for ")
  })

  it("describes update failures without a role name", () => {
    expect(formatUpdateFailure(1)).toBe(
      "[Agent] Update failed (exit code 1), continuing anyway.",
    )
  })

  it("describes integration failures without a role name", () => {
    expect(formatIntegrationFailure(1)).toBe(
      "[Agent] Integration failed (exit code 1), continuing anyway.",
    )
  })

  it("describes an agent start command with the agent name", () => {
    expect(formatAgentStart(
      "implementer",
      "cursor-agent --trust --yolo --resume abc123 --model composer-2.5-high",
    )).toBe(
      '[Agent] Starting "implementer": cursor-agent --trust --yolo --resume abc123 --model composer-2.5-high',
    )
  })
})
