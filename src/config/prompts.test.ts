import { mkdtempSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { describe, expect, it } from "vitest"

import { loadPrompts } from "./load.js"
import type { WorkflowConfig } from "../types.js"

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..")

const buildMinimalConfig = (dir: string, overrides: Record<string, string> = {}): WorkflowConfig => ({
  implementer: { name: "impl", agent: "codex", model: "gpt-5.5", command: "codex --model gpt-5.5", integrationAgent: "codex" },
  reviewer: { name: "rev", agent: "codex", model: "gpt-5.5", command: "codex --model gpt-5.5", integrationAgent: "codex" },
  maxReviewRounds: 8,
  projectDir: dir,
  issues: [{ title: "Test", specPath: path.join(dir, "spec.md") }],
  prompts: {
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

    // prompt 包含 STATUS 指令，不包含分隔线标记
    expect(prompts.implement).toContain("IMPLEMENT_DONE")
    expect(prompts.implement).toContain("IMPLEMENT_ASK")
    expect(prompts.implement).not.toContain("{{outputFormat}}")

    expect(prompts.review).toContain("REVIEW_PASS")
    expect(prompts.review).toContain("REVIEW_FAIL")
    expect(prompts.review).toContain("REVIEW_NEEDS_CHECK")
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
  })
})
