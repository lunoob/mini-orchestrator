import { describe, expect, it } from "vitest"
import path from "node:path"

import { getAcceptanceReportPath, getWorkflowName, getWorkflowOrchestratorDir } from "./workflow-dir.js"

describe("workflow-dir", () => {
  it("derives workflow paths from the config file", () => {
    const configPath = "/home/user/project/specs/feature_workflow.issue.json"
    const projectDir = "/home/user/project"

    expect(getWorkflowName(configPath)).toBe("feature_workflow.issue")
    expect(getWorkflowOrchestratorDir(projectDir, configPath)).toBe(
      path.join(projectDir, ".orchestrator", "feature_workflow.issue"),
    )
    expect(getAcceptanceReportPath(projectDir, configPath)).toBe(
      path.join(projectDir, ".orchestrator", "feature_workflow.issue", "acceptance.md"),
    )
  })
})
