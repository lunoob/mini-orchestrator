import { readFile } from "node:fs/promises"

import {
  agentWaitOptions,
  runAgentIntegration,
  runAgentUpdate,
  sendTaskAndWait,
  startAgent,
  stopAgent,
  waitForAgentReady,
} from "../agent/index.js"
import { createSession } from "../agent/session.js"
import type { IssueConfig } from "../types.js"
import { extractImplementResult, parseImplementStatus, printSection, render } from "../lib/utils.js"
import { advanceBaseline } from "./review-context.js"
import { runReviewLoop } from "./review-loop.js"
import type { WorkflowRuntime } from "./types.js"

/** finish 状态的 issue 已完成开发，队列中应跳过；缺省按 ready 处理 */
export const shouldSkipIssue = (issue: IssueConfig) => (issue.state ?? "ready") === "finish"

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

  const implementOutput = await sendTaskAndWait(
    runtime.implementerPane,
    render(runtime.prompts.implement, {
      maxReviewRounds: String(runtime.config.maxReviewRounds),
      specPath,
    }),
    agentWaitOptions(runtime.config.implementer),
  )

  const implementStatus = parseImplementStatus(extractImplementResult(implementOutput))
  if (implementStatus === "needs_input") {
    printSection("Implementer Needs Input", implementOutput)
    throw new Error("[Implement] Implementer has questions — needs human input before review.")
  }
  if (implementStatus === "unknown") {
    console.warn(
      "[Implement] Warning: implementer did not output STATUS: IMPLEMENT_DONE. " +
        "The implementation may be incomplete. Proceeding to review anyway.",
    )
  }

  await runReviewLoop(runtime, configPath, round, false, specSessionDir, specPath, issueIndex, issues)
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

    if (shouldSkipIssue(issue)) {
      console.log(`[Issue] Skipping (state=finish): ${issue.title}`)
      continue
    }

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
  const { implementer, reviewer, projectDir } = runtime.config

  await Promise.all([
    runAgentUpdate(projectDir, implementer),
    runAgentUpdate(projectDir, reviewer),
    runAgentIntegration(implementer),
    runAgentIntegration(reviewer),
  ])

  await runIssueQueueFromIndex(runtime, configPath, 0, runtime.config.issues)
}
