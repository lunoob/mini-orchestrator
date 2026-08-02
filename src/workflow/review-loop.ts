import { promptNeedsCheckInteractive } from "../review/needs-check.js"
import {
  bootstrapSession,
  sendTaskAndMonitor,
  startAgentResumed,
} from "../agent/index.js"
import type { AgentRole, AgentSessionHandle } from "../agent/transcript/types.js"
import {
  extractOutcomeSummary,
  printSection,
  render,
  stripAgentOutcome,
} from "../lib/utils.js"
import { isProtocolError, parseOutcome } from "../lib/outcome-parser.js"
import { notifyNeedsInput } from "../notify/index.js"
import { handleIntervention, defaultImplementAskDeps } from "./implement-ask.js"
import { buildDiffFileSection, prepareReviewContext } from "./review-context.js"
import type { NeedsCheckOutcome, PostReviewStatus, ReviewLoopOptions, WorkflowRuntime } from "./types.js"

/**
 * 统一处理 sendTaskAndMonitor 返回结果。
 */
const handleMonitorResult = async (
  role: AgentRole,
  paneId: string,
  finalText: string,
  status: string,
  question: string | undefined,
  context: string,
  session: AgentSessionHandle,
  eventBus?: import("./events.js").WorkflowEventBus,
): Promise<string> => {
  const result = parseOutcome(finalText, role)

  const agentKey = role === "implementer" ? "implementer" : "reviewer"

  const publishInterventionEvents = (reason: string) => {
    if (!eventBus) return
    eventBus.publish({ type: "agent_state_change", agent: agentKey, status: "needs_input" })
    eventBus.publish({ type: "needs_input", agent: agentKey, provider: session.provider, reason })
    eventBus.publish({ type: "pause", reason: `${role} needs_input: ${reason}` })
  }

  const publishResumeEvents = () => {
    if (!eventBus) return
    eventBus.publish({ type: "agent_state_change", agent: agentKey, status: "working" })
  }

  const depsWithBus = eventBus
    ? { ...defaultImplementAskDeps(), eventBus }
    : undefined

  // monitor 级 needs_input（原生提问）→ 启动 intervention
  if (status === "needs_input") {
    publishInterventionEvents(question ?? "需要确认")
    const intrResult1 = await handleIntervention(role, paneId, finalText, context, session, depsWithBus, question, false)
    publishResumeEvents()
    return intrResult1
  }

  // failed（monitor 级或 outcome 级）→ 直接终止
  if (status === "failed") {
    if (eventBus) {
      eventBus.publish({ type: "agent_state_change", agent: agentKey, status: "failed" })
      eventBus.publish({ type: "fail", reason:  `${role} failed in ${context}` })
    }
    throw new Error(`[${role}] Agent failed in ${context}`)
  }

  // 协议错误 → intervention（不终止流程）
  if (isProtocolError(result)) {
    const reason = result.reason
    // invalid_output 发布正确状态，而非 needs_input
    if (eventBus) {
      eventBus.publish({ type: "agent_state_change", agent: agentKey, status: "invalid_output" })
      eventBus.publish({ type: "invalid_output", agent: agentKey, provider: session.provider, reason })
      eventBus.publish({ type: "pause", reason: `${role} invalid_output: ${reason}` })
    }
    const intrResult = await handleIntervention(role, paneId, finalText, context, session, depsWithBus, reason, true)
    publishResumeEvents()
    return intrResult
  }

  // 以下 result 已通过 isProtocolError 检查，是 AgentOutcome
  const outcome = result

  if (outcome.outcome === "failed") {
    if (eventBus) {
      eventBus.publish({ type: "agent_state_change", agent: agentKey, status: "failed" })
      eventBus.publish({ type: "fail", reason: outcome.failure.message })
    }
    throw new Error(`[${role}] Agent failed in ${context}: ${outcome.failure.message}`)
  }

  if (outcome.outcome === "needs_input") {
    // P1-3: reviewer needs_input 也要启动 intervention，传递结构化选项
    const reason = outcome.request.question
    publishInterventionEvents(reason)
    const intrResult2 = await handleIntervention(role, paneId, finalText, context, session, depsWithBus, reason, false)
    publishResumeEvents()
    return intrResult2
  }

  if (outcome.outcome === "completed") return finalText

  console.warn(`[handleMonitorResult] Unknown state for ${role}`)
  return finalText
}

