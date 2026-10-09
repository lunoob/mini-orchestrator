import path from "node:path"

export const getWorkflowName = (configPath: string) =>
  path.basename(path.resolve(configPath), path.extname(configPath))

export const getWorkflowOrchestratorDir = (projectDir: string, configPath: string) =>
  path.join(projectDir, ".orchestrator", getWorkflowName(configPath))

export const getAcceptanceReportPath = (projectDir: string, configPath: string) =>
  path.join(getWorkflowOrchestratorDir(projectDir, configPath), "acceptance.md")
