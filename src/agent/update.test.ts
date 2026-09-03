import { describe, expect, it } from "vitest"

import type { AgentConfig } from "../types.js"
import { deduplicateAgentUpdates } from "./update.js"

const createAgent = (name: string, updateCommand?: string) => ({
  name,
  agent: name,
  command: name,
  integrationAgent: name,
  updateCommand,
}) as AgentConfig

describe("deduplicateAgentUpdates", () => {
  it("keeps one agent for each update command", () => {
    const agents = [
      createAgent("implementer", "codex update"),
      createAgent("reviewer", "codex update"),
      createAgent("fixer", "claude update"),
    ]

    expect(deduplicateAgentUpdates(agents)).toEqual([agents[0], agents[2]])
  })

  it("ignores agents without an update command", () => {
    expect(deduplicateAgentUpdates([
      createAgent("codex", "codex update"),
      createAgent("cursor"),
    ])).toEqual([expect.objectContaining({ name: "codex" })])
  })
})
