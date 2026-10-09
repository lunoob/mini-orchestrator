import { describe, expect, it } from "vitest"

import type { AgentConfig } from "../types.js"
import { deduplicateAgentIntegrations } from "./integration.js"

const createAgent = (name: string, integrationAgent: string) => ({
  name,
  agent: name,
  command: name,
  integrationAgent,
}) as AgentConfig

describe("deduplicateAgentIntegrations", () => {
  it("keeps one agent for each integration type", () => {
    const agents = [
      createAgent("reviewer", "codex"),
      createAgent("final-reviewer", "codex"),
      createAgent("implementer", "cursor"),
    ]

    expect(deduplicateAgentIntegrations(agents)).toEqual([agents[0], agents[2]])
  })
})
