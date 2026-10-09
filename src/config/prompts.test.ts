import { mkdtempSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { describe, expect, it } from "vitest"

import { loadPrompts } from "./load.js"
import type { WorkflowConfig } from "../types.js"

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..")

type ConfigOverrides = {
  enableAcceptanceReport?: boolean
  implement?: string
  review?: string
  revise?: string
  outputFormatImplement?: string
  outputFormatReview?: string
  finalReview?: string
  finalFix?: string
  enableFinalGate?: boolean
}

const buildMinimalConfig = (dir: string, overrides: ConfigOverrides = {}): WorkflowConfig => ({
  agents: {
    implementer: { name: "impl", agent: "codex", model: "gpt-5.5", command: "codex --model gpt-5.5", integrationAgent: "codex" },
    reviewer: { name: "rev", agent: "codex", model: "gpt-5.5", command: "codex --model gpt-5.5", integrationAgent: "codex" },
    gateReviewer: { name: "final-rev", agent: "codex", model: "gpt-5.5", command: "codex --model gpt-5.5", integrationAgent: "codex" },
    gateFixer: { name: "final-fix", agent: "codex", model: "gpt-5.5", command: "codex --model gpt-5.5", integrationAgent: "codex" },
  },
  enableAcceptanceReport: overrides.enableAcceptanceReport ?? true,
  enableFinalGate: overrides.enableFinalGate ?? true,
  maxRounds: { workflow: 8, finalGate: 3 },
  projectDir: dir,
  issues: [{ title: "Test", specPath: path.join(dir, "spec.md") }],
  prompts: {
    finalReview: overrides.finalReview ?? path.join(PROJECT_ROOT, "prompts/final-review.md"),
    finalFix: overrides.finalFix ?? path.join(PROJECT_ROOT, "prompts/final-fix.md"),
    implement: overrides.implement ?? path.join(PROJECT_ROOT, "prompts/implement.md"),
    review: overrides.review ?? path.join(PROJECT_ROOT, "prompts/review.md"),
    revise: overrides.revise ?? path.join(PROJECT_ROOT, "prompts/revise.md"),
    outputFormatImplement: overrides.outputFormatImplement,
    outputFormatReview: overrides.outputFormatReview,
  },
})

describe("loadPrompts", () => {
  it("injects default output partials with STATUS instructions", async () => {
    const config = buildMinimalConfig(PROJECT_ROOT)

    const prompts = await loadPrompts(config, PROJECT_ROOT)

    // prompt 包含 STATUS 指令
    expect(prompts.implement).toContain("STATUS: IMPLEMENT_DONE")
    expect(prompts.implement).not.toContain("{{outputFormat}}")

    expect(prompts.review).toContain("STATUS: REVIEW_PASS")
    expect(prompts.review).not.toContain("{{outputFormat}}")
  })

  it("supports custom output format partials", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "prompts-test-"))
    const customImplementPartial = path.join(dir, "custom-implement-output.md")
    const customReviewPartial = path.join(dir, "custom-review-output.md")

    writeFileSync(
      customImplementPartial,
      "CUSTOM IMPLEMENT OUTPUT: use STATUS: IMPLEMENT_DONE",
      "utf8",
    )
    writeFileSync(
      customReviewPartial,
      "CUSTOM REVIEW OUTPUT: use STATUS: REVIEW_PASS",
      "utf8",
    )

    const config = buildMinimalConfig(dir, {
      outputFormatImplement: customImplementPartial,
      outputFormatReview: customReviewPartial,
    })

    const prompts = await loadPrompts(config, dir)

    // 自定义 partial 被注入到 prompt 中
    expect(prompts.implement).toContain("CUSTOM IMPLEMENT OUTPUT")
    expect(prompts.review).toContain("CUSTOM REVIEW OUTPUT")
  })

  it("preserves runtime placeholders after outputFormat injection", async () => {
    const config = buildMinimalConfig(PROJECT_ROOT)

    const prompts = await loadPrompts(config, PROJECT_ROOT)

    expect(prompts.implement).toContain("{{specPath}}")
    expect(prompts.implement).not.toContain("{{outputFormat}}")
    expect(prompts.review).toContain("{{specPath}}")
    expect(prompts.revise).toContain("{{round}}")
    expect(prompts.revise).toContain("{{reviewOutput}}")
    expect(prompts.controllerImplementer).toContain("{{controllerNotes}}")
    expect(prompts.postReviewCheck).toContain("{{reviewStatus}}")
    expect(prompts.postReviewCheck).toContain("TypeScript 类型检查")
    expect(prompts.postReviewCheck).not.toContain("{{postCheckBody}}")
    expect(prompts.finalPostCheck).toContain("Final Fixer")
    expect(prompts.finalPostCheck).not.toContain("{{postCheckBody}}")
    expect(prompts.acceptance).toContain("{{reportPath}}")
    expect(prompts.acceptance).not.toContain("{{outputFormat}}")
  })

  it("injects STATUS output partials into default final prompts", async () => {
    const config = buildMinimalConfig(PROJECT_ROOT)

    const prompts = await loadPrompts(config, PROJECT_ROOT)

    // final review 注入 review-output partial（REVIEW_* 状态），final fix 注入 implement-output partial
    expect(prompts.finalReview).toContain("STATUS: REVIEW_PASS")
    expect(prompts.finalReview).toContain("STATUS: REVIEW_FAIL")
    expect(prompts.finalReview).not.toContain("{{outputFormat}}")
    expect(prompts.finalFix).toContain("STATUS: IMPLEMENT_DONE")
    expect(prompts.finalFix).toContain("STATUS: IMPLEMENT_ASK")
    expect(prompts.finalFix).not.toContain("{{outputFormat}}")
  })

  it("loads default final prompts when final gate is disabled", async () => {
    const config = buildMinimalConfig(PROJECT_ROOT, { enableFinalGate: false })

    const prompts = await loadPrompts(config, PROJECT_ROOT)

    expect(prompts.finalReview).toContain("STATUS: REVIEW_PASS")
    expect(prompts.finalFix).toContain("STATUS: IMPLEMENT_DONE")
  })

  it("applies custom output format partials to final prompts", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "prompts-test-"))
    const customImplementPartial = path.join(dir, "custom-implement-output.md")
    const customReviewPartial = path.join(dir, "custom-review-output.md")

    writeFileSync(
      customImplementPartial,
      "CUSTOM IMPLEMENT OUTPUT: use STATUS: IMPLEMENT_DONE",
      "utf8",
    )
    writeFileSync(
      customReviewPartial,
      "CUSTOM REVIEW OUTPUT: use STATUS: REVIEW_PASS",
      "utf8",
    )

    const config = buildMinimalConfig(dir, {
      outputFormatImplement: customImplementPartial,
      outputFormatReview: customReviewPartial,
    })

    const prompts = await loadPrompts(config, dir)

    expect(prompts.finalReview).toContain("CUSTOM REVIEW OUTPUT")
    expect(prompts.finalFix).toContain("CUSTOM IMPLEMENT OUTPUT")
  })

  it("supports custom final prompt paths", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "prompts-test-"))
    const customReview = path.join(dir, "custom-final-review.md")
    const customFix = path.join(dir, "custom-final-fix.md")
    writeFileSync(customReview, "CUSTOM FINAL REVIEW BODY {{round}} {{specs}}", "utf8")
    writeFileSync(customFix, "CUSTOM FINAL FIX BODY {{round}} {{reviewOutput}}", "utf8")

    const config = buildMinimalConfig(dir, { finalReview: customReview, finalFix: customFix })

    const prompts = await loadPrompts(config, dir)

    expect(prompts.finalReview).toContain("CUSTOM FINAL REVIEW BODY")
    expect(prompts.finalFix).toContain("CUSTOM FINAL FIX BODY")
  })

  it("preserves runtime placeholders in final prompts after injection", async () => {
    const config = buildMinimalConfig(PROJECT_ROOT)

    const prompts = await loadPrompts(config, PROJECT_ROOT)

    expect(prompts.finalReview).toContain("{{specs}}")
    expect(prompts.finalReview).toContain("{{round}}")
    expect(prompts.finalReview).toContain("{{lastReviewSection}}")
    expect(prompts.finalReview).toContain("{{diffFileSection}}")
    expect(prompts.finalFix).toContain("{{reviewOutput}}")
    expect(prompts.finalFix).toContain("{{round}}")
    expect(prompts.finalFix).toContain("{{specPaths}}")
  })
})
