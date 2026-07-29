import { mkdtempSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { describe, expect, it, vi } from "vitest"

import { loadConfig, loadPrompts } from "@src/config/load"
import type { WorkflowConfig } from "@src/types"

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..")

const buildMinimalConfig = (dir: string, overrides: Record<string, string> = {}): WorkflowConfig => ({
  implementer: { name: "impl", agent: "codex", model: "gpt-5.5", command: "codex --model gpt-5.5" },
  reviewer: { name: "rev", agent: "codex", model: "gpt-5.5", command: "codex --model gpt-5.5" },
  maxReviewRounds: 8,
  projectDir: dir,
  issues: [{ title: "Test", specPath: path.join(dir, "spec.md") }],
  prompts: {
    implement: overrides.implement ?? path.join(PROJECT_ROOT, "prompts/implement.md"),
    review: overrides.review ?? path.join(PROJECT_ROOT, "prompts/review.md"),
    revise: overrides.revise ?? path.join(PROJECT_ROOT, "prompts/revise.md"),
  },
})

describe("loadPrompts", () => {
  it("loads prompts without output format injection", async () => {
    const config = buildMinimalConfig(PROJECT_ROOT)

    const prompts = await loadPrompts(config, PROJECT_ROOT)

    // prompts 不应包含旧的 outputFormat 占位符
    expect(prompts.implement).not.toContain("{{outputFormat}}")
    expect(prompts.review).not.toContain("{{outputFormat}}")

    // prompts 应包含 JSON outcome 格式说明
    expect(prompts.implement).toContain("JSON")
    expect(prompts.implement).toContain("outcome")
    expect(prompts.review).toContain("verdict")
  })

  it("preserves runtime placeholders", async () => {
    const config = buildMinimalConfig(PROJECT_ROOT)

    const prompts = await loadPrompts(config, PROJECT_ROOT)

    expect(prompts.implement).toContain("{{specPath}}")
    expect(prompts.review).toContain("{{specPath}}")
    expect(prompts.revise).toContain("{{round}}")
    expect(prompts.revise).toContain("{{reviewOutput}}")
    expect(prompts.controllerImplementer).toContain("{{controllerNotes}}")
    expect(prompts.postReviewCheck).toContain("{{reviewStatus}}")
  })

  it("does not contain STATUS markers or delimiters", async () => {
    const config = buildMinimalConfig(PROJECT_ROOT)

    const prompts = await loadPrompts(config, PROJECT_ROOT)

    // 不应包含旧的 STATUS 标记
    expect(prompts.implement).not.toContain("STATUS: IMPLEMENT_DONE")
    expect(prompts.implement).not.toContain("STATUS: IMPLEMENT_ASK")
    expect(prompts.review).not.toContain("STATUS: REVIEW_PASS")
    expect(prompts.review).not.toContain("STATUS: REVIEW_FAIL")

    // 不应包含旧的分隔符
    expect(prompts.implement).not.toContain("---IMPLEMENT_RESULT_START---")
    expect(prompts.implement).not.toContain("---IMPLEMENT_RESULT_END---")
    expect(prompts.review).not.toContain("---REVIEW_RESULT_START---")
    expect(prompts.review).not.toContain("---REVIEW_RESULT_END---")
  })
})

describe("loadConfig deprecation warnings", () => {
  it("warns when outputFormatImplement is present in config", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "config-deprecation-test-"))
    const configPath = path.join(dir, "workflow.json")
    const specPath = path.join(dir, "spec.md")
    writeFileSync(specPath, "# spec", "utf8")

    const config = {
      implementer: { name: "impl", agent: "codex" },
      reviewer: { name: "rev", agent: "codex" },
      maxReviewRounds: 3,
      projectDir: dir,
      issues: [{ title: "Test", specPath }],
      prompts: {
        implement: path.join(PROJECT_ROOT, "prompts/implement.md"),
        review: path.join(PROJECT_ROOT, "prompts/review.md"),
        revise: path.join(PROJECT_ROOT, "prompts/revise.md"),
        outputFormatImplement: "some-old-partial.md",
      },
    }
    writeFileSync(configPath, JSON.stringify(config), "utf8")

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    try {
      await loadConfig(configPath, {})
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("outputFormatImplement"),
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("已弃用"),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("warns when outputFormatReview is present in config", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "config-deprecation-test-"))
    const configPath = path.join(dir, "workflow.json")
    const specPath = path.join(dir, "spec.md")
    writeFileSync(specPath, "# spec", "utf8")

    const config = {
      implementer: { name: "impl", agent: "codex" },
      reviewer: { name: "rev", agent: "codex" },
      maxReviewRounds: 3,
      projectDir: dir,
      issues: [{ title: "Test", specPath }],
      prompts: {
        implement: path.join(PROJECT_ROOT, "prompts/implement.md"),
        review: path.join(PROJECT_ROOT, "prompts/review.md"),
        revise: path.join(PROJECT_ROOT, "prompts/revise.md"),
        outputFormatReview: "some-old-partial.md",
      },
    }
    writeFileSync(configPath, JSON.stringify(config), "utf8")

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    try {
      await loadConfig(configPath, {})
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("outputFormatReview"),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("does not warn when deprecated fields are absent", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "config-deprecation-test-"))
    const configPath = path.join(dir, "workflow.json")
    const specPath = path.join(dir, "spec.md")
    writeFileSync(specPath, "# spec", "utf8")

    const config = {
      implementer: { name: "impl", agent: "codex" },
      reviewer: { name: "rev", agent: "codex" },
      maxReviewRounds: 3,
      projectDir: dir,
      issues: [{ title: "Test", specPath }],
      prompts: {
        implement: path.join(PROJECT_ROOT, "prompts/implement.md"),
        review: path.join(PROJECT_ROOT, "prompts/review.md"),
        revise: path.join(PROJECT_ROOT, "prompts/revise.md"),
      },
    }
    writeFileSync(configPath, JSON.stringify(config), "utf8")

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    try {
      await loadConfig(configPath, {})
      const deprecationCalls = warnSpy.mock.calls.filter(
        c => String(c[0]).includes("已弃用"),
      )
      expect(deprecationCalls).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
