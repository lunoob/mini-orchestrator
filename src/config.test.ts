import { mkdtempSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { describe, expect, it } from "vitest"

import { loadConfig } from "./config.js"

const MINIMAL_CONFIG_BASE = {
  maxReviewRounds: 8,
  implementer: { name: "impl", command: "codex" },
  reviewer: { name: "rev", command: "codex" },
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
  it("old config without mode defaults to spec mode and works with specPath", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const specPath = createSpec(dir, "spec.md")
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
      specPath,
    })

    const config = await loadConfig(configPath, {})
    expect(config.mode).toBe("spec")
    expect(config.specPath).toBe(specPath)
  })

  it("spec mode requires specPath", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const specPath = createSpec(dir, "spec.md")
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      mode: "spec",
      projectDir: dir,
      specPath,
    })

    const config = await loadConfig(configPath, {})
    expect(config.mode).toBe("spec")
    expect(config.specPath).toBe(specPath)
  })

  it("spec mode throws if specPath is missing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      mode: "spec",
      projectDir: dir,
    })

    await expect(loadConfig(configPath, {})).rejects.toThrow("specPath is required for spec mode")
  })

  it("issue mode throws if issues array is missing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      mode: "issue",
      projectDir: dir,
    })

    await expect(loadConfig(configPath, {})).rejects.toThrow("issues is required for issue mode")
  })

  it("issue mode throws if issues array is empty", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      mode: "issue",
      projectDir: dir,
      issues: [],
    })

    await expect(loadConfig(configPath, {})).rejects.toThrow("issues is required for issue mode")
  })

  it("issue mode validates each issue has title and specPath", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      mode: "issue",
      projectDir: dir,
      issues: [{ title: "Only title" }],
    })

    await expect(loadConfig(configPath, {})).rejects.toThrow(/issues\[0\].specPath is required/)
  })

  it("issue mode validates each issue has title", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      mode: "issue",
      projectDir: dir,
      issues: [{ specPath: "/tmp/nonexistent/nope.md" }],
    })

    await expect(loadConfig(configPath, {})).rejects.toThrow(/issues\[0\].title is required/)
  })

  it("issue mode accepts valid issues", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const spec1 = createSpec(dir, "spec1.md")
    const spec2 = createSpec(dir, "spec2.md")
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      mode: "issue",
      projectDir: dir,
      issues: [
        { title: "Issue One", specPath: spec1 },
        { title: "Issue Two", specPath: spec2 },
      ],
    })

    const config = await loadConfig(configPath, {})

    expect(config.mode).toBe("issue")
    expect(config.issues).toHaveLength(2)
    expect(config.issues![0].title).toBe("Issue One")
    expect(config.issues![0].specPath).toBe(spec1)
    expect(config.issues![1].title).toBe("Issue Two")
    expect(config.issues![1].specPath).toBe(spec2)
  })

  it("issue mode with valid issues: config.specPath may be absent", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    await mkdir(dir, { recursive: true })
    const specPath = createSpec(dir, "spec.md")
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      mode: "issue",
      projectDir: dir,
      issues: [{ title: "One", specPath }],
    })

    const config = await loadConfig(configPath, {})
    expect(config.specPath).toBeUndefined()
  })

  it("CLI --mode spec overrides config with no mode and works with specPath", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const specPath = createSpec(dir, "spec.md")
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      projectDir: dir,
      specPath,
    })

    const config = await loadConfig(configPath, { mode: "spec" })
    expect(config.mode).toBe("spec")
    expect(config.specPath).toBe(specPath)
  })

  it("CLI --mode issue overrides config spec mode with valid issues", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const specPath = createSpec(dir, "spec.md")
    const issueSpec = createSpec(dir, "issue1.md")
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      mode: "spec",
      projectDir: dir,
      specPath,
      issues: [{ title: "One", specPath: issueSpec }],
    })

    const config = await loadConfig(configPath, { mode: "issue" })
    expect(config.mode).toBe("issue")
    expect(config.issues).toHaveLength(1)
    expect(config.issues![0].title).toBe("One")
    expect(config.issues![0].specPath).toBe(issueSpec)
    // CLI 覆盖 mode 为 issue 后，顶层 specPath 仍保留
    expect(config.specPath).toBe(specPath)
  })

  it("spec mode throws if spec file does not exist", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const missing = path.join(dir, "nonexistent.md")
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      mode: "spec",
      projectDir: dir,
      specPath: missing,
    })

    await expect(loadConfig(configPath, {})).rejects.toThrow(/Spec file not found/)
  })

  it("issue mode throws if issue spec file does not exist", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-test-"))
    const missing = path.join(dir, "missing.md")
    const configPath = writeTempConfig(dir, {
      ...MINIMAL_CONFIG_BASE,
      mode: "issue",
      projectDir: dir,
      issues: [{ title: "Bad", specPath: missing }],
    })

    await expect(loadConfig(configPath, {})).rejects.toThrow(/Issue 0 spec file not found/)
  })
})
