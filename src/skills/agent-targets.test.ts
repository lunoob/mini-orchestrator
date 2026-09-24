import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { AGENT_TARGETS, getAgentDisplayPath, getAgentTargetDir } from "./agent-targets.js"

describe("agent skill targets", () => {
  it("supports the three configured coding agents", () => {
    expect(AGENT_TARGETS.map(agent => agent.id)).toEqual([
      "codex",
      "claude-code",
      "cursor",
    ])
  })

  it("resolves each agent to its global skills directory", () => {
    const homeDir = path.join(os.tmpdir(), "skill-target-home")

    expect(getAgentTargetDir("codex", homeDir)).toBe(path.join(homeDir, ".codex", "skills"))
    expect(getAgentTargetDir("claude-code", homeDir)).toBe(path.join(homeDir, ".claude", "skills"))
    expect(getAgentTargetDir("cursor", homeDir)).toBe(path.join(homeDir, ".cursor", "skills"))
  })

  it("formats global skills directories with a portable home shorthand", () => {
    expect(getAgentDisplayPath("codex", "/Users/example")).toBe("~/.codex/skills")
    expect(getAgentDisplayPath("claude-code", "/Users/example")).toBe("~/.claude/skills")
    expect(getAgentDisplayPath("cursor", "/Users/example")).toBe("~/.cursor/skills")
  })
})
