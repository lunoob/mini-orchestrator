import { mkdtempSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { describe, expect, it } from "vitest"

import { loadConfig } from "./load.js"

const createConfig = (dir: string, config: Record<string, unknown>) => {
  const specPath = path.join(dir, "spec.md")
  writeFileSync(specPath, "# spec", "utf8")

  const configPath = path.join(dir, "workflow.json")
  writeFileSync(configPath, JSON.stringify({ ...config, projectDir: dir, issues: [{ title: "Issue", specPath }] }), "utf8")
  return configPath
}

const agents = {
  implementer: { name: "implementer", agent: "codex", model: "gpt-5.5" },
  reviewer: { name: "reviewer", agent: "codex", model: "gpt-5.5" },
  gateReviewer: { name: "gate-reviewer", agent: "codex", model: "gpt-5.5" },
  gateFixer: { name: "gate-fixer", agent: "codex", model: "gpt-5.5" },
}

describe("grouped workflow config", () => {
  it("loads grouped rounds, agents, prompts, and final gate toggle", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-schema-"))
    const configPath = createConfig(dir, {
      enableFinalGate: true,
      maxRounds: { workflow: 5, finalGate: 2 },
      agents,
      prompts: { finalReview: "final-review.md", finalFix: "final-fix.md" },
    })

    const config = await loadConfig(configPath)

    expect(config.enableFinalGate).toBe(true)
    expect(config.maxRounds).toEqual({ workflow: 5, finalGate: 2 })
    expect(config.agents.gateReviewer?.name).toBe("gate-reviewer")
    expect(config.agents.gateFixer?.name).toBe("gate-fixer")
    expect(config.prompts.finalReview).toBe("final-review.md")
    expect(config.prompts.finalFix).toBe("final-fix.md")
  })

  it("applies defaults when grouped optional fields are omitted", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-schema-"))
    const configPath = createConfig(dir, {
      agents: {
        implementer: agents.implementer,
        reviewer: agents.reviewer,
      },
    })

    const config = await loadConfig(configPath)

    expect(config.enableFinalGate).toBe(false)
    expect(config.maxRounds).toEqual({ workflow: 8, finalGate: 3 })
    expect(config.agents.gateReviewer).toBeUndefined()
    expect(config.agents.gateFixer).toBeUndefined()
  })

  it("rejects the legacy finalGate and agent fields", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-schema-"))
    const configPath = createConfig(dir, {
      maxReviewRounds: 4,
      implementer: agents.implementer,
      reviewer: agents.reviewer,
      finalGate: {
        maxRounds: 2,
        reviewer: agents.gateReviewer,
        fixer: agents.gateFixer,
      },
    })

    await expect(loadConfig(configPath)).rejects.toThrow(/legacy|agents|enableFinalGate/i)
  })
})
