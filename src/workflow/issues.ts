import path from "node:path"
import { readFile } from "node:fs/promises"

import {
  agentWaitOptions,
  runAgentUpdate,
  startAgent,
  stopAgent,
  waitForAgentReady,
} from "../agent/index.js"
import { createSession } from "../agent/session.js"
import type { IssueConfig } from "../types.js"
import { printSection, render } from "../lib/utils.js"
import { buildRunId, sendTaskWithTaskFile } from "./dispatch.js"
import { advanceBaseline } from "./review-context.js"
import { runReviewLoop } from "./review-loop.js"
import type { WorkflowRuntime } from "./types.js"

const runSingleSpecCycle = async (
  runtime: WorkflowRuntime,
  configPath: string,
  specPath: string,
  issueIndex: number,
  issues: IssueConfig[],
) => {
  const round = 1

  const specContent = await readFile(specPath, "utf8")
  const configContent = await readFile(configPath, "utf8")
  const { sessionDir: specSessionDir } = await createSession(
    runtime.config.projectDir, configPath, configContent, specPath, specContent, runtime.args,
  )

  console.log(`[Session] Session: ${specSessionDir}`)

  const tasksDir = path.join(specSessionDir, "tasks")

  const runId = buildRunId(issueIndex, "implementer", round)
  const { output: implementOutput, task: implementTask } = await sendTaskWithTaskFile(
    runtime.implementerPane,
    render(runtime.prompts.implement, {
      maxReviewRounds: String(runtime.config.maxReviewRounds),
      specPath,
    }),
    tasksDir,
    runId,
    "implementer",
  )

  if (implementTask.status === "IMPLEMENT_ASK") {
    printSection("Implementer Needs Input", implementOutput)
    throw new Error("[Implement] Implementer has questions — needs human input before review.")
  }
  if (implementTask.status !== "IMPLEMENT_DONE") {
    console.warn(
      "[Implement] Warning: implementer status is " +
        `${implementTask.status ?? "missing"}. ` +
        "The implementation may be incomplete. Proceeding to review anyway.",
    )
  }

  await runReviewLoop(runtime, configPath, round, false, specSessionDir, specPath, issueIndex, issues, tasksDir)
}

export const runIssueQueueFromIndex = async (
  runtime: WorkflowRuntime,
  configPath: string,
  startIndex: number,
  issues: IssueConfig[],
) => {
  for (let index = startIndex; index < issues.length; index += 1) {
    const issue = issues[index]
    console.log(`\n[Issue] === Issue ${index + 1}/${issues.length}: ${issue.title} ===`)
    console.log(`[Issue] Spec path: ${issue.specPath}`)

    runtime.issueIndex = index

    if (runtime.implementerPane) await stopAgent(runtime.implementerPane)
    if (runtime.reviewerPane) await stopAgent(runtime.reviewerPane)

    let startedImplementer = false
    let startedReviewer = false

    try {
      runtime.implementerPane = await startAgent(runtime.config.projectDir, runtime.config.implementer, {
        ensureUniqueName: true,
      })
      startedImplementer = true
      await waitForAgentReady(runtime.implementerPane, agentWaitOptions(runtime.config.implementer))

      runtime.reviewerPane = await startAgent(runtime.config.projectDir, runtime.config.reviewer, {
        ensureUniqueName: true,
      })
      startedReviewer = true
      await waitForAgentReady(runtime.reviewerPane, agentWaitOptions(runtime.config.reviewer))

      await runSingleSpecCycle(runtime, configPath, issue.specPath, index, issues)

      await advanceBaseline(runtime)
    } finally {
      if (startedReviewer) await stopAgent(runtime.reviewerPane)
      if (startedImplementer) await stopAgent(runtime.implementerPane)
    }
  }
}

export const runIssueQueue = async (runtime: WorkflowRuntime, configPath: string) => {
  await runAgentUpdate(runtime.config.projectDir, runtime.config.implementer)
  await runAgentUpdate(runtime.config.projectDir, runtime.config.reviewer)

  await runIssueQueueFromIndex(runtime, configPath, 0, runtime.config.issues)
}