/** 按需启动 implementer：仅当 review 需要它（revise / post-check）时才 bootstrap 并创建 pane，返回其 session */
const ensureImplementer = async (runtime: WorkflowRuntime): Promise<AgentSessionHandle> => {
  if (runtime.implementerPane) return runtime.implementerSession!
  if (!runtime.implementerSession) {
    runtime.implementerSession = await bootstrapSession(runtime.config.implementer)
  }
  runtime.implementerPane = await startAgentResumed(
    runtime.config.projectDir,
    runtime.config.implementer,
    runtime.implementerSession.resumeId,
    { ensureUniqueName: true },
  )
  console.log(`[Review] Started implementer on demand for repair: ${runtime.implementerPane}`)
  return runtime.implementerSession
}

export const sendControllerRevise = async (
  runtime: WorkflowRuntime, round: number, controllerNotes: string, reviewOutput: string,
) => {
  const session = await ensureImplementer(runtime)

  runtime.eventBus.publish({ type: "phase_change", phase: "controller-revise" })
  runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })

  const { finalText, status, question } = await sendTaskAndMonitor(
    runtime.implementerPane,
    render(runtime.prompts.controllerImplementer, {
      controllerNotes, reviewOutput: stripAgentOutcome(reviewOutput), round: String(round),
    }),
    session,
  )

  await handleMonitorResult(
    "implementer", runtime.implementerPane, finalText, status, question,
    `controller revise round ${round}`, session, runtime.eventBus,
  )

  runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })
}

const conductReview = async (
  runtime: WorkflowRuntime, round: number, sessionDir: string, specPath: string,
  options: ReviewLoopOptions = {},
) => {
  if (!runtime.reviewerSession) throw new Error("[Review] Missing reviewer session")

  runtime.eventBus.publish({ type: "review_round_change", round, maxRounds: runtime.config.maxReviewRounds })
  runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "working" })

  const reviewContext = await prepareReviewContext(sessionDir, runtime.config.projectDir, runtime.baseSha, round)
  if (reviewContext.diffFile) console.log(`[Review] Review package: ${reviewContext.diffFile}`)

  const diffFileSection = buildDiffFileSection(reviewContext.diffFile, !runtime.hasGit)
  const prompt = options.controllerReviewNotes && options.lastReviewOutput
    ? render(runtime.prompts.controllerReReview, {
        baseSha: reviewContext.baseSha, controllerNotes: options.controllerReviewNotes,
        diffFileSection, headSha: reviewContext.headSha,
        reviewOutput: stripAgentOutcome(options.lastReviewOutput), round: String(round), specPath,
      })
    : render(runtime.prompts[round === 1 ? "review" : "reReview"], {
        baseSha: reviewContext.baseSha, diffFileSection, headSha: reviewContext.headSha,
        round: String(round), specPath,
      })

  const { finalText, status, question } = await sendTaskAndMonitor(
    runtime.reviewerPane, prompt, runtime.reviewerSession,
  )

  const final = await handleMonitorResult(
    "reviewer", runtime.reviewerPane, finalText, status, question,
    `review round ${round}`, runtime.reviewerSession, runtime.eventBus,
  )

  const parseResult = parseOutcome(final, "reviewer")
  printSection(`Review Round ${round}`, extractOutcomeSummary(final) || "(no outcome)")

  // 发布 reviewer 状态
  if (!isProtocolError(parseResult)) {
    if (parseResult.outcome === "completed") {
      runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "completed" })
    } else if (parseResult.outcome === "needs_input") {
      runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "needs_input" })
      runtime.eventBus.publish({ type: "needs_input", agent: "reviewer", provider: runtime.reviewerSession.provider, reason: question ?? "Reviewer 需要确认" })
    }
  }

  return { reviewOutput: final, parseResult }
}

/**
 * 从 AgentOutcome / ProtocolError 推导 reviewer 的 STATUS 等效值，用于 needs-check 决策。
 */
