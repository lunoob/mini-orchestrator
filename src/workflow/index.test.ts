import { describe, expect, it, vi } from "vitest"

import { runWorkflow, WorkflowFinishedError } from "./index.js"
import { loadConfig } from "../config/load.js"
import { setWorkflowStatus } from "../config/persist.js"
import { startConsoleFileLog } from "../lib/console-file-log.js"
import { runIssueQueue } from "./issues.js"
import type { WorkflowConfig } from "../types.js"

vi.mock("../config/load.js", () => ({
  loadConfig: vi.fn(),
  loadPrompts: vi.fn(async () => ({})),
}))

vi.mock("../config/persist.js", () => ({
  setWorkflowStatus: vi.fn(async () => {}),
}))

vi.mock("../lib/console-file-log.js", () => ({
  startConsoleFileLog: vi.fn(async () => ({
    filePath: "/tmp/run.log",
    restore: vi.fn(),
    close: vi.fn(async () => {}),
  })),
}))

vi.mock("../git/index.js", () => ({
  getReviewBaselineSha: vi.fn(async () => undefined),
  isGitRepo: vi.fn(async () => false),
}))

vi.mock("./issues.js", () => ({
  runIssueQueue: vi.fn(async () => {}),
}))

const buildConfig = (overrides: Partial<WorkflowConfig> = {}): WorkflowConfig => ({
  agents: {
    implementer: { name: "impl", agent: "codex", command: "codex", integrationAgent: "codex" },
    reviewer: { name: "rev", agent: "codex", command: "codex", integrationAgent: "codex" },
  },
  enableAcceptanceReport: false,
  enableFinalGate: false,
  maxRounds: { workflow: 8, finalGate: 3 },
  projectDir: "/tmp/project",
  prompts: {
    implement: "", review: "", revise: "", reReview: "",
    controllerImplementer: "", controllerReReview: "", postReviewCheck: "",
  },
  issues: [{ title: "Issue One", specPath: "/tmp/spec.md" }],
  ...overrides,
})

describe("runWorkflow status gate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadConfig).mockResolvedValue(buildConfig())
  })

  it("throws WorkflowFinishedError when status is finish", async () => {
    vi.mocked(loadConfig).mockResolvedValue(buildConfig({ status: "finish" }))

    await expect(runWorkflow({ config: "/tmp/workflow.json" })).rejects.toBeInstanceOf(WorkflowFinishedError)
    expect(setWorkflowStatus).not.toHaveBeenCalled()
    expect(startConsoleFileLog).not.toHaveBeenCalled()
    expect(runIssueQueue).not.toHaveBeenCalled()
  })

  it("marks implementing before running the issue queue", async () => {
    await runWorkflow({ config: "/tmp/workflow.json" })

    expect(setWorkflowStatus).toHaveBeenCalledWith("/tmp/workflow.json", "implementing", expect.any(Object))
    expect(runIssueQueue).toHaveBeenCalledTimes(1)
  })

  it("runs even when status is implementing or reviewing", async () => {
    for (const status of ["implementing", "reviewing"] as const) {
      vi.mocked(loadConfig).mockResolvedValue(buildConfig({ status }))
      await expect(runWorkflow({ config: "/tmp/workflow.json" })).resolves.not.toThrow()
      expect(runIssueQueue).toHaveBeenCalled()
    }
  })
})
