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
import { handleIntervention, defaultImplementAskDeps, type InterventionCheckpointContext } from "./implement-ask.js"
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
    runtime.eventBus.publish({ type: "phase_change", phase: "implement" })
    runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })

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
    // 使用真实 readline fallback，仅在 eventBus 有 handler 时使用面板交互
    const depsWithBus = { ...defaultImplementAskDeps(), eventBus: runtime.eventBus }

    if (monitorStatus === "needs_input" || parsed.status === "needs_input") {
      const reason = question ?? "需要人工确认"
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "needs_input" })
      runtime.eventBus.publish({ type: "needs_input", agent: "implementer", provider: sh.provider, reason })
      runtime.eventBus.publish({ type: "pause", reason: `implementer needs_input: ${reason}` })
      await handleIntervention(
        "implementer", runtime.implementerPane, finalText, "implement", sh,
        depsWithBus, question, false, runtime.needsCheckMode, implementCtx,
      )
      // intervention 完成后恢复为 working → completed
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })
    } else if (monitorStatus === "failed") {
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "failed" })
      console.warn("[Implement] Implementer failed. Proceeding to review anyway.")
    } else if (parsed.status === "invalid_output") {
      const reason = parsed.reason ?? "输出缺少合法 STATUS"
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "invalid_output" })
      runtime.eventBus.publish({ type: "invalid_output", agent: "implementer", provider: sh.provider, reason })
      runtime.eventBus.publish({ type: "pause", reason: `implementer invalid_output: ${reason}` })
      console.warn(`[Implement] Invalid output: ${reason}. Entering intervention...`)
      await handleIntervention(
        "implementer", runtime.implementerPane, finalText, "implement", sh,
        depsWithBus, parsed.reason, true, runtime.needsCheckMode, implementCtx,
      )
      // intervention 完成后恢复为 working → completed
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })
    } else {
      // completed
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })
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
  // 仅在整个 issue 队列结束后发布 workflow complete
  const publishCompleteWhenDone = () => {
    runtime.eventBus.publish({ type: "complete" })
  }

  for (let index = startIndex; index < issues.length; index += 1) {
    const issue = issues[index]
    console.log(`\n[Issue] === Issue ${index + 1}/${issues.length}: ${issue.title} ===`)
    console.log(`[Issue] Spec path: ${issue.specPath}`)

    if (shouldSkipIssue(issue)) {
      console.log(`[Issue] Skipping (state=finish): ${issue.title}`)
      continue
    }

    runtime.issueIndex = index
    runtime.eventBus.publish({ type: "issue_change", issueIndex: index, issueCount: issues.length, issueTitle: issue.title })

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

  // 所有 issue 处理完毕，发布 workflow complete
  publishCompleteWhenDone()
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