const outcomeToReviewStatus = (o: ReturnType<typeof parseOutcome>): string => {
  if (isProtocolError(o)) return "REVIEW_FAIL"
  if (o.outcome === "completed" && "review" in o && o.review?.verdict === "pass") return "REVIEW_PASS"
  if (o.outcome === "completed" && "review" in o && o.review?.verdict === "fail") return "REVIEW_FAIL"
  if (o.outcome === "completed" && "review" in o && o.review?.verdict === "needs_check") return "REVIEW_NEEDS_CHECK"
  if (o.outcome === "needs_input") return "REVIEW_NEEDS_CHECK"
  return "REVIEW_FAIL"
}

const handleNeedsCheck = async (
  runtime: WorkflowRuntime, round: number, reviewOutput: string,
  outcome: ReturnType<typeof parseOutcome>,
): Promise<NeedsCheckOutcome> => {
  const statusValue = outcomeToReviewStatus(outcome)

  if (statusValue === "REVIEW_NEEDS_CHECK" && runtime.reviewerSession) {
    notifyNeedsInput(
      "reviewer", runtime.reviewerSession.provider,
      "Review 需要人工核查",
      runtime.reviewerSession.resumeId, runtime.reviewerPane,
      String(runtime.reviewerSession.offset),
    )
  }

  // 从 outcome 中提取 cannotVerifySummary（如有）
  const cvSummary = !isProtocolError(outcome) && outcome.outcome === "completed" && "review" in outcome
    ? outcome.review.cannotVerifySummary ?? null : null

  const verdict = {
    kind: statusValue === "REVIEW_PASS" ? "pass" as const
      : statusValue === "REVIEW_NEEDS_CHECK" ? "needs_check" as const
      : "fail" as const,
    passed: statusValue === "REVIEW_PASS",
    cannotVerifySummary: cvSummary,
    hasCannotVerify: cvSummary !== null,
  }

  // 从 reviewer 的 needs_input 中提取问题，展示给人工核查面板
  const reviewerQuestion = !isProtocolError(outcome) && outcome.outcome === "needs_input"
    ? outcome.request.question : undefined

  const decision = await promptNeedsCheckInteractive(
    round, verdict, reviewOutput, runtime.eventBus, reviewerQuestion,
  )

  switch (decision.action) {
    case "approve":
      console.log(`\n[NeedsCheck] Workflow finished: manually approved after needs_check in round ${round}.`)
      return { type: "approved" }
    case "abort":
      throw new Error(`[NeedsCheck] Workflow aborted by user after needs_check in round ${round}.`)
    case "revise":
      console.log("[NeedsCheck] Needs check → revise.")
      await sendControllerRevise(runtime, round, decision.notes, reviewOutput)
      return { type: "continue_round" }
    case "retry-review":
      console.log("[NeedsCheck] Needs check → retry-review.")
      return { type: "retry_same_round", controllerNotes: decision.notes, lastReviewOutput: reviewOutput }
    default: {
      const _exhaustive: never = decision.action
      throw new Error(`[NeedsCheck] Unknown action: ${_exhaustive}`)
    }
  }
}

export const sendPostReviewCheck = async (
  runtime: WorkflowRuntime, round: number, reviewStatus: PostReviewStatus,
) => {
  const session = await ensureImplementer(runtime)
  console.log(`[PostCheck] Review ${reviewStatus} — verifying checks.`)

  runtime.eventBus.publish({ type: "phase_change", phase: "post-check" })
  runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })

  const { finalText, status, question } = await sendTaskAndMonitor(
    runtime.implementerPane,
    render(runtime.prompts.postReviewCheck, { reviewStatus, round: String(round) }),
    session,
  )

  await handleMonitorResult(
    "implementer", runtime.implementerPane, finalText, status, question,
    `post-review check round ${round}`, session, runtime.eventBus,
  )

  runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })
}

export const sendReviseAfterFail = async (runtime: WorkflowRuntime, round: number, reviewOutput: string) => {
  const session = await ensureImplementer(runtime)
  console.log("[Revise] Review failed — sending back to implementer.")

  runtime.eventBus.publish({ type: "phase_change", phase: "revise" })
  runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })

  const { finalText, status, question } = await sendTaskAndMonitor(
    runtime.implementerPane,
    render(runtime.prompts.revise, { reviewOutput: stripAgentOutcome(reviewOutput), round: String(round) }),
    session,
  )

  await handleMonitorResult(
    "implementer", runtime.implementerPane, finalText, status, question,
    `revise round ${round}`, session, runtime.eventBus,
  )

  runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })
}

