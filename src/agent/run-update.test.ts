import { describe, expect, it } from "vitest"

import type { AgentConfig } from "../types.js"
import { runAgentUpdate } from "./index.js"

describe("runAgentUpdate", () => {
  it("does not forward live progress output to the UI", async () => {
    const agent = {
      name: "codex",
      agent: "codex",
      command: "codex",
      integrationAgent: "codex",
      updateCommand: "node -e \"process.stdout.write('0%\\r100%\\n')\"",
    } as AgentConfig

    await expect(runAgentUpdate(process.cwd(), agent)).resolves.toBe(true)
  })
})
