import { readFile } from "node:fs/promises"

import {
  bootstrapSession,
  runAgentIntegration,
  runAgentUpdate,
  sendTaskAndMonitor,
  startAgentResumed,
  stopAgent,
} from "../agent/index.js"
import type { OutputCallback } from "../agent/index.js"
import { createSession } from "../agent/session.js"
import { markIssueFinished, markIssueInReview } from "../config/persist.js"
import type { IssueConfig } from "../types.js"
import { isProtocolError, parseOutcome } from "../lib/outcome-parser.js"
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
  if (runtime.implementerPane) return
  if (!runtime.implementerSession) {
    runtime.implementerSession = await bootstrapSession(runtime.config.implementer)
  }
  runtime.implementerPane = await startAgentResumed(
    runtime.config.projectDir,
    runtime.config.implementer,
    runtime.implementerSession.resumeId,
    { ensureUniqueName: true },
  )
  // 不再等待 Herdr 状态：Agent 启动后直接发 task，monitor 以 JSONL 首次事件确认为准
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
    // 不预启动 implementer，review 需要修复时再按需启动
  } else {
    await ensureImplementerSession(runtime)
    const sh = runtime.implementerSession!
    runtime.eventBus.publish({ type: "phase_change", phase: "implement" })
    runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })

    const { finalText, status: monitorStatus, question, reason: failReasonFromMonitor } = await sendTaskAndMonitor(
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

    const depsWithBus = { ...defaultImplementAskDeps(), eventBus: runtime.eventBus }

    // P1-1: 先检查 monitor 级状态，再解析输出（agent 原生提问/失败时 finalText 可能为空/非 JSON）
    if (monitorStatus === "needs_input") {
      const reason = question ?? "需要人工确认"
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "needs_input" })
      runtime.eventBus.publish({ type: "needs_input", agent: "implementer", provider: sh.provider, reason })
      runtime.eventBus.publish({ type: "pause", reason: `implementer needs_input: ${reason}` })
      await handleIntervention(
        "implementer", runtime.implementerPane, finalText, "implement", sh,
        depsWithBus, reason, false, runtime.needsCheckMode, implementCtx,
      )
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })
    } else if (monitorStatus === "failed") {
      // P2-4: 优先使用 lastEvent.reason（Claude/Codex 失败原因），其次 question，最后兜底
      const failReason = failReasonFromMonitor ?? question ?? "unknown error"
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "failed" })
      runtime.eventBus.publish({ type: "fail", reason: `Implementer failed: ${failReason}` })
      throw new Error(`[Implement] Implementer failed for issue "${issue.title}". Stopping workflow.`)
    } else {
      // monitor 状态正常，解析输出
      const result = parseOutcome(finalText, "implementer")

      if (isProtocolError(result)) {
        // 协议错误 → intervention（不终止流程）
        const reason = result.reason
        runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "invalid_output" })
        runtime.eventBus.publish({ type: "invalid_output", agent: "implementer", provider: sh.provider, reason })
        runtime.eventBus.publish({ type: "pause", reason: `implementer protocol_error: ${reason}` })
        await handleIntervention(
          "implementer", runtime.implementerPane, finalText, "implement", sh,
          depsWithBus, reason, true, runtime.needsCheckMode, implementCtx,
        )
        runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })
        runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })
      } else if (result.outcome === "needs_input") {
        const reason = result.request.question
        runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "needs_input" })
        runtime.eventBus.publish({ type: "needs_input", agent: "implementer", provider: sh.provider, reason })
        runtime.eventBus.publish({ type: "pause", reason: `implementer needs_input: ${reason}` })
        await handleIntervention(
          "implementer", runtime.implementerPane, finalText, "implement", sh,
          depsWithBus, reason, false, runtime.needsCheckMode, implementCtx,
        )
        runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })
        runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })
      } else if (result.outcome === "failed") {
        const failReason = result.failure.message
        runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "failed" })
        runtime.eventBus.publish({ type: "fail", reason: `Implementer failed: ${failReason}` })
        throw new Error(`[Implement] Implementer failed for issue "${issue.title}". Stopping workflow.`)
      } else {
        runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })
      }
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

/** 将子进程输出通过 console 重定向到 log sink */
const agentOutput: OutputCallback = (msg, stream) => {
  if (stream === "stderr") console.warn(msg); else console.log(msg)
}

export const runIssueQueue = async (runtime: WorkflowRuntime, configPath: string) => {
  const { implementer, reviewer, projectDir } = runtime.config
  await Promise.all([
    runAgentUpdate(projectDir, implementer, agentOutput),
    runAgentUpdate(projectDir, reviewer, agentOutput),
    runAgentIntegration(implementer, agentOutput),
    runAgentIntegration(reviewer, agentOutput),
  ])
  await runIssueQueueFromIndex(runtime, configPath, 0, runtime.config.issues)
}
