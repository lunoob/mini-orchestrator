import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { describe, expect, it } from "vitest"

import {
  ALIAS_MARKER_END,
  ALIAS_MARKER_START,
  ALIAS_NAME,
  buildAliasBlock,
  installAlias,
  uninstallAlias,
} from "./install-alias.js"

const MAIN_TS_PATH = "/tmp/mini-orchestrator/src/main.ts"

describe("buildAliasBlock", () => {
  it("includes alias name and main.ts path", () => {
    const block = buildAliasBlock(MAIN_TS_PATH)

    expect(block).toContain(ALIAS_MARKER_START)
    expect(block).toContain(ALIAS_MARKER_END)
    expect(block).toContain(`alias local-mini-orch='MINI_ORCH_COMMAND=local-mini-orch npx tsx ${MAIN_TS_PATH}'`)
    expect(block).toContain(`alias ${ALIAS_NAME}=`)
    expect(block).toContain(MAIN_TS_PATH)
    expect(block).not.toContain("--config")
  })
})

describe("installAlias", () => {
  it("appends alias block to an existing rc file", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "install-alias-"))
    const rcPath = path.join(tmp, ".zshrc")
    await writeFile(rcPath, "export PATH=$PATH\n", "utf8")

    const result = await installAlias(MAIN_TS_PATH, rcPath)

    expect(result.success).toBe(true)
    const content = await readFile(rcPath, "utf8")
    expect(content).toContain("export PATH=$PATH")
    expect(content).toContain(ALIAS_MARKER_START)
    expect(content).toContain(`alias ${ALIAS_NAME}=`)
  })

  it("creates rc file when it does not exist", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "install-alias-"))
    const rcPath = path.join(tmp, ".zshrc")

    const result = await installAlias(MAIN_TS_PATH, rcPath)

    expect(result.success).toBe(true)
    const content = await readFile(rcPath, "utf8")
    expect(content).toContain(ALIAS_MARKER_START)
  })

  it("returns error when alias already exists without force", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "install-alias-"))
    const rcPath = path.join(tmp, ".zshrc")
    await installAlias(MAIN_TS_PATH, rcPath)

    const result = await installAlias(MAIN_TS_PATH, rcPath)

    expect(result.success).toBe(false)
    expect(result.message).toContain("别名已存在")
  })

  it("force mode replaces existing alias block", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "install-alias-"))
    const rcPath = path.join(tmp, ".zshrc")
    await installAlias("/old/main.ts", rcPath)

    const result = await installAlias(MAIN_TS_PATH, rcPath, { force: true })

    expect(result.success).toBe(true)
    const content = await readFile(rcPath, "utf8")
    expect(content).not.toContain("/old/main.ts")
    expect(content).toContain(MAIN_TS_PATH)
    expect(content.match(new RegExp(escapeRegExp(ALIAS_MARKER_START), "g"))).toHaveLength(1)
  })
})

describe("uninstallAlias", () => {
  it("removes alias block from rc file", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "install-alias-"))
    const rcPath = path.join(tmp, ".zshrc")
    await writeFile(rcPath, "export FOO=1\n", "utf8")
    await installAlias(MAIN_TS_PATH, rcPath)

    const result = await uninstallAlias(rcPath)

    expect(result.success).toBe(true)
    const content = await readFile(rcPath, "utf8")
    expect(content).toBe("export FOO=1\n")
    expect(content).not.toContain(ALIAS_MARKER_START)
  })

  it("returns error when alias is not installed", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "install-alias-"))
    const rcPath = path.join(tmp, ".zshrc")
    await writeFile(rcPath, "export FOO=1\n", "utf8")

    const result = await uninstallAlias(rcPath)

    expect(result.success).toBe(false)
    expect(result.message).toContain("未安装别名")
  })
})

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
