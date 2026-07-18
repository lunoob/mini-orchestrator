import { resolveNeedsCheckDecision } from "../review/needs-check.js"
import type { IssueConfig } from "../types.js"
import {
  agentWaitOptions,
  sendTaskAndWait,
} from "../agent/index.js"
import {
  extractImplementResult,
  extractReviewResult,
  extractStatusLines,
  parseImplementStatus,
  parseReviewVerdict,
  printSection,
  render,
  stripStatusLines,
} from "../lib/utils.js"
import { handleImplementAskIfNeeded } from "./implement-ask.js"
import { buildDiffFileSection, prepareReviewContext } from "./review-context.js"
import { buildCheckpointInput, type NeedsCheckOutcome, type PostReviewStatus, type ReviewLoopOptions, type WorkflowRuntime } from "./types.js"

export const sendControllerRevise = async (
  runtime: WorkflowRuntime,
  round: number,
  controllerNotes: string,
  reviewOutput: string,
) => {
  const output = await sendTaskAndWait(
    runtime.implementerPane,
    render(runtime.prompts.controllerImplementer, {
      controllerNotes,
      reviewOutput: stripStatusLines(extractReviewResult(reviewOutput)),
      round: String(round),
    }),
    agentWaitOptions(runtime.config.implementer),
  )

  const resolvedOutput = await handleImplementAskIfNeeded(
    runtime.implementerPane,
    output,
    `controller revise round ${round}`,
  )
  const implementStatus = parseImplementStatus(extractImplementResult(resolvedOutput))
  if (implementStatus === "unknown") {
    console.warn(
      `[Controller] Warning: implementer did not output STATUS: IMPLEMENT_DONE after controller revise round ${round}.`,
    )
  }
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
          reviewOutput: stripStatusLines(options.lastReviewOutput),
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

  const reviewOutput = await sendTaskAndWait(
    runtime.reviewerPane,
    prompt,
    agentWaitOptions(runtime.config.reviewer),
  )
  const reviewResult = extractReviewResult(reviewOutput)
  printSection(`Review Round ${round}`, extractStatusLines(reviewResult) || "(no STATUS)")

  return { reviewOutput, verdict: parseReviewVerdict(reviewResult) }
}

const handleNeedsCheck = async (
  runtime: WorkflowRuntime,
  configPath: string,
  round: number,
  reviewOutput: string,
  verdict: ReturnType<typeof parseReviewVerdict>,
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

  const output = await sendTaskAndWait(
    runtime.implementerPane,
    render(runtime.prompts.postReviewCheck, {
      reviewStatus,
      round: String(round),
    }),
    agentWaitOptions(runtime.config.implementer),
  )

  const resolvedOutput = await handleImplementAskIfNeeded(
    runtime.implementerPane,
    output,
    `post-review check round ${round}`,
  )
  const implementStatus = parseImplementStatus(extractImplementResult(resolvedOutput))
  if (implementStatus === "unknown") {
    console.warn(
      `[PostCheck] Warning: implementer did not output STATUS: IMPLEMENT_DONE after post-review check round ${round}.`,
    )
  }
}

const sendReviseAfterFail = async (
  runtime: WorkflowRuntime,
  round: number,
  reviewOutput: string,
) => {
  console.log("[Revise] Review failed — sending back to implementer.")

  const output = await sendTaskAndWait(
    runtime.implementerPane,
    render(runtime.prompts.revise, {
      reviewOutput: stripStatusLines(extractReviewResult(reviewOutput)),
      round: String(round),
    }),
    agentWaitOptions(runtime.config.implementer),
  )

  const resolvedOutput = await handleImplementAskIfNeeded(
    runtime.implementerPane,
    output,
    `revise round ${round}`,
  )
  const implementStatus = parseImplementStatus(extractImplementResult(resolvedOutput))
  if (implementStatus === "unknown") {
    console.warn(
      `[Revise] Warning: implementer did not output STATUS: IMPLEMENT_DONE after revise round ${round}.`,
    )
  }
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

      const { reviewOutput, verdict } = await conductReview(runtime, round, sessionDir, specPath, activeLoopOptions ?? {})
      activeLoopOptions = undefined

      if (verdict.kind === "pass") {
        await sendPostReviewCheck(runtime, round, "REVIEW_PASS")
        console.log(`\n[Review] Workflow finished: review passed in round ${round}.`)
        return
      }

      if (verdict.kind === "needs_check") {
        await sendPostReviewCheck(runtime, round, "REVIEW_NEEDS_CHECK")
        const outcome = await handleNeedsCheck(
          runtime,
          configPath,
          round,
          reviewOutput,
          verdict,
          reuseCurrentPane,
          sessionDir,
          specPath,
          issueIndex,
          issues,
        )

        if (outcome.type === "approved") return

        if (outcome.type === "continue_round") break

        activeLoopOptions = {
          controllerReviewNotes: outcome.controllerNotes,
          lastReviewOutput: outcome.lastReviewOutput,
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
