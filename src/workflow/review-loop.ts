import { resolveNeedsCheckDecision } from "../review/needs-check.js"
import type { IssueConfig } from "../types.js"
import {
  agentWaitOptions,
  sendTaskAndMonitor,
  startAgentResumed,
  waitForAgentReady,
} from "../agent/index.js"
import type { AgentRole, AgentSessionHandle } from "../agent/transcript/types.js"
import {
  extractStatusLines,
  printSection,
  render,
  stripStatusLines,
} from "../lib/utils.js"
import { parseAgentOutput } from "../lib/status-parser.js"
import { notifyNeedsInput } from "../notify/index.js"
import { handleIntervention, type InterventionCheckpointContext } from "./implement-ask.js"
import { buildDiffFileSection, prepareReviewContext } from "./review-context.js"
import { buildCheckpointInput, type NeedsCheckOutcome, type PostReviewStatus, type ReviewLoopOptions, type WorkflowRuntime } from "./types.js"
import type { WorkflowPhase } from "./events.js"

/**
 * 统一处理 sendTaskAndMonitor 返回结果。
 *
 * P1-1: 仅 monitor 级 needs_input（原生提问）启动 intervention；
 * STATUS 级 needs_input（REVIEW_NEEDS_CHECK / IMPLEMENT_ASK）原样返回上层处理。
 */
const handleMonitorResult = async (
  role: AgentRole,
  paneId: string,
  finalText: string,
  status: string,
  question: string | undefined,
  context: string,
  session: AgentSessionHandle,
  needsCheckMode: "interactive" | "llm" = "interactive",
  checkpointCtx?: InterventionCheckpointContext,
  eventBus?: import("./events.js").WorkflowEventBus,
): Promise<string> => {
  const parsed = parseAgentOutput(finalText, role)
  const ctx = checkpointCtx ? { ...checkpointCtx, phase: checkpointCtx.phase || context } : undefined

  if (parsed.status === "completed") return finalText

  // 发布 intervention 状态、详情、暂停事件
  const publishInterventionEvents = (intType: "needs_input" | "invalid_output", reason: string) => {
    if (!eventBus) return
    eventBus.publish({ type: "agent_state_change", agent: role === "implementer" ? "implementer" : "reviewer", status: intType })
    if (intType === "needs_input") {
      eventBus.publish({ type: "needs_input", agent: role === "implementer" ? "implementer" : "reviewer", provider: session.provider, reason })
    } else {
      eventBus.publish({ type: "invalid_output", agent: role === "implementer" ? "implementer" : "reviewer", provider: session.provider, reason })
    }
    eventBus.publish({ type: "pause", reason: `${role} ${intType}: ${reason}` })
  }

  const agentKey = role === "implementer" ? "implementer" : "reviewer"

  // intervention 完成后恢复 working 状态，清除 paused 和 intervention 详情
  const publishResumeEvents = () => {
    if (!eventBus) return
    eventBus.publish({ type: "agent_state_change", agent: agentKey, status: "working" })
  }

  if (status === "needs_input") {
    publishInterventionEvents("needs_input", question ?? "需要确认")
    const result = await handleIntervention(role, paneId, finalText, context, session, undefined, question, false, needsCheckMode, ctx)
    publishResumeEvents()
    return result
  }

  if (parsed.status === "needs_input") {
    if (role === "reviewer") return finalText
    publishInterventionEvents("needs_input", question ?? "需要确认")
    const result = await handleIntervention(role, paneId, finalText, context, session, undefined, question, false, needsCheckMode, ctx)
    publishResumeEvents()
    return result
  }

  // failed 优先于 invalid_output：Agent 失败时 finalText 通常为空，会先命中 invalid_output
  // failed 进入独立失败流程，不复用 invalid_output 干预
  if (status === "failed") {
    if (eventBus) {
      eventBus.publish({ type: "agent_state_change", agent: agentKey, status: "failed" })
      eventBus.publish({ type: "fail", reason: `${role} failed in ${context}` })
    }
    throw new Error(`[${role}] Agent failed in ${context}`)
  }

  if (parsed.status === "invalid_output") {
    publishInterventionEvents("invalid_output", parsed.reason ?? "输出缺少合法 STATUS")
    const result = await handleIntervention(role, paneId, finalText, context, session, undefined,
      parsed.reason, true, needsCheckMode, ctx)
    publishResumeEvents()
    return result
  }

  console.warn(`[handleMonitorResult] Unknown status for ${role}: ${status}`)
  return finalText
}

