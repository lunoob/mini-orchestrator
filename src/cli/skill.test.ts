import { afterEach, describe, expect, it, vi } from "vitest"

import {
  getSkillSelectionCancelledMessage,
  parseSkillAction,
  parseSkillAgents,
  runSkillCli,
  selectInstalledAgents,
} from "./skill.js"

describe("parseSkillAction", () => {
  it("supports install, uninstall, and list subcommands", () => {
    expect(parseSkillAction(["install"])).toBe("install")
    expect(parseSkillAction(["uninstall"])).toBe("uninstall")
    expect(parseSkillAction(["list"])).toBe("list")
  })

  it("does not support the legacy uninstall flag", () => {
    expect(parseSkillAction(["--uninstall"])).toBeUndefined()
  })
})

describe("parseSkillAgents", () => {
  it("parses repeated agent flags", () => {
    expect(parseSkillAgents(["--agent", "codex", "--agent", "cursor"])).toEqual([
      "codex",
      "cursor",
    ])
  })

  it("rejects unsupported agents", () => {
    expect(parseSkillAgents(["--agent", "windsurf"])).toBeUndefined()
  })
})

describe("selectInstalledAgents", () => {
  it("returns only agents that have one of the selected skills installed", () => {
    expect(selectInstalledAgents([
      { name: "alpha", installedAgents: ["cursor"] },
      { name: "beta", installedAgents: ["codex"] },
    ], ["beta"])).toEqual(["codex"])
  })
})

describe("getSkillSelectionCancelledMessage", () => {
  it("describes the action that was cancelled", () => {
    expect(getSkillSelectionCancelledMessage("install")).toBe("[Skill] 未选择要安装的 skill，已取消")
    expect(getSkillSelectionCancelledMessage("uninstall")).toBe("[Skill] 未选择要卸载的 skill，已取消")
  })
})

describe("skill help", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("shows the canonical command name", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)

    await runSkillCli(["--help"], "mini-orch")

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage: mini-orch skill <command> [options]"))
  })
})
