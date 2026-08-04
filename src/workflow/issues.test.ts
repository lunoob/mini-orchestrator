import { mkdtempSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { runAgentIntegration, runAgentUpdate } from "../agent/index.js"
import { runFinalGate } from "./final-gate.js"
import { runIssueQueue, runIssueQueueFromIndex, shouldNotifyIssueComplete, shouldSkipImplement, shouldSkipIssue } from "./issues.js"
import { createWorkflowEventBus } from "./events.js"
import type { WorkflowConfig } from "../types.js"
import type { WorkflowRuntime } from "./types.js"

vi.mock("../agent/index.js", () => ({
  bootstrapSession: vi.fn(async () => ({ provider: "codex", resumeId: "r", jsonl: "/tmp/r.jsonl", offset: 0 })),
  startAgentResumed: vi.fn(async () => "pane-impl"),
  sendTaskAndMonitor: vi.fn(async () => ({ finalText: "完成\nSTATUS: IMPLEMENT_DONE", status: "completed" })),
  stopAgent: vi.fn(async () => {}),
  runAgentUpdate: vi.fn(async () => true),
  runAgentIntegration: vi.fn(async () => true),
}))

vi.mock("../agent/session.js", () => ({
  createSession: vi.fn(async () => ({ sessionId: "s1", sessionDir: "/tmp/session" })),
}))

vi.mock("../config/persist.js", () => ({
  markIssueFinished: vi.fn(async () => {}),
  markIssueInReview: vi.fn(async () => {}),
}))

vi.mock("../notify/index.js", () => ({
  notifyIssueComplete: vi.fn(),
}))

vi.mock("./review-context.js", () => ({
  advanceBaseline: vi.fn(async () => {}),
}))

vi.mock("./review-loop.js", () => ({
  runReviewLoop: vi.fn(async () => {}),
}))

vi.mock("./final-gate.js", () => ({
  createFinalSessionDir: vi.fn(async () => "/tmp/final-session"),
  runFinalGate: vi.fn(async () => {}),
}))

const AGENT_CONFIG = (name: string) => ({
  name,
  agent: "codex",
  command: "codex",
  updateCommand: "codex update",
  integrationAgent: "codex",
})

const buildConfig = (dir: string, withFinalGate: boolean): WorkflowConfig => ({
  implementer: AGENT_CONFIG("impl"),
  reviewer: AGENT_CONFIG("rev"),
  maxReviewRounds: 8,
  projectDir: dir,
  prompts: {
    implement: "", review: "", revise: "", reReview: "",
    controllerImplementer: "", controllerReReview: "", postReviewCheck: "",
  },
  issues: [{ title: "Issue One", specPath: path.join(dir, "spec.md") }],
  ...(withFinalGate
    ? {
        finalGate: {
          maxRounds: 3,
          reviewer: AGENT_CONFIG("final-rev"),
          fixer: AGENT_CONFIG("final-fix"),
          prompts: { review: "/tmp/final-review.md", fix: "/tmp/final-fix.md" },
        },
      }
    : {}),
})

const buildRuntime = (config: WorkflowConfig, configPath: string): WorkflowRuntime => ({
  args: {},
  baseSha: undefined,
  config,
  configPath,
  eventBus: createWorkflowEventBus(),
  finalFixerPane: "",
  finalReviewerPane: "",
  hasGit: false,
  implementerPane: "",
  issueIndex: 0,
  prompts: {
    implement: "", review: "", revise: "", reReview: "",
    controllerImplementer: "", controllerReReview: "", postReviewCheck: "",
    finalReview: "", finalFix: "",
  },
  reviewerPane: "",
  startBaseSha: undefined,
})

const writeRealFiles = (dir: string) => {
  writeFileSync(path.join(dir, "spec.md"), "# spec", "utf8")
  const configPath = path.join(dir, "workflow.json")
  writeFileSync(configPath, JSON.stringify({ issues: [{ title: "Issue One" }] }), "utf8")
  return configPath
}

describe("issue queue with final gate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("publishes complete only after the final gate passes", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "issues-test-"))
    const configPath = writeRealFiles(dir)
    const runtime = buildRuntime(buildConfig(dir, true), configPath)
    const received: string[] = []
    runtime.eventBus.subscribe((event) => { received.push(event.type) })

    await runIssueQueueFromIndex(runtime, configPath, 0, runtime.config.issues)

    expect(runFinalGate).toHaveBeenCalledTimes(1)
    expect(runFinalGate).toHaveBeenCalledWith(runtime, "/tmp/final-session")
    expect(received).toContain("complete")
  })

  it("does not publish complete when the final gate fails", async () => {
    vi.mocked(runFinalGate).mockRejectedValueOnce(new Error("final gate failed"))
    const dir = mkdtempSync(path.join(os.tmpdir(), "issues-test-"))
    const configPath = writeRealFiles(dir)
    const runtime = buildRuntime(buildConfig(dir, true), configPath)
    const received: string[] = []
    runtime.eventBus.subscribe((event) => { received.push(event.type) })

    await expect(runIssueQueueFromIndex(runtime, configPath, 0, runtime.config.issues)).rejects.toThrow(
      "final gate failed",
    )

    expect(received).not.toContain("complete")
  })

  it("skips the final gate entirely when finalGate is not configured", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "issues-test-"))
    const configPath = writeRealFiles(dir)
    const runtime = buildRuntime(buildConfig(dir, false), configPath)
    const received: string[] = []
    runtime.eventBus.subscribe((event) => { received.push(event.type) })

    await runIssueQueueFromIndex(runtime, configPath, 0, runtime.config.issues)

    expect(runFinalGate).not.toHaveBeenCalled()
    expect(received).toContain("complete")
  })

  it("updates each unique agent CLI only once", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "issues-test-"))
    const configPath = writeRealFiles(dir)
    const runtime = buildRuntime(buildConfig(dir, false), configPath)

    await runIssueQueue(runtime, configPath)

    expect(runAgentUpdate).toHaveBeenCalledTimes(1)
    expect(runAgentUpdate).toHaveBeenCalledWith(dir, runtime.config.implementer, expect.any(Function))
  })

  it("deduplicates updates for final gate agents too", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "issues-test-"))
    const configPath = writeRealFiles(dir)
    const runtime = buildRuntime(buildConfig(dir, true), configPath)

    await runIssueQueue(runtime, configPath)

    expect(runAgentUpdate).toHaveBeenCalledTimes(1)
  })

  it("integrates each unique agent type only once", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "issues-test-"))
    const configPath = writeRealFiles(dir)
    const runtime = buildRuntime(buildConfig(dir, true), configPath)

    await runIssueQueue(runtime, configPath)

    expect(runAgentIntegration).toHaveBeenCalledTimes(1)
    expect(runAgentIntegration).toHaveBeenCalledWith(runtime.config.implementer, expect.any(Function))
  })
})