/** 从 runtime 构造 checkpoint 上下文 */
const mkCtx = (runtime: WorkflowRuntime, round: number, phase: string): InterventionCheckpointContext => ({
  configPath: runtime.configPath,
  projectDir: runtime.config.projectDir,
  issues: runtime.config.issues,
  currentIssueIndex: runtime.issueIndex,
  round,
  maxReviewRounds: runtime.config.maxReviewRounds,
  phase,
  implementerSession: runtime.implementerSession,
  reviewerSession: runtime.reviewerSession,
  baseSha: runtime.baseSha,
  hasGit: runtime.hasGit,
  reuseCurrentPane: false,
})

export const sendControllerRevise = async (
  runtime: WorkflowRuntime, round: number, controllerNotes: string, reviewOutput: string,
) => {
  if (!runtime.implementerSession) throw new Error("[Controller] Missing implementer session")

  runtime.eventBus.publish({ type: "phase_change", phase: "controller-revise" })
  runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })

  const { finalText, status, question } = await sendTaskAndMonitor(
    runtime.implementerPane,
    render(runtime.prompts.controllerImplementer, {
      controllerNotes, reviewOutput: stripStatusLines(reviewOutput), round: String(round),
    }),
    runtime.implementerSession,
  )

  await handleMonitorResult(
    "implementer", runtime.implementerPane, finalText, status, question,
    `controller revise round ${round}`, runtime.implementerSession, runtime.needsCheckMode, mkCtx(runtime, round, "controller-revise"),
    runtime.eventBus,
  )

  // handleMonitorResult 正常返回表示 implementer 完成
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
        reviewOutput: stripStatusLines(options.lastReviewOutput), round: String(round), specPath,
      })
    : render(runtime.prompts[round === 1 ? "review" : "reReview"], {
        baseSha: reviewContext.baseSha, diffFileSection, headSha: reviewContext.headSha,
        round: String(round), specPath,
      })

  const { finalText, status, question } = await sendTaskAndMonitor(
    runtime.reviewerPane, prompt, runtime.reviewerSession,
  )

  // P1-2/P1-3: 用 reviewer 角色处理 intervention（handleMonitorResult 会发布完整 intervention 事件）
  const final = await handleMonitorResult(
    "reviewer", runtime.reviewerPane, finalText, status, question,
    `review round ${round}`, runtime.reviewerSession, runtime.needsCheckMode, mkCtx(runtime, round, "review"),
    runtime.eventBus,
  )

  const parsed = parseAgentOutput(final, "reviewer")
  printSection(`Review Round ${round}`, extractStatusLines(final) || "(no STATUS)")

  // 发布 reviewer 完成状态
  if (parsed.status === "completed") {
    runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "completed" })
  } else if (parsed.status === "needs_input") {
    runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "needs_input" })
    runtime.eventBus.publish({ type: "needs_input", agent: "reviewer", provider: runtime.reviewerSession.provider, reason: question ?? "Reviewer 需要确认" })
  } else if (parsed.status === "invalid_output") {
    runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "invalid_output" })
  }

  // P1-4: 不转换 invalid_output 为 REVIEW_FAIL；保留它让上层判断
  return { reviewOutput: final, parsed }
}

