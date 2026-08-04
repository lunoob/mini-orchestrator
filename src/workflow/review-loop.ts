import { promptNeedsCheckGate } from "../review/needs-check.js"
import {
  bootstrapSession,
  sendTask,
  sendTaskAndMonitor,
  startAgentResumed,
  waitForAgentWithMonitor,
} from "../agent/index.js"
import type { AgentRole, AgentSessionHandle } from "../agent/transcript/types.js"
import {
  extractStatusSummary,
  printSection,
  render,
  stripStatus,
} from "../lib/utils.js"
import { parseStatus } from "../lib/status-parser.js"
import { notifyNeedsInput, resetNotifyDedup } from "../notify/index.js"
import { handleNeedsInputGate, defaultImplementAskDeps, ensureStatusRetry, CONTINUATION_PROMPT, type ImplementAskDeps } from "./implement-ask.js"
import { buildDiffFileSection, prepareReviewContext } from "./review-context.js"
import type { PostReviewStatus, ReviewLoopOptions, WorkflowRuntime } from "./types.js"

/**
 * 统一处理 sendTaskAndMonitor 返回结果。
 *
 * 状态语义：
 * - monitor needs_input（原生提问）或 STATUS: xxx_ASK/NEEDS_CHECK → yes/no 门卫
 * - monitor failed / IMPLEMENT_FAILED / REVIEW_FAIL → 终止
 * - 无 STATUS 标记 → 重试补标记（最多 MAX_MISSING_STATUS_RETRIES 次）
 * - 其余 → 返回最终文本
 */
export const handleMonitorResult = async (
  role: AgentRole,
  paneId: string,
  finalText: string,
  status: string,
  question: string | undefined,
  context: string,
  session: AgentSessionHandle,
  eventBus?: import("./events.js").WorkflowEventBus,
): Promise<string> => {
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

  // monitor 级 needs_input（原生提问）→ 门卫，循环处理 gate 后的新状态
  if (status === "needs_input") {
    publishInterventionEvents(question ?? "需要确认")
    const gated = await handleNeedsInputGate(role, paneId, context, session, depsWithBus, question)
    publishResumeEvents()
    return settleAgentStatus(role, gated.finalText, gated.status, paneId, context, session, depsWithBus)
  }

  // failed（monitor 级）→ 直接终止
  if (status === "failed") {
    if (eventBus) {
      eventBus.publish({ type: "agent_state_change", agent: agentKey, status: "failed" })
      eventBus.publish({ type: "fail", reason: `${role} failed in ${context}` })
    }
    throw new Error(`[${role}] Agent failed in ${context}`)
  }

  return settleAgentStatus(role, finalText, status, paneId, context, session, depsWithBus)
}

/**
 * 循环处理 agent 输出直到返回一个可决策状态。
 *
 * - 原生 needs_input（monitor 级）→ 通用门卫；gate 后可能再次 needs_input → 循环
 * - implementer 的 IMPLEMENT_ASK → 通用门卫
 * - implementer 的 IMPLEMENT_FAILED → 抛错终止
 * - 无 STATUS 标记 → 重试补标记
 * - reviewer 的 REVIEW_* → 直接返回，由 runReviewLoop 决策（PASS/FAIL/NEEDS_CHECK 三个分支）
 * - implementer 的 IMPLEMENT_DONE → 返回
 */