describe("shouldSkipIssue", () => {
  it("skips finish issues", () => {
    expect(shouldSkipIssue({ title: "Done", specPath: "/x.md", state: "finish" })).toBe(true)
  })

  it("does not skip ready or review issues", () => {
    expect(shouldSkipIssue({ title: "Todo", specPath: "/x.md", state: "ready" })).toBe(false)
    expect(shouldSkipIssue({ title: "InReview", specPath: "/x.md", state: "review" })).toBe(false)
  })
})

describe("shouldSkipImplement", () => {
  it("skips implement for review issues", () => {
    expect(shouldSkipImplement({ title: "InReview", specPath: "/x.md", state: "review" })).toBe(true)
  })

  it("does not skip implement for ready issues", () => {
    expect(shouldSkipImplement({ title: "Todo", specPath: "/x.md", state: "ready" })).toBe(false)
  })
})

describe("shouldNotifyIssueComplete", () => {
  it("notifies when more issues remain after this one", () => {
    expect(shouldNotifyIssueComplete(0, 3)).toBe(true)
    expect(shouldNotifyIssueComplete(1, 3)).toBe(true)
  })

  it("does not notify for the last issue", () => {
    expect(shouldNotifyIssueComplete(2, 3)).toBe(false)
    expect(shouldNotifyIssueComplete(0, 1)).toBe(false)
  })
})
