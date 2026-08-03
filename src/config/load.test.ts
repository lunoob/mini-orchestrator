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

const FINAL_GATE_BASE = {
  reviewer: { name: "final-rev", agent: "codex", model: "gpt-5.5" },
  fixer: { name: "final-fix", agent: "codex", model: "gpt-5.5" },
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

  it("defaults issue state to ready when omitted", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const spec = createSpec(dir, "spec.md")
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
      issues: [{ title: "Issue", specPath: spec }],
    })

    const config = await loadConfig(configPath, {})

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

    const config = await loadConfig(configPath, {})

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

    await expect(loadConfig(configPath, {})).rejects.toThrow(
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
      implementer: { name: "implementer", agent: "cursor", model: "composer" },
      reviewer: { name: "reviewer", agent: "codex", model: "gpt-5.6-terra" },
      issues: [{ title: "Issue", specPath: spec }],
    })

    const config = await loadConfig(configPath, {})

    expect(config.implementer.command).toBe("cursor-agent --trust --yolo --model composer")
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

describe("finalGate", () => {
  it("is disabled when absent and does not require final roles", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const configPath = writeConfigWithSpec(dir)

    const config = await loadConfig(configPath, {})

    expect(config.finalGate).toBeUndefined()
  })

  it("is disabled when enabled is false and does not require final roles", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const configPath = writeConfigWithSpec(dir, { finalGate: { enabled: false } })

    const config = await loadConfig(configPath, {})

    expect(config.finalGate).toBeUndefined()
  })

  it("throws when enabled finalGate is missing reviewer", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const configPath = writeConfigWithSpec(dir, {
      finalGate: { fixer: FINAL_GATE_BASE.fixer },
    })

    await expect(loadConfig(configPath, {})).rejects.toThrow(/finalGate\.reviewer is required/)
  })

  it("throws when enabled finalGate is missing fixer", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const configPath = writeConfigWithSpec(dir, {
      finalGate: { reviewer: FINAL_GATE_BASE.reviewer },
    })

    await expect(loadConfig(configPath, {})).rejects.toThrow(/finalGate\.fixer is required/)
  })

  it("throws when finalGate.reviewer is missing agent", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const configPath = writeConfigWithSpec(dir, {
      finalGate: { reviewer: { name: "final-rev" }, fixer: FINAL_GATE_BASE.fixer },
    })

    await expect(loadConfig(configPath, {})).rejects.toThrow(/finalGate\.reviewer\.agent is required/)
  })

  it("throws when finalGate.fixer is missing name", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const configPath = writeConfigWithSpec(dir, {
      finalGate: { reviewer: FINAL_GATE_BASE.reviewer, fixer: { agent: "codex" } },
    })

    await expect(loadConfig(configPath, {})).rejects.toThrow(/finalGate\.fixer\.name is required/)
  })

  it("rejects non-positive-integer maxRounds", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const configPath = writeConfigWithSpec(dir, {
      finalGate: { ...FINAL_GATE_BASE, maxRounds: 0 },
    })

    await expect(loadConfig(configPath, {})).rejects.toThrow(/finalGate\.maxRounds must be a positive integer/)

    const configPath2 = writeConfigWithSpec(dir, {
      finalGate: { ...FINAL_GATE_BASE, maxRounds: 1.5 },
    })
    await expect(loadConfig(configPath2, {})).rejects.toThrow(/finalGate\.maxRounds must be a positive integer/)
  })

  it("defaults maxRounds to 3 and is not affected by --maxReviewRounds", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const configPath = writeConfigWithSpec(dir, { finalGate: { ...FINAL_GATE_BASE } })

    const config = await loadConfig(configPath, { maxReviewRounds: "99" })

    expect(config.maxReviewRounds).toBe(99)
    expect(config.finalGate?.maxRounds).toBe(3)
  })

  it("resolves final role agent configs via resolveAgentConfig", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const configPath = writeConfigWithSpec(dir, { finalGate: { ...FINAL_GATE_BASE } })

    const config = await loadConfig(configPath, {})

    expect(config.finalGate?.reviewer.command).toBe("codex --model gpt-5.5")
    expect(config.finalGate?.reviewer.integrationAgent).toBe("codex")
    expect(config.finalGate?.fixer.command).toBe("codex --model gpt-5.5")
    expect(config.finalGate?.fixer.integrationAgent).toBe("codex")
  })

  it("defaults final prompt paths and keeps custom overrides", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const configPath = writeConfigWithSpec(dir, {
      finalGate: { ...FINAL_GATE_BASE, prompts: { review: "./custom-final-review.md" } },
    })

    const config = await loadConfig(configPath, {})

    expect(config.finalGate?.prompts.review).toBe("./custom-final-review.md")
    expect(config.finalGate?.prompts.fix).toContain("prompts/final-fix.md")
  })
})
