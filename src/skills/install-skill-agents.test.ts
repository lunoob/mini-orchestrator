import { access, constants, lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { getAgentTargetDir } from "./agent-targets.js"
import { installSelectedSkillsForAgents, uninstallSelectedSkillsForAgents } from "./install-skill.js"

const createSource = async (dir: string) => {
  const sourceDir = path.join(dir, "source")
  const skillDir = path.join(sourceDir, "alpha")
  await mkdir(skillDir, { recursive: true })
  await writeFile(path.join(skillDir, "SKILL.md"), "# Alpha\n", "utf8")
  return sourceDir
}

describe("agent-specific skill installation", () => {
  it("installs each selected skill into every selected agent", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "agent-install-"))
    const sourceDir = await createSource(tmp)

    const results = await installSelectedSkillsForAgents(
      sourceDir,
      ["codex", "cursor"],
      ["alpha"],
      { mode: "symlink" },
      tmp,
    )

    expect(results).toHaveLength(2)
    expect(results.every(result => result.success)).toBe(true)
    await expect(lstat(path.join(getAgentTargetDir("codex", tmp), "alpha"))).resolves.toBeDefined()
    await expect(lstat(path.join(getAgentTargetDir("cursor", tmp), "alpha"))).resolves.toBeDefined()
  })

  it("uninstalls a selected skill only from selected agents", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "agent-uninstall-"))
    const sourceDir = await createSource(tmp)

    await installSelectedSkillsForAgents(
      sourceDir,
      ["codex", "cursor"],
      ["alpha"],
      { mode: "symlink" },
      tmp,
    )

    const results = await uninstallSelectedSkillsForAgents(
      ["codex"],
      ["alpha"],
      undefined,
      tmp,
    )

    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
    await expect(access(path.join(getAgentTargetDir("codex", tmp), "alpha"), constants.F_OK)).rejects.toThrow()
    await expect(access(path.join(getAgentTargetDir("cursor", tmp), "alpha"), constants.F_OK)).resolves.toBeUndefined()
  })
})
