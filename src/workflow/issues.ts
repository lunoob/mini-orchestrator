import { readFile } from "node:fs/promises"

import {
  agentWaitOptions,
  bootstrapSession,
  runAgentIntegration,
  runAgentUpdate,
  sendTaskAndMonitor,
  startAgentResumed,
  stopAgent,
  waitForAgentReady,
} from "../agent/index.js"
import { createSession } from "../agent/session.js"
import { markIssueFinished, markIssueInReview } from "../config/persist.js"
import type { IssueConfig } from "../types.js"
import { parseAgentOutput } from "../lib/status-parser.js"
import { render } from "../lib/utils.js"
import { notifyIssueComplete } from "../notify/index.js"
import { handleIntervention, type InterventionCheckpointContext } from "./implement-ask.js"
import { advanceBaseline } from "./review-context.js"
import { runReviewLoop } from "./review-loop.js"
import type { WorkflowRuntime } from "./types.js"

export const shouldSkipIssue = (issue: IssueConfig) => (issue.state ?? "ready") === "finish"
export const shouldSkipImplement = (issue: IssueConfig) => (issue.state ?? "ready") === "review"
export const shouldNotifyIssueComplete = (index: number, issueCount: number) =>
  index < issueCount - 1

const ensureImplementerSession = async (runtime: WorkflowRuntime) => {
  if (!runtime.implementerSession) {
    runtime.implementerSession = await bootstrapSession(runtime.config.implementer)
  }
  runtime.implementerPane = await startAgentResumed(
    runtime.config.projectDir,
    runtime.config.implementer,
    runtime.implementerSession.resumeId,
    { ensureUniqueName: true },
  )
  await waitForAgentReady(runtime.implementerPane, agentWaitOptions(runtime.config.implementer))
}

const runSingleSpecCycle = async (
  runtime: WorkflowRuntime,
  configPath: string,
  issue: IssueConfig,
  issueIndex: number,
  issues: IssueConfig[],
) => {
  const { specPath } = issue
  const specContent = await readFile(specPath, "utf8")
  const configContent = await readFile(configPath, "utf8")
  const { sessionDir: specSessionDir } = await createSession(
    runtime.config.projectDir, configPath, configContent, specPath, specContent, runtime.args,
  )
  console.log(`[Session] Session: ${specSessionDir}`)

  if (shouldSkipImplement(issue)) {
    console.log(`[Implement] Skipping (state=review): ${issue.title}`)
    await ensureImplementerSession(runtime)
  } else {
    await ensureImplementerSession(runtime)
    const sh = runtime.implementerSession!

    const { finalText, status: monitorStatus, question } = await sendTaskAndMonitor(
      runtime.implementerPane,
      render(runtime.prompts.implement, {
        maxReviewRounds: String(runtime.config.maxReviewRounds),
        specPath,
      }),
      sh,
    )

    // P1-1: 统一处理 needs_input 和 invalid_output，传入 needsCheckMode
    const implementCtx: InterventionCheckpointContext = {
      configPath, projectDir: runtime.config.projectDir,
      issues: runtime.config.issues, currentIssueIndex: issueIndex,
      round: 1, maxReviewRounds: runtime.config.maxReviewRounds,
      phase: "implement",
      implementerSession: sh,
      baseSha: runtime.baseSha, hasGit: runtime.hasGit,
      reuseCurrentPane: false,
    }

    const parsed = parseAgentOutput(finalText, "implementer")
    if (monitorStatus === "needs_input" || parsed.status === "needs_input") {
      await handleIntervention(
        "implementer", runtime.implementerPane, finalText, "implement", sh,
        undefined, question, false, runtime.needsCheckMode, implementCtx,
      )
    } else if (monitorStatus === "failed") {
      console.warn("[Implement] Implementer failed. Proceeding to review anyway.")
    } else if (parsed.status === "invalid_output") {
      console.warn(`[Implement] Invalid output: ${parsed.reason}. Entering intervention...`)
      await handleIntervention(
        "implementer", runtime.implementerPane, finalText, "implement", sh,
        undefined, parsed.reason, true, runtime.needsCheckMode, implementCtx,
      )
    }
  }

  await markIssueInReview(configPath, issueIndex, issues)
  runtime.reviewerSession = await bootstrapSession(runtime.config.reviewer)

  await runReviewLoop(runtime, configPath, 1, false, specSessionDir, specPath, issueIndex, issues)
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

    if (runtime.implementerPane) { await stopAgent(runtime.implementerPane); runtime.implementerPane = "" }
    if (runtime.reviewerPane) { await stopAgent(runtime.reviewerPane); runtime.reviewerPane = "" }
    runtime.implementerSession = undefined
    runtime.reviewerSession = undefined

    try {
      await runSingleSpecCycle(runtime, configPath, issue, index, issues)
      await advanceBaseline(runtime)
      await markIssueFinished(configPath, index, issues)
      if (shouldNotifyIssueComplete(index, issues.length)) {
        notifyIssueComplete(issue.title)
      }
    } finally {
      const ip = runtime.implementerPane
      const rp = runtime.reviewerPane
      if (ip) { runtime.implementerPane = ""; await stopAgent(ip).catch(() => {}) }
      if (rp) { runtime.reviewerPane = ""; await stopAgent(rp).catch(() => {}) }
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