const handleNeedsCheck = async (
  runtime: WorkflowRuntime, configPath: string, round: number, reviewOutput: string,
  parsed: ReturnType<typeof parseAgentOutput>, reuseCurrentPane: boolean,
  sessionDir: string, specPath: string, issueIndex: number, issues: IssueConfig[],
): Promise<NeedsCheckOutcome> => {
  const statusValue = parsed.status === "needs_input" ? "REVIEW_NEEDS_CHECK"
    : parsed.status === "completed" && "statusValue" in parsed ? parsed.statusValue
    : "REVIEW_FAIL"

  // REVIEW_NEEDS_CHECK 时发送系统通知（LLM 模式由主入口统一发送，此处仅处理 interactive 模式）
  // 使用 transcript offset 作为 turnId，避免同轮 retry-review 被误去重
  if (statusValue === "REVIEW_NEEDS_CHECK" && runtime.reviewerSession && runtime.needsCheckMode === "interactive") {
    notifyNeedsInput(
      "reviewer", runtime.reviewerSession.provider,
      "Review 需要人工核查",
      runtime.reviewerSession.resumeId, runtime.reviewerPane,
      String(runtime.reviewerSession.offset),
    )
  }

  // 构建通知上下文（LLM 模式下传递给 NeedsCheckPauseError）
  const notificationContext = statusValue === "REVIEW_NEEDS_CHECK" && runtime.reviewerSession
    ? {
        role: "reviewer",
        provider: runtime.reviewerSession.provider,
        paneId: runtime.reviewerPane,
        reason: "Review 需要人工核查",
        turnId: String(runtime.reviewerSession.offset),
        interventionType: "needs_input" as const,
      }
    : undefined

  const decision = await resolveNeedsCheckDecision(
    runtime.args, runtime.needsCheckMode, round,
    {
      kind: statusValue === "REVIEW_PASS" ? "pass" : statusValue === "REVIEW_NEEDS_CHECK" ? "needs_check" : "fail",
      passed: statusValue === "REVIEW_PASS", cannotVerifySummary: null, hasCannotVerify: false,
    },
    reviewOutput,
    buildCheckpointInput(runtime, configPath, round, reviewOutput,
      { cannotVerifySummary: null, hasCannotVerify: false, kind: statusValue === "REVIEW_PASS" ? "pass" : statusValue === "REVIEW_NEEDS_CHECK" ? "needs_check" : "fail", passed: statusValue === "REVIEW_PASS" },
      reuseCurrentPane, specPath, issueIndex, issues),
    sessionDir,
    notificationContext,
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
  /** 原始 reviewer 输出（用于 intervention checkpoint 保留上下文） */
  reviewerOutput?: string,
) => {
  if (!runtime.implementerSession) return
  console.log(`[PostCheck] Review ${reviewStatus} — verifying checks.`)

  // 发布 post-check 阶段及 implementer 状态事件
  runtime.eventBus.publish({ type: "phase_change", phase: "post-check" })
  runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })

  const { finalText, status, question } = await sendTaskAndMonitor(
    runtime.implementerPane,
    render(runtime.prompts.postReviewCheck, { reviewStatus, round: String(round) }),
    runtime.implementerSession,
  )

  await handleMonitorResult(
    "implementer", runtime.implementerPane, finalText, status, question,
    `post-review check round ${round}`, runtime.implementerSession, runtime.needsCheckMode,
    { ...mkCtx(runtime, round, "post-check"), reviewStatus, interventionReviewOutput: reviewerOutput },
    runtime.eventBus,
  )

  // post-check 完成
  runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })
}

export const sendReviseAfterFail = async (runtime: WorkflowRuntime, round: number, reviewOutput: string) => {
  if (!runtime.implementerSession) throw new Error("[Revise] Missing implementer session")
  console.log("[Revise] Review failed — sending back to implementer.")

  runtime.eventBus.publish({ type: "phase_change", phase: "revise" })
  runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })

  const { finalText, status, question } = await sendTaskAndMonitor(
    runtime.implementerPane,
    render(runtime.prompts.revise, { reviewOutput: stripStatusLines(reviewOutput), round: String(round) }),
    runtime.implementerSession,
  )

  await handleMonitorResult(
    "implementer", runtime.implementerPane, finalText, status, question,
    `revise round ${round}`, runtime.implementerSession, runtime.needsCheckMode, mkCtx(runtime, round, "revise"),
    runtime.eventBus,
  )

  // handleMonitorResult 正常返回表示 implementer 完成
  runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })
}