const settleAgentStatus = async (
  role: AgentRole,
  initialOutput: string,
  initialStatus: string,
  paneId: string,
  context: string,
  session: AgentSessionHandle,
  depsWithBus?: ImplementAskDeps,
): Promise<string> => {
  const agentKey = role === "implementer" ? "implementer" : "reviewer"

  let currentOutput = initialOutput
  let currentStatus = initialStatus
  while (true) {
    const parsed = parseStatus(currentOutput, role)

    // 原生提问（monitor 级）→ 通用门卫，再次展示 yes/no
    if (currentStatus === "needs_input") {
      if (depsWithBus?.eventBus) {
        depsWithBus.eventBus.publish({ type: "agent_state_change", agent: agentKey, status: "needs_input" })
        depsWithBus.eventBus.publish({ type: "needs_input", agent: agentKey, provider: session.provider, reason: "Agent 需要人工处理" })
        depsWithBus.eventBus.publish({ type: "pause", reason: `${role} needs_input: Agent 需要人工处理` })
      }
      const gated = await handleNeedsInputGate(role, paneId, context, session, depsWithBus, "Agent 需要人工处理")
      if (depsWithBus?.eventBus) {
        depsWithBus.eventBus.publish({ type: "agent_state_change", agent: agentKey, status: "working" })
      }
      currentOutput = gated.finalText
      currentStatus = gated.status
      continue
    }

    // implementer：IMPLEMENT_ASK → 通用门卫
    if (role === "implementer" && parsed.status === "IMPLEMENT_ASK") {
      if (depsWithBus?.eventBus) {
        depsWithBus.eventBus.publish({ type: "agent_state_change", agent: agentKey, status: "needs_input" })
        depsWithBus.eventBus.publish({ type: "needs_input", agent: agentKey, provider: session.provider, reason: "Agent 需要人工处理" })
        depsWithBus.eventBus.publish({ type: "pause", reason: `${role} needs_input: Agent 需要人工处理` })
      }
      const gated = await handleNeedsInputGate(role, paneId, context, session, depsWithBus, "Agent 需要人工处理")
      if (depsWithBus?.eventBus) {
        depsWithBus.eventBus.publish({ type: "agent_state_change", agent: agentKey, status: "working" })
      }
      currentOutput = gated.finalText
      currentStatus = gated.status
      continue
    }

    // implementer：IMPLEMENT_FAILED → 抛错终止
    if (role === "implementer" && parsed.status === "IMPLEMENT_FAILED") {
      if (depsWithBus?.eventBus) {
        depsWithBus.eventBus.publish({ type: "agent_state_change", agent: agentKey, status: "failed" })
        depsWithBus.eventBus.publish({ type: "fail", reason: `implementer reported IMPLEMENT_FAILED in ${context}` })
      }
      throw new Error(`[implementer] Agent reported IMPLEMENT_FAILED in ${context}`)
    }

    // 无 STATUS → 重试补标记；补标记后可能又 needs_input，循环处理
    if (!parsed.status) {
      const retried = await ensureStatusRetry(role, paneId, currentOutput, context, session, depsWithBus)
      currentOutput = retried.finalText
      currentStatus = retried.status
      continue
    }

    // reviewer 的 REVIEW_* 或 implementer 的 IMPLEMENT_DONE → 返回，由上层决策
    return currentOutput
  }
}

/** 按需启动 implementer：仅当 review 需要它（revise / post-check）时才 bootstrap 并创建 pane，返回其 session */
const ensureImplementer = async (runtime: WorkflowRuntime): Promise<AgentSessionHandle> => {
  if (runtime.implementerPane) return runtime.implementerSession!
  if (!runtime.implementerSession) {
    runtime.implementerSession = await bootstrapSession(runtime.config.agents.implementer)
  }
  runtime.implementerPane = await startAgentResumed(
    runtime.config.projectDir,
    runtime.config.agents.implementer,
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
      controllerNotes, reviewOutput: stripStatus(reviewOutput, "reviewer"), round: String(round),
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

  runtime.eventBus.publish({ type: "review_round_change", round, maxRounds: runtime.config.maxRounds.workflow })
  runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "working" })

  const reviewContext = await prepareReviewContext(sessionDir, runtime.config.projectDir, runtime.baseSha, round)
  if (reviewContext.diffFile) console.log(`[Review] Review package: ${reviewContext.diffFile}`)

  const diffFileSection = buildDiffFileSection(reviewContext.diffFile, !runtime.hasGit)
  const prompt = options.controllerReviewNotes && options.lastReviewOutput
    ? render(runtime.prompts.controllerReReview, {
        baseSha: reviewContext.baseSha, controllerNotes: options.controllerReviewNotes,
        diffFileSection, headSha: reviewContext.headSha,
        reviewOutput: stripStatus(options.lastReviewOutput, "reviewer"), round: String(round), specPath,
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

  const parsed = parseStatus(final, "reviewer")
  printSection(`Review Round ${round}`, extractStatusSummary(final, "reviewer") || "(no status)")

  // 发布 reviewer 状态
  if (parsed.status === "REVIEW_PASS" || parsed.status === "REVIEW_FAIL") {
    runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "completed" })
  } else if (parsed.status === "REVIEW_NEEDS_CHECK") {
    runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "needs_input" })
    runtime.eventBus.publish({ type: "needs_input", agent: "reviewer", provider: runtime.reviewerSession.provider, reason: "Review 需要人工核查" })
  }

  return { reviewOutput: final, parsed }
}

