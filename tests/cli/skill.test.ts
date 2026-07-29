import { describe, expect, it } from "vitest"

import { parseSkillAction } from "@src/cli/skill"

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
