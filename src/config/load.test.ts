import { mkdtempSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { describe, expect, it } from "vitest"

import { loadConfig } from "./load.js"

const MINIMAL_CONFIG_BASE = {
  maxReviewRounds: 8,
  implementer: { name: "impl", agent: "codex", model: "gpt-5.5" },
  reviewer: { name: "rev", agent: "codex", model: "gpt-5.5" },
  prompts: {
    implement: "./prompts/implement.md",
    review: "./prompts/review.md",
    revise: "./prompts/revise.md",
  },
}

const writeTempConfig = (dir: string, data: Record<string, unknown>) => {
  const configPath = path.join(dir, "workflow.json")
  writeFileSync(configPath, JSON.stringify(data, null, 2), "utf8")
  return configPath
}

/** 在目录中创建空 spec 文件，返回绝对路径 */
const createSpec = (dir: string, name: string) => {
  const specPath = path.join(dir, name)
  writeFileSync(specPath, "# spec", "utf8")
  return specPath
}

describe("loadConfig", () => {
  it("throws if issues array is missing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
    })

    await expect(loadConfig(configPath, {})).rejects.toThrow("issues is required")
  })

  it("throws if issues array is empty", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
      issues: [],
    })

    await expect(loadConfig(configPath, {})).rejects.toThrow("issues is required")
  })

  it("validates each issue has title and specPath", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
      issues: [{ title: "Only title" }],
    })

    await expect(loadConfig(configPath, {})).rejects.toThrow(/issues\[0\].specPath is required/)
  })

  it("validates each issue has title", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
      issues: [{ specPath: "/tmp/nonexistent/nope.md" }],
    })

    await expect(loadConfig(configPath, {})).rejects.toThrow(/issues\[0\].title is required/)
  })

  it("accepts valid issues", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const spec1 = createSpec(dir, "spec1.md")
    const spec2 = createSpec(dir, "spec2.md")
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
      issues: [
        { title: "Issue One", specPath: spec1 },
        { title: "Issue Two", specPath: spec2 },
      ],
    })

    const config = await loadConfig(configPath, {})

    expect(config.issues).toHaveLength(2)
    expect(config.issues[0].title).toBe("Issue One")
    expect(config.issues[0].specPath).toBe(spec1)
    expect(config.issues[1].title).toBe("Issue Two")
    expect(config.issues[1].specPath).toBe(spec2)
  })

  it("resolves agent config from agent and model", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const spec = createSpec(dir, "spec.md")
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
      implementer: { name: "implementer", agent: "cursor", model: "composer" },
      reviewer: { name: "reviewer", agent: "codex", model: "gpt-5.6-terra" },
      issues: [{ title: "Issue", specPath: spec }],
    })

    const config = await loadConfig(configPath, {})

    expect(config.implementer.command).toBe("cursor-agent --model composer")
    expect(config.implementer.agentReadyPattern).toBe("Cursor Agent")
    expect(config.implementer.integrationAgent).toBe("cursor")
    expect(config.implementer.updateCommand).toBe("cursor-agent update")
    expect(config.reviewer.command).toBe("codex --model gpt-5.6-terra")
    expect(config.reviewer.agentReadyPattern).toBe("Codex")
    expect(config.reviewer.integrationAgent).toBe("codex")
    expect(config.reviewer.updateCommand).toBe("codex update")
  })

  it("throws if issue spec file does not exist", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const missing = path.join(dir, "missing.md")
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
      issues: [{ title: "Bad", specPath: missing }],
    })

    await expect(loadConfig(configPath, {})).rejects.toThrow(/Issue 0 spec file not found/)
  })
})
