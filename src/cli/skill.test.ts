import { afterEach, describe, expect, it, vi } from "vitest"

import { parseSkillAction, runSkillCli } from "./skill.js"

describe("parseSkillAction", () => {
  it("supports install, uninstall, and list subcommands", () => {
    expect(parseSkillAction(["install"])).toBe("install")
    expect(parseSkillAction(["uninstall"])).toBe("uninstall")
    expect(parseSkillAction(["list"])).toBe("list")
  })

  it("keeps the legacy uninstall flag for the package script", () => {
    expect(parseSkillAction(["--uninstall"])).toBe("uninstall")
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
