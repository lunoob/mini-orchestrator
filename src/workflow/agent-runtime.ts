import { startWorkflowAgent } from "../session/workflow-agent.js"
import type { WorkflowRuntime } from "./types.js"

export const stopRuntimeAgents = async (runtime: WorkflowRuntime) => {
  await Promise.all([
    runtime.implementerSession?.stop() ?? Promise.resolve(),
    runtime.reviewerSession?.stop() ?? Promise.resolve(),
  ])
  runtime.implementerSession = undefined
  runtime.reviewerSession = undefined
  runtime.implementerPane = ""
  runtime.reviewerPane = ""
}

export const startRuntimeAgents = async (runtime: WorkflowRuntime, runDirectory: string) => {
  await stopRuntimeAgents(runtime)
  try {
    const implementer = await startWorkflowAgent({
      agent: runtime.config.implementer,
      baseUrl: runtime.sessionBaseUrl,
      client: runtime.sessionClient,
      projectDir: runtime.config.projectDir,
      role: "implementer",
      runDirectory,
    })
    runtime.implementerSession = implementer
    runtime.implementerPane = implementer.paneId

    const reviewer = await startWorkflowAgent({
      agent: runtime.config.reviewer,
      baseUrl: runtime.sessionBaseUrl,
      client: runtime.sessionClient,
      projectDir: runtime.config.projectDir,
      role: "reviewer",
      runDirectory,
    })
    runtime.reviewerSession = reviewer
    runtime.reviewerPane = reviewer.paneId
  } catch (error) {
    await stopRuntimeAgents(runtime)
    throw error
  }
}
