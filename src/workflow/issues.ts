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
import { createWorkflowRunContext } from "./run-context.js"
import { markIssueFinished, markIssueInReview } from "../config/persist.js"
import type { IssueConfig } from "../types.js"
import { extractImplementResult, parseImplementStatus, render } from "../lib/utils.js"
import { notifyIssueComplete } from "../notify/index.js"
import { handleImplementAskIfNeeded } from "./implement-ask.js"
import { advanceBaseline } from "./review-context.js"
import { runReviewLoop } from "./review-loop.js"
import type { WorkflowRuntime } from "./types.js"

/** finish 状态的 issue 已完成开发，队列中应跳过；缺省按 ready 处理 */
export const shouldSkipIssue = (issue: IssueConfig) => (issue.state ?? "ready") === "finish"

/** review 状态的 issue 已实现，跳过 implement prompt，直接进入 review */
export const shouldSkipImplement = (issue: IssueConfig) => (issue.state ?? "ready") === "review"

/** 多 issue 时中间完成才通知，最后一个留给 workflow 结束的 notifySuccess */
export const shouldNotifyIssueComplete = (index: number, issueCount: number) =>
  index < issueCount - 1

const runSingleSpecCycle = async (
  runtime: WorkflowRuntime,
  configPath: string,
  issue: IssueConfig,
  issueIndex: number,
  issues: IssueConfig[],
) => {
  const round = 1
  const { specPath } = issue

  const specContent = await readFile(specPath, "utf8")
  const configContent = await readFile(configPath, "utf8")
  const { runDirectory: workflowRunDirectory } = await createWorkflowRunContext(
    runtime.config.projectDir, configPath, configContent, specPath, specContent, runtime.args,
  )

  console.log(`[Workflow] Run directory: ${workflowRunDirectory}`)

  if (shouldSkipImplement(issue)) {
    console.log(`[Implement] Skipping (state=review): ${issue.title}`)
  } else {
    const implementOutput = await sendTaskAndWait(
      runtime.implementerPane,
      render(runtime.prompts.implement, {
        maxReviewRounds: String(runtime.config.maxReviewRounds),
        specPath,
      }),
      agentWaitOptions(runtime.config.implementer),
    )

    const resolvedOutput = await handleImplementAskIfNeeded(
      runtime.implementerPane,
      implementOutput,
      "implement",
    )
    const implementStatus = parseImplementStatus(extractImplementResult(resolvedOutput))
    if (implementStatus === "unknown") {
      console.warn(
        "[Implement] Warning: implementer did not output STATUS: IMPLEMENT_DONE. " +
          "The implementation may be incomplete. Proceeding to review anyway.",
      )
    }
  }

  await markIssueInReview(configPath, issueIndex, issues)
  await runReviewLoop(runtime, configPath, round, false, workflowRunDirectory, specPath, issueIndex, issues)
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

      await runSingleSpecCycle(runtime, configPath, issue, index, issues)

      await advanceBaseline(runtime)
      await markIssueFinished(configPath, index, issues)
      // 最后一个 issue 不在此通知，由 main 的 notifySuccess 统一收尾
      if (shouldNotifyIssueComplete(index, issues.length)) {
        notifyIssueComplete(issue.title)
      }
    } finally {
      const reviewerPane = startedReviewer ? runtime.reviewerPane : undefined
      const implementerPane = startedImplementer ? runtime.implementerPane : undefined
      if (startedReviewer) runtime.reviewerPane = ""
      if (startedImplementer) runtime.implementerPane = ""
      await Promise.all([
        reviewerPane ? stopAgent(reviewerPane) : Promise.resolve(),
        implementerPane ? stopAgent(implementerPane) : Promise.resolve(),
      ])
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
