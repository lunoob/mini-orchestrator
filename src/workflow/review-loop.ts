import { resolveNeedsCheckDecision } from "../review/needs-check.js"
import type { IssueConfig } from "../types.js"
import { render } from "../lib/utils.js"
import { handleSessionImplementOutcome } from "./implement-ask.js"
import { buildDiffFileSection, prepareReviewContext } from "./review-context.js"
import { buildCheckpointInput, type NeedsCheckOutcome, type PostReviewStatus, type ReviewLoopOptions, type WorkflowRuntime } from "./types.js"
import { parseAgentOutcome, type ReviewerOutcome, OutcomeParseError } from "./agent-outcome.js"

const requireImplementer = (runtime: WorkflowRuntime) => {
  if (runtime.implementerSession) return runtime.implementerSession
  throw new Error("[Workflow] Implementer session is not started")
}

const requireReviewer = (runtime: WorkflowRuntime) => {
  if (runtime.reviewerSession) return runtime.reviewerSession
  throw new Error("[Workflow] Reviewer session is not started")
}

/** 从 reviewer 输出中解析 outcome，格式错误时发送修正消息 */
const parseReviewerOutcome = async (
  output: string,
  reviewer: { sendTaskAndWait: (prompt: string) => Promise<string> },
): Promise<ReviewerOutcome> => {
  try {
    return parseAgentOutcome(output, "reviewer") as ReviewerOutcome
  } catch (e) {
    if (!(e instanceof OutcomeParseError)) throw e

    // 格式错误：发送修正消息
    const retryOutput = await reviewer.sendTaskAndWait(
      "你的上一轮输出不符合 JSON outcome 规范。请严格按照 schema 输出纯 JSON 对象，不要包含任何说明文字或 Markdown code fence。"
    )
    return parseAgentOutcome(retryOutput, "reviewer") as ReviewerOutcome
  }
}

export const sendControllerRevise = async (
  runtime: WorkflowRuntime,
  round: number,
  controllerNotes: string,
  reviewOutput: string,
) => {
  const implementer = requireImplementer(runtime)
  const output = await implementer.sendTaskAndWait(render(runtime.prompts.controllerImplementer, {
      controllerNotes,
      reviewOutput,
      round: String(round),
    }))

  await handleSessionImplementOutcome(
    output,
    `controller revise round ${round}`,
    implementer,
    runtime.userDecisionBroker,
  )
}

const conductReview = async (
  runtime: WorkflowRuntime,
  round: number,
  sessionDir: string,
  specPath: string,
  options: ReviewLoopOptions = {},
) => {
  const reviewContext = await prepareReviewContext(sessionDir, runtime.config.projectDir, runtime.baseSha, round)
  if (reviewContext.diffFile) {
    console.log(`[Review] Review package: ${reviewContext.diffFile}`)
  }

  const diffFileSection = buildDiffFileSection(reviewContext.diffFile, !runtime.hasGit)
  const prompt =
    options.controllerReviewNotes && options.lastReviewOutput
      ? render(runtime.prompts.controllerReReview, {
          baseSha: reviewContext.baseSha,
          controllerNotes: options.controllerReviewNotes,
          diffFileSection,
          headSha: reviewContext.headSha,
          reviewOutput: options.lastReviewOutput,
          round: String(round),
          specPath,
        })
      : render(runtime.prompts[round === 1 ? "review" : "reReview"], {
          baseSha: reviewContext.baseSha,
          diffFileSection,
          headSha: reviewContext.headSha,
          round: String(round),
          specPath,
        })

  let reviewOutput = await requireReviewer(runtime).sendTaskAndWait(prompt)
  let outcome = await parseReviewerOutcome(reviewOutput, requireReviewer(runtime))

  console.log(`[Review] Round ${round}: ${outcome.summary}`)

  // 循环处理 reviewer 的 needs_input，直到 completed 或 failed
  while (outcome.outcome === "needs_input") {
    const reviewer = requireReviewer(runtime)
    const broker = runtime.userDecisionBroker
    if (!broker) {
      throw new Error("[Review] reviewer 返回 needs_input 但未配置 userDecisionBroker")
    }

    console.log(`[Review] reviewer 需要用户输入: ${outcome.request!.question}`)
    const decision = await broker.requestDecision(reviewer.sessionId, "reviewer", outcome.request!)
    if (!decision) {
      throw new Error("[Review] 用户取消了 reviewer 的输入请求")
    }

    const userMessage = JSON.stringify({
      type: "user_decision",
      optionId: decision.optionId,
      text: decision.text,
    })
    // 将用户回答发回 reviewer session，继续循环
    reviewOutput = await reviewer.sendTaskAndWait(userMessage)
    outcome = await parseReviewerOutcome(reviewOutput, reviewer)
    console.log(`[Review] Round ${round} (retry): ${outcome.summary}`)
  }

  if (outcome.outcome === "failed") {
    throw new Error(`[Review] reviewer 报告失败: ${outcome.failure?.message ?? outcome.summary}`)
  }

  // outcome.outcome === "completed"
  return {
    reviewOutput,
    outcome,
    verdict: outcome.review?.verdict ?? "fail",
  }
}

