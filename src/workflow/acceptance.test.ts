import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { sendTaskAndMonitor } from "../agent/index.js"
import { createWorkflowEventBus } from "./events.js"
import { runAcceptance, shouldRunAcceptance } from "./acceptance.js"
import type { WorkflowRuntime } from "./types.js"

vi.mock("../agent/index.js", () => ({
  sendTaskAndMonitor: vi.fn(async () => ({
    finalText: "done\nSTATUS: REVIEW_PASS",
    status: "completed",
    finalOffset: 1,
  })),
}))

vi.mock("./review-loop.js", () => ({
  handleMonitorResult: vi.fn(async () => "done\nSTATUS: REVIEW_PASS"),
}))

const buildRuntime = (overrides: Partial<WorkflowRuntime> = {}): WorkflowRuntime => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "acceptance-test-"))
  const configPath = path.join(dir, "workflow.json")
  writeFileSync(configPath, "{}", "utf8")

  return {
    args: {},
    baseSha: undefined,
    config: {
      agents: {
        implementer: { name: "impl", agent: "codex", command: "codex", integrationAgent: "codex" },
        reviewer: { name: "rev", agent: "codex", command: "codex", integrationAgent: "codex" },
        gateReviewer: { name: "final-rev", agent: "codex", command: "codex", integrationAgent: "codex" },
      },
      enableAcceptanceReport: true,
      enableFinalGate: true,
      maxRounds: { workflow: 8, finalGate: 3 },
      projectDir: dir,
      prompts: {
        acceptance: "", implement: "", review: "", revise: "", reReview: "",
        controllerImplementer: "", controllerReReview: "", postReviewCheck: "",
        finalPostCheck: "", finalReview: "", finalFix: "",
      },
      issues: [{ title: "Issue", specPath: path.join(dir, "spec.md") }],
      title: "Test Workflow",
    },
    configPath,
    eventBus: createWorkflowEventBus(),
    finalFixerTouched: false,
    finalFixerPane: "",
    finalReviewerPane: "pane-final-rev",
    finalReviewerSession: { provider: "codex", resumeId: "r1", jsonl: "/tmp/r1.jsonl", offset: 0 },
    hasGit: false,
    implementerPane: "",
    issueIndex: 0,
    prompts: {
      acceptance: "acceptance {{reportPath}} {{title}} {{specs}} {{headSha}} {{generatedAt}}",
      implement: "", review: "", revise: "", reReview: "",
      controllerImplementer: "", controllerReReview: "", postReviewCheck: "",
      finalPostCheck: "", finalReview: "", finalFix: "",
    },
    reviewerPane: "pane-rev",
    reviewerSession: { provider: "codex", resumeId: "r2", jsonl: "/tmp/r2.jsonl", offset: 0 },
    startBaseSha: undefined,
    ...overrides,
  }
}

describe("shouldRunAcceptance", () => {
  it("is disabled when enableAcceptanceReport is false", () => {
    const runtime = buildRuntime({
      config: { ...buildRuntime().config, enableAcceptanceReport: false },
    })
    expect(shouldRunAcceptance(runtime)).toBe(false)
  })

  it("runs for final gate workflows", () => {
    expect(shouldRunAcceptance(buildRuntime())).toBe(true)
  })

  it("runs for single-issue workflows without final gate", () => {
    const runtime = buildRuntime({
      config: {
        ...buildRuntime().config,
        enableFinalGate: false,
        issues: [{ title: "Only", specPath: "/tmp/spec.md" }],
      },
    })
    expect(shouldRunAcceptance(runtime)).toBe(true)
  })
})

describe("runAcceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("uses the gate reviewer session and logs the report path", async () => {
    const runtime = buildRuntime()
    const dir = runtime.config.projectDir
    const reportPath = path.join(dir, ".orchestrator", "workflow", "acceptance.md")
    mkdirSync(path.dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, "# report", "utf8")

    const logs: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => { logs.push(String(args[0])) }

    try {
      await runAcceptance(runtime, "gateReviewer")
    } finally {
      console.log = originalLog
    }

    expect(sendTaskAndMonitor).toHaveBeenCalledWith(
      "pane-final-rev",
      expect.stringContaining(reportPath),
      runtime.finalReviewerSession,
    )
    expect(logs.some((line) => line.includes(`[Acceptance] Report written: ${reportPath}`))).toBe(true)
  })
})
