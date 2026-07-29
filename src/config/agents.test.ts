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
  })

  it("resolves codex with effort", () => {
    const config = resolveAgentConfig({
      agent: "codex",
      effort: "high",
      model: "gpt-5.6-terra",
      name: "reviewer",
    })

    expect(config.command).toBe(
      'codex --model gpt-5.6-terra -c model_reasoning_effort="high"',
    )
    expect(config.effort).toBe("high")
  })

  it("resolves cursor with cursor-agent cli", () => {
    const config = resolveAgentConfig({
      agent: "cursor",
      model: "composer",
      name: "implementer",
    })

    expect(config.command).toBe("cursor-agent --model composer")
  })

  it("throws when cursor has effort field", () => {
    expect(() =>
      resolveAgentConfig({
        agent: "cursor",
        effort: "high",
        model: "composer-2.5",
        name: "implementer",
      }),
    ).toThrow(/effort is not supported for cursor/)
  })

  it("resolves claude with effort", () => {
    const config = resolveAgentConfig({
      agent: "claude",
      effort: "high",
      model: "haiku",
      name: "implementer",
    })

    expect(config.command).toBe("claude --model haiku --effort high")
    expect(config.effort).toBe("high")
  })

  it("throws for invalid codex effort", () => {
    expect(() =>
      resolveAgentConfig({
        agent: "codex",
        effort: "max",
        model: "gpt-5.6-terra",
        name: "reviewer",
      }),
    ).toThrow(/Invalid reviewer\.effort "max"/)
  })

  it("throws for unknown agent", () => {
    expect(() =>
      resolveAgentConfig({ agent: "unknown", model: "x", name: "impl" }),
    ).toThrow(/Unknown agent "unknown"/)
  })
})
