import { mkdtempSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { describe, expect, it } from "vitest"

import { loadConfig } from "./load.js"

const MINIMAL_CONFIG_BASE = {
  enableFinalGate: true,
  maxRounds: { workflow: 8, finalGate: 3 },
  agents: {
    implementer: { name: "impl", agent: "codex", model: "gpt-5.5" },
    reviewer: { name: "rev", agent: "codex", model: "gpt-5.5" },
    gateReviewer: { name: "final-rev", agent: "codex", model: "gpt-5.5" },
    gateFixer: { name: "final-fix", agent: "codex", model: "gpt-5.5" },
  },
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

/** 写入包含单个 issue 的配置，overrides 直接覆盖顶层字段 */
const writeConfigWithSpec = (dir: string, overrides: Record<string, unknown> = {}) => {
  const specPath = createSpec(dir, "spec.md")
  return writeTempConfig(dir, {
    ...MINIMAL_CONFIG_BASE,
    projectDir: dir,
    issues: [{ title: "Issue", specPath }],
    ...overrides,
  })
}

describe("loadConfig", () => {
  it("throws if issues array is missing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
    })

    await expect(loadConfig(configPath)).rejects.toThrow("issues is required")
  })

  it("throws if issues array is empty", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
      issues: [],
    })

    await expect(loadConfig(configPath)).rejects.toThrow("issues is required")
  })

  it("validates each issue has title and specPath", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
      issues: [{ title: "Only title" }],
    })

    await expect(loadConfig(configPath)).rejects.toThrow(/issues\[0\].specPath is required/)
  })

  it("validates each issue has title", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
      issues: [{ specPath: "/tmp/nonexistent/nope.md" }],
    })

    await expect(loadConfig(configPath)).rejects.toThrow(/issues\[0\].title is required/)
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

    const config = await loadConfig(configPath)

    expect(config.issues).toHaveLength(2)
    expect(config.issues[0].title).toBe("Issue One")
    expect(config.issues[0].specPath).toBe(spec1)
    expect(config.issues[1].title).toBe("Issue Two")
    expect(config.issues[1].specPath).toBe(spec2)
  })

  it("defaults issue state to ready when omitted", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const spec = createSpec(dir, "spec.md")
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
      issues: [{ title: "Issue", specPath: spec }],
    })

    const config = await loadConfig(configPath)

    expect(config.issues[0].state).toBe("ready")
  })

  it("preserves explicit issue state ready, review and finish", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const spec1 = createSpec(dir, "spec1.md")
    const spec2 = createSpec(dir, "spec2.md")
    const spec3 = createSpec(dir, "spec3.md")
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
      issues: [
        { title: "Done", specPath: spec1, state: "finish" },
        { title: "InReview", specPath: spec2, state: "review" },
        { title: "Todo", specPath: spec3, state: "ready" },
      ],
    })

    const config = await loadConfig(configPath)

    expect(config.issues[0].state).toBe("finish")
    expect(config.issues[1].state).toBe("review")
    expect(config.issues[2].state).toBe("ready")
  })

  it("throws if issue state is invalid", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const spec = createSpec(dir, "spec.md")
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
      issues: [{ title: "Issue", specPath: spec, state: "done" }],
    })

    await expect(loadConfig(configPath)).rejects.toThrow(
      /issues\[0\]\.state must be one of: ready, review, finish/,
    )
  })

  it("resolves agent config from agent and model", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const spec = createSpec(dir, "spec.md")
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
      agents: {
        ...MINIMAL_CONFIG_BASE.agents,
        implementer: { name: "implementer", agent: "cursor", model: "composer" },
        reviewer: { name: "reviewer", agent: "codex", model: "gpt-5.6-terra" },
      },
      issues: [{ title: "Issue", specPath: spec }],
    })

    const config = await loadConfig(configPath)

    expect(config.agents.implementer.command).toBe("cursor-agent --trust --yolo --model composer")
    expect(config.agents.implementer.integrationAgent).toBe("cursor")
    expect(config.agents.implementer.updateCommand).toBe("cursor-agent update")
    expect(config.agents.reviewer.command).toBe("codex --model gpt-5.6-terra")
    expect(config.agents.reviewer.integrationAgent).toBe("codex")
    expect(config.agents.reviewer.updateCommand).toBe("codex update")
  })

  it("throws if issue spec file does not exist", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const missing = path.join(dir, "missing.md")
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
      issues: [{ title: "Bad", specPath: missing }],
    })

    await expect(loadConfig(configPath)).rejects.toThrow(/Issue 0 spec file not found/)
  })
})

describe("final gate", () => {
  it("is disabled by default", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeConfigWithSpec(dir, { enableFinalGate: false })

    const config = await loadConfig(configPath)

    expect(config.enableFinalGate).toBe(false)
  })

  it("rejects a non-boolean enableFinalGate", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeConfigWithSpec(dir, { enableFinalGate: "false" })

    await expect(loadConfig(configPath)).rejects.toThrow(/enableFinalGate must be a boolean/)
  })

  it("requires gate agents when final gate is enabled", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeConfigWithSpec(dir, {
      agents: {
        implementer: MINIMAL_CONFIG_BASE.agents.implementer,
        reviewer: MINIMAL_CONFIG_BASE.agents.reviewer,
      },
      enableFinalGate: true,
    })

    await expect(loadConfig(configPath)).rejects.toThrow(/agents\.gateReviewer is required/)
  })

  it("validates grouped final gate rounds", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeConfigWithSpec(dir, { maxRounds: { workflow: 8, finalGate: 0 } })

    await expect(loadConfig(configPath)).rejects.toThrow(/maxRounds\.finalGate/)
  })

  it("loads grouped rounds and final gate agents", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeConfigWithSpec(dir)

    const config = await loadConfig(configPath)

    expect(config.maxRounds).toEqual({ workflow: 8, finalGate: 3 })
    expect(config.agents.gateReviewer?.command).toBe("codex --model gpt-5.5")
    expect(config.agents.gateReviewer?.integrationAgent).toBe("codex")
    expect(config.agents.gateFixer?.command).toBe("codex --model gpt-5.5")
    expect(config.agents.gateFixer?.integrationAgent).toBe("codex")
  })

  it("loads grouped final prompt paths", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeConfigWithSpec(dir, {
      prompts: { finalReview: "./custom-final-review.md" },
    })

    const config = await loadConfig(configPath)

    expect(config.prompts.finalReview).toBe("./custom-final-review.md")
    expect(config.prompts.finalFix).toContain("prompts/final-fix.md")
  })
})