export const runReviewLoop = async (
  runtime: WorkflowRuntime, startRound: number, sessionDir: string, specPath: string,
  initialOptions?: ReviewLoopOptions,
) => {
  runtime.eventBus.publish({ type: "phase_change", phase: "review" })

  if (runtime.reviewerSession && !runtime.reviewerPane) {
    runtime.reviewerPane = await startAgentResumed(
      runtime.config.projectDir, runtime.config.reviewer,
      runtime.reviewerSession.resumeId, { ensureUniqueName: true },
    )
  }

  for (let round = startRound; round <= runtime.config.maxReviewRounds; round += 1) {
    let activeLoopOptions: ReviewLoopOptions | undefined = round === startRound ? initialOptions : undefined
    let retrySameRound = true

    while (retrySameRound) {
      retrySameRound = false
      const { reviewOutput, parseResult } = await conductReview(runtime, round, sessionDir, specPath, activeLoopOptions ?? {})
      activeLoopOptions = undefined

      // completed + REVIEW_PASS → done
      if (!isProtocolError(parseResult) && parseResult.outcome === "completed" && "review" in parseResult && parseResult.review?.verdict === "pass") {
        await sendPostReviewCheck(runtime, round, "REVIEW_PASS")
        console.log(`\n[Review] Workflow finished: review passed in round ${round}.`)
        return
      }

      // completed + needs_check → 人工核查（复用 handleNeedsCheck 流程）
      if (!isProtocolError(parseResult) && parseResult.outcome === "completed" && "review" in parseResult && parseResult.review?.verdict === "needs_check") {
        await sendPostReviewCheck(runtime, round, "REVIEW_NEEDS_CHECK")
        runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "needs_input" })
        runtime.eventBus.publish({ type: "needs_input", agent: "reviewer", provider: runtime.reviewerSession!.provider, reason: "Review 需要人工核查" })
        runtime.eventBus.publish({ type: "pause", reason: "reviewer needs_check" })
        const decision = await handleNeedsCheck(runtime, round, reviewOutput, parseResult)
        if (decision.type === "approved") return
        if (decision.type === "continue_round") break
        activeLoopOptions = { controllerReviewNotes: decision.controllerNotes, lastReviewOutput: decision.lastReviewOutput }
        retrySameRound = true
        continue
      }

      // needs_input → needs-check
      if (!isProtocolError(parseResult) && parseResult.outcome === "needs_input") {
        await sendPostReviewCheck(runtime, round, "REVIEW_NEEDS_CHECK")
        runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "needs_input" })
        runtime.eventBus.publish({ type: "needs_input", agent: "reviewer", provider: runtime.reviewerSession!.provider, reason: "Review 需要人工核查" })
        runtime.eventBus.publish({ type: "pause", reason: "reviewer needs_input: REVIEW_NEEDS_CHECK" })
        const decision = await handleNeedsCheck(runtime, round, reviewOutput, parseResult)
        if (decision.type === "approved") return
        if (decision.type === "continue_round") break
        activeLoopOptions = { controllerReviewNotes: decision.controllerNotes, lastReviewOutput: decision.lastReviewOutput }
        retrySameRound = true
        continue
      }

      // completed + REVIEW_FAIL 或 failed → 进入 revise 流程
      if (round === runtime.config.maxReviewRounds) {
        runtime.eventBus.publish({ type: "fail", reason: `Review failed after ${runtime.config.maxReviewRounds} rounds` })
        throw new Error(`[Review] Review failed after ${runtime.config.maxReviewRounds} rounds.`)
      }

      await sendReviseAfterFail(runtime, round, reviewOutput)
      break
    }
  }

  runtime.eventBus.publish({ type: "fail", reason: `Review failed after ${runtime.config.maxReviewRounds} rounds` })
  throw new Error(`[Review] Review failed after ${runtime.config.maxReviewRounds} rounds.`)
}