const handleNeedsCheck = async (
  runtime: WorkflowRuntime,
  configPath: string,
  round: number,
  reviewOutput: string,
  verdict: { cannotVerifySummary: string | null; kind: "pass" | "fail" | "needs_check"; hasCannotVerify: boolean; passed: boolean },
  reuseCurrentPane: boolean,
  sessionDir: string,
  specPath: string,
  issueIndex: number,
  issues: IssueConfig[],
): Promise<NeedsCheckOutcome> => {
  const decision = await resolveNeedsCheckDecision(
    runtime.args,
    runtime.needsCheckMode,
    round,
    verdict,
    reviewOutput,
    buildCheckpointInput(runtime, configPath, round, reviewOutput, verdict, reuseCurrentPane, specPath, issueIndex, issues),
    sessionDir,
  )

  switch (decision.action) {
    case "approve":
      console.log(`\n[NeedsCheck] Workflow finished: manually approved after needs_check in round ${round}.`)
      return { type: "approved" }
    case "abort":
      throw new Error(`[NeedsCheck] Workflow aborted by user after needs_check in round ${round}.`)
    case "revise":
      console.log("[NeedsCheck] Needs check → revise: sending controller notes to implementer.")
      await sendControllerRevise(runtime, round, decision.notes, reviewOutput)
      return { type: "continue_round" }
    case "retry-review":
      console.log("[NeedsCheck] Needs check → retry-review: re-reviewing same round with controller context.")
      return {
        type: "retry_same_round",
        controllerNotes: decision.notes,
        lastReviewOutput: reviewOutput,
      }
    default: {
      const _exhaustive: never = decision.action
      throw new Error(`[NeedsCheck] Unknown needs-check action: ${_exhaustive}`)
    }
  }
}

const sendPostReviewCheck = async (
  runtime: WorkflowRuntime,
  round: number,
  reviewStatus: PostReviewStatus,
) => {
  console.log(`[PostCheck] Review ${reviewStatus} — sending implementer to verify TypeScript and lint checks.`)

  const implementer = requireImplementer(runtime)
  const output = await implementer.sendTaskAndWait(render(runtime.prompts.postReviewCheck, {
      reviewStatus,
      round: String(round),
    }))

  await handleSessionImplementOutcome(
    output,
    `post-review check round ${round}`,
    implementer,
    runtime.userDecisionBroker,
  )
}

const sendReviseAfterFail = async (
  runtime: WorkflowRuntime,
  round: number,
  reviewOutput: string,
) => {
  console.log("[Revise] Review failed — sending back to implementer.")

  const implementer = requireImplementer(runtime)
  const output = await implementer.sendTaskAndWait(render(runtime.prompts.revise, {
      reviewOutput,
      round: String(round),
    }))

  await handleSessionImplementOutcome(
    output,
    `revise round ${round}`,
    implementer,
    runtime.userDecisionBroker,
  )
}

export const runReviewLoop = async (
  runtime: WorkflowRuntime,
  configPath: string,
  startRound: number,
  reuseCurrentPane: boolean,
  sessionDir: string,
  specPath: string,
  issueIndex: number,
  issues: IssueConfig[],
  initialOptions?: ReviewLoopOptions,
) => {
  for (let round = startRound; round <= runtime.config.maxReviewRounds; round += 1) {
    let activeLoopOptions: ReviewLoopOptions | undefined = round === startRound ? initialOptions : undefined
    let retrySameRound = true

    while (retrySameRound) {
      retrySameRound = false

      const { reviewOutput, outcome, verdict } = await conductReview(runtime, round, sessionDir, specPath, activeLoopOptions ?? {})
      activeLoopOptions = undefined

      if (verdict === "pass") {
        await sendPostReviewCheck(runtime, round, "REVIEW_PASS")
        console.log(`\n[Review] Workflow finished: review passed in round ${round}.`)
        return
      }

      if (verdict === "needs_check") {
        await sendPostReviewCheck(runtime, round, "REVIEW_NEEDS_CHECK")
        const cannotVerifySummary = outcome.review?.cannotVerifySummary ?? null
        const needsCheckOutcome = await handleNeedsCheck(
          runtime,
          configPath,
          round,
          reviewOutput,
          {
            cannotVerifySummary,
            hasCannotVerify: cannotVerifySummary !== null,
            kind: "needs_check",
            passed: false,
          },
          reuseCurrentPane,
          sessionDir,
          specPath,
          issueIndex,
          issues,
        )

        if (needsCheckOutcome.type === "approved") return

        if (needsCheckOutcome.type === "continue_round") break

        activeLoopOptions = {
          controllerReviewNotes: needsCheckOutcome.controllerNotes,
          lastReviewOutput: needsCheckOutcome.lastReviewOutput,
        }
        retrySameRound = true
        continue
      }

      if (round === runtime.config.maxReviewRounds) {
        throw new Error(`[Review] Review failed after ${runtime.config.maxReviewRounds} rounds.`)
      }

      await sendReviseAfterFail(runtime, round, reviewOutput)
      break
    }
  }

  throw new Error(`[Review] Review failed after ${runtime.config.maxReviewRounds} rounds.`)
}