export const runReviewLoop = async (
  runtime: WorkflowRuntime, configPath: string, startRound: number,
  reuseCurrentPane: boolean, sessionDir: string, specPath: string,
  issueIndex: number, issues: IssueConfig[], initialOptions?: ReviewLoopOptions,
) => {
  runtime.eventBus.publish({ type: "phase_change", phase: "review" })

  if (runtime.reviewerSession && !runtime.reviewerPane) {
    runtime.reviewerPane = await startAgentResumed(
      runtime.config.projectDir, runtime.config.reviewer,
      runtime.reviewerSession.resumeId, { ensureUniqueName: true },
    )
    await waitForAgentReady(runtime.reviewerPane, agentWaitOptions(runtime.config.reviewer))
  }

  for (let round = startRound; round <= runtime.config.maxReviewRounds; round += 1) {
    let activeLoopOptions: ReviewLoopOptions | undefined = round === startRound ? initialOptions : undefined
    let retrySameRound = true

    while (retrySameRound) {
      retrySameRound = false
      const { reviewOutput, parsed } = await conductReview(runtime, round, sessionDir, specPath, activeLoopOptions ?? {})
      activeLoopOptions = undefined

      // completed + REVIEW_PASS → done
      if (parsed.status === "completed" && "statusValue" in parsed && parsed.statusValue === "REVIEW_PASS") {
        await sendPostReviewCheck(runtime, round, "REVIEW_PASS", reviewOutput)
        console.log(`\n[Review] Workflow finished: review passed in round ${round}.`)
        return
      }

      // needs_input → needs-check
      if (parsed.status === "needs_input") {
        await sendPostReviewCheck(runtime, round, "REVIEW_NEEDS_CHECK", reviewOutput)
        // post-check 完成后发布 pause，避免 implementer working 清除 reviewer 的 needsInput 和 paused 状态
        runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "needs_input" })
        runtime.eventBus.publish({ type: "needs_input", agent: "reviewer", provider: runtime.reviewerSession!.provider, reason: "Review 需要人工核查" })
        runtime.eventBus.publish({ type: "pause", reason: "reviewer needs_input: REVIEW_NEEDS_CHECK" })
        const outcome = await handleNeedsCheck(runtime, configPath, round, reviewOutput, parsed, reuseCurrentPane, sessionDir, specPath, issueIndex, issues)
        if (outcome.type === "approved") return
        if (outcome.type === "continue_round") break
        activeLoopOptions = { controllerReviewNotes: outcome.controllerNotes, lastReviewOutput: outcome.lastReviewOutput }
        retrySameRound = true
        continue
      }

      // P1-4: invalid_output → 不转换为 REVIEW_FAIL，通过 intervention 暂停
      if (parsed.status === "invalid_output") {
        const reason = parsed.reason ?? "输出缺少合法 STATUS"
        console.warn(`[Review] Reviewer invalid output (${reason}). Entering intervention...`)
        // 发布详情和暂停事件
        runtime.eventBus.publish({ type: "invalid_output", agent: "reviewer", provider: runtime.reviewerSession!.provider, reason })
        runtime.eventBus.publish({ type: "pause", reason: `reviewer invalid_output: ${reason}` })
        const resolved = await handleIntervention(
          "reviewer", runtime.reviewerPane, reviewOutput,
          `review round ${round}`, runtime.reviewerSession!, undefined,
          parsed.reason, true, runtime.needsCheckMode, mkCtx(runtime, round, "review-intervention"),
        )
        // intervention 完成后恢复
        runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "working" })
        const reParsed = parseAgentOutput(resolved, "reviewer")
        if (reParsed.status === "completed") {
          // 干预后有合法输出，重新进入同轮判断
          const { reviewOutput: newOutput } = await conductReview(runtime, round, sessionDir, specPath, {})
          const newParsed = parseAgentOutput(newOutput, "reviewer")
          if (newParsed.status === "completed" && "statusValue" in newParsed && newParsed.statusValue === "REVIEW_PASS") {
            await sendPostReviewCheck(runtime, round, "REVIEW_PASS", reviewOutput)
            console.log(`\n[Review] Workflow finished after intervention.`)
            return
          }
        }
        // 干预失败→按 fail 处理
      }

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
