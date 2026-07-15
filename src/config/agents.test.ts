import { describe, expect, it } from "vitest"

import { resolveAgentConfig } from "./agents.js"

describe("resolveAgentConfig", () => {
  it("resolves codex with model", () => {
    const config = resolveAgentConfig({
      agent: "codex",
      model: "gpt-5.6-terra",
      name: "reviewer",
    })

    expect(config.command).toBe("codex --model gpt-5.6-terra")
    expect(config.agentReadyPattern).toBe("Codex")
    expect(config.updateCommand).toBe("codex update")
  })

  it("resolves cursor with cursor-agent cli", () => {
    const config = resolveAgentConfig({
      agent: "cursor",
      model: "composer",
      name: "implementer",
    })

    expect(config.command).toBe("cursor-agent --model composer")
    expect(config.agentReadyPattern).toBe("Cursor Agent")
    expect(config.updateCommand).toBe("cursor-agent update")
  })

  it("resolves claude with updateCommand", () => {
    const config = resolveAgentConfig({
      agent: "claude",
      model: "haiku",
      name: "implementer",
    })

    expect(config.command).toBe("claude --model haiku")
    expect(config.agentReadyPattern).toBe("Claude")
    expect(config.updateCommand).toBe("claude update")
  })

  it("throws for unknown agent", () => {
    expect(() =>
      resolveAgentConfig({ agent: "unknown", model: "x", name: "impl" }),
    ).toThrow(/Unknown agent "unknown"/)
  })
})