/**
 * REVIEW_NEEDS_CHECK 的处理：通知用户 → 去 reviewer pane 处理 → yes/no 门卫。
 * - yes：发 continuation 给 reviewer 重新审查，返回新一轮输出
 * - no：抛错终止 workflow
 *
 * session / pane 由调用方传入：局部 review 用普通 reviewer，final gate 用 Final Reviewer。
 */
export const handleNeedsCheck = async (
  runtime: WorkflowRuntime, round: number, session: AgentSessionHandle, pane: string,
): Promise<{ action: "approved" | "revised"; finalText?: string }> => {
  notifyNeedsInput(
    "reviewer", session.provider,
    "Review 需要人工核查",
    session.resumeId, pane,
    String(session.offset),
  )

  const yes = await promptNeedsCheckGate(round, runtime.eventBus)
  if (!yes) {
    throw new Error(`[NeedsCheck] Workflow aborted by user after needs_check in round ${round}.`)
  }

  // yes：发 continuation 给 reviewer 重新审查（用户已在 pane 处理完）
  runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "working" })
  await sendTask(pane, CONTINUATION_PROMPT)
  const result = await waitForAgentWithMonitor(session)
  session.offset = result.finalOffset
  resetNotifyDedup()

  const depsWithBus = { ...defaultImplementAskDeps(), eventBus: runtime.eventBus }
  let finalText = result.finalText
  let currentStatus = result.status
  let currentQuestion = result.lastEvent?.question

  // 循环处理重审结果：原生提问 → 通用门卫（可能再次提问 → 再门卫）；无 STATUS → 补标记
  while (true) {
    if (currentStatus === "failed") {
      throw new Error(`[NeedsCheck] Reviewer failed during re-review in round ${round}.`)
    }

    // 原生提问 → 通用门卫（用户去 pane 回答后再续；可能再次提问 → 再门卫）
    if (currentStatus === "needs_input") {
      const gated = await handleNeedsInputGate(
        "reviewer", pane, `needs_check round ${round}`, session,
        depsWithBus, currentQuestion,
      )
      runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "working" })
      finalText = gated.finalText
      currentStatus = gated.status
      currentQuestion = gated.question
      continue
    }

    // 重审后无 STATUS 标记 → 按约定提示补标记（最多 2 次），仍无则抛错终止
    if (!parseStatus(finalText, "reviewer").status) {
      const retried = await ensureStatusRetry(
        "reviewer", pane, finalText, `needs_check round ${round}`, session,
        depsWithBus,
      )
      finalText = retried.finalText
      currentStatus = retried.status
      continue
    }

    return { action: "revised", finalText }
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
    render(runtime.prompts.revise, { reviewOutput: stripStatus(reviewOutput, "reviewer"), round: String(round) }),
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
      runtime.config.projectDir, runtime.config.agents.reviewer,
      runtime.reviewerSession.resumeId, { ensureUniqueName: true },
    )
  }

  for (let round = startRound; round <= runtime.config.maxRounds.workflow; round += 1) {
    let activeLoopOptions: ReviewLoopOptions | undefined = round === startRound ? initialOptions : undefined
    let retrySameRound = true

    while (retrySameRound) {
      retrySameRound = false
      const { reviewOutput, parsed } = await conductReview(runtime, round, sessionDir, specPath, activeLoopOptions ?? {})
      activeLoopOptions = undefined

      // REVIEW_PASS → 完成
      if (parsed.status === "REVIEW_PASS") {
        await sendPostReviewCheck(runtime, round, "REVIEW_PASS")
        console.log(`\n[Review] Workflow finished: review passed in round ${round}.`)
        return
      }

      // REVIEW_NEEDS_CHECK → 人工核查门卫（yes 后 reviewer 重审，REVIEW_PASS 后才 post-check）
      if (parsed.status === "REVIEW_NEEDS_CHECK") {
        runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "needs_input" })
        runtime.eventBus.publish({ type: "needs_input", agent: "reviewer", provider: runtime.reviewerSession!.provider, reason: "Review 需要人工核查" })
        runtime.eventBus.publish({ type: "pause", reason: "reviewer needs_check" })

        // 门卫循环：yes 后 reviewer 重审，可能再次 needs_check（用户在 pane 继续处理）或 pass/fail
        let needsCheckOutput = reviewOutput
        let needsCheckRound = 0
        while (true) {
          needsCheckRound++
          if (needsCheckRound > runtime.config.maxRounds.workflow) {
            runtime.eventBus.publish({ type: "fail", reason: `Review needs_check exceeded ${runtime.config.maxRounds.workflow} rounds` })
            throw new Error(`[Review] needs_check exceeded ${runtime.config.maxRounds.workflow} rounds.`)
          }
          const decision = await handleNeedsCheck(runtime, round, runtime.reviewerSession!, runtime.reviewerPane)
          if (decision.action === "approved") return
          needsCheckOutput = decision.finalText ?? ""
          const reParsed = parseStatus(needsCheckOutput, "reviewer")
          if (reParsed.status === "REVIEW_PASS") {
            // 人工核查确认后 reviewer 重审通过 → 才执行 post-check
            await sendPostReviewCheck(runtime, round, "REVIEW_PASS")
            console.log(`\n[Review] Workflow finished: review passed after needs_check in round ${round}.`)
            return
          }
          if (reParsed.status === "REVIEW_FAIL") {
            // 重审 fail → 进入 revise 修复
            if (round === runtime.config.maxRounds.workflow) {
              runtime.eventBus.publish({ type: "fail", reason: `Review failed after ${runtime.config.maxRounds.workflow} rounds` })
              throw new Error(`[Review] Review failed after ${runtime.config.maxRounds.workflow} rounds.`)
            }
            await sendReviseAfterFail(runtime, round, needsCheckOutput)
            break
          }
          // 仍 needs_check：重新发布事件，用户再处理
          runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "needs_input" })
          runtime.eventBus.publish({ type: "needs_input", agent: "reviewer", provider: runtime.reviewerSession!.provider, reason: "Review 需要人工核查" })
          runtime.eventBus.publish({ type: "pause", reason: "reviewer needs_check" })
        }
        // needs_check 门卫循环结束（revise 已发）→ 进入下一轮
        break
      }

      // REVIEW_FAIL 或 failed → 进入 revise 流程
      if (round === runtime.config.maxRounds.workflow) {
        runtime.eventBus.publish({ type: "fail", reason: `Review failed after ${runtime.config.maxRounds.workflow} rounds` })
        throw new Error(`[Review] Review failed after ${runtime.config.maxRounds.workflow} rounds.`)
      }

      await sendReviseAfterFail(runtime, round, reviewOutput)
      break
    }
  }

  runtime.eventBus.publish({ type: "fail", reason: `Review failed after ${runtime.config.maxRounds.workflow} rounds` })
  throw new Error(`[Review] Review failed after ${runtime.config.maxRounds.workflow} rounds.`)
}
