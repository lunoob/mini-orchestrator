import path from "node:path"

import { readNeedsCheckCheckpoint } from "./checkpoint.js"
import { isFlagEnabled } from "./cli.js"
import { loadConfig, loadImplementSkills, loadPrompts, loadReviseSkills } from "./config.js"
import { getHeadShaSafe, getReviewBaselineSha, isGitRepo } from "./git.js"
import {
  agentWaitOptions,
  getCurrentPane,
  readAgentOutput,
  sendTaskAndWait,
  startAgent,
  waitForAgentReady,
} from "./herdr.js"
import {
  parseNeedsCheckAction,
  parseNeedsCheckMode,
  resolveNeedsCheckDecision,
  type NeedsCheckMode,
} from "./needs-check.js"
import { generateReviewPackage } from "./review-package.js"
import type { LoadedPrompts, ParsedArgs, WorkflowConfig } from "./types.js"
import { parseReviewVerdict, printSection, render, type ReviewVerdict } from "./utils.js"

type WorkflowRuntime = {
  args: ParsedArgs
  baseSha: string | undefined
  config: WorkflowConfig
  hasGit: boolean
  implementerPane: string
  needsCheckMode: NeedsCheckMode
  prompts: LoadedPrompts
  reviewerPane: string
  reviseSkills: string
}

type ReviewLoopOptions = {
  controllerReviewNotes?: string
  lastReviewOutput?: string
}

type NeedsCheckOutcome =
  | { type: "approved" }
  | { type: "continue_round" }
  | { type: "retry_same_round"; controllerNotes: string; lastReviewOutput: string }

const buildDiffFileSection = (diffFile: string | undefined, noGit: boolean) => {
  if (!diffFile) {
    const reason = noGit
      ? "项目不是 git 仓库"
      : "无可用 commit 范围或无法生成 diff"
    return [
      "",
      `（未生成 diff 文件——${reason}。请审查工作区改动，并阅读 \`task_plan.md\` / \`progress.md\`。）`,
    ].join("\n")
  }

  return ["", `**Diff 文件（先读此文件）：** ${diffFile}`].join("\n")
}

const formatBaselineLabel = (baseSha: string | undefined) =>
  baseSha ?? "(workflow start — no commits yet)"

const prepareReviewContext = async (
  projectDir: string,
  baseSha: string | undefined,
  round: number,
) => {
  if (!(await isGitRepo(projectDir))) {
    return { baseSha: "N/A", diffFile: undefined, headSha: "N/A" }
  }

  const headSha = await getHeadShaSafe(projectDir)
  const diffFile = await generateReviewPackage(projectDir, baseSha, headSha, round)
  return {
    baseSha: formatBaselineLabel(baseSha),
    diffFile,
    headSha: headSha ?? "N/A",
  }
}

const buildCheckpointInput = (
  runtime: WorkflowRuntime,
  configPath: string,
  round: number,
  reviewOutput: string,
  verdict: ReviewVerdict,
  reuseCurrentPane: boolean,
) => ({
  baseSha: runtime.baseSha,
  cannotVerifySummary: verdict.cannotVerifySummary,
  configPath,
  hasGit: runtime.hasGit,
  implementerPane: runtime.implementerPane,
  maxReviewRounds: runtime.config.maxReviewRounds,
  projectDir: runtime.config.projectDir,
  reviewOutput,
  reviewerPane: runtime.reviewerPane,
  reuseCurrentPane,
  round,
  specPath: runtime.config.specPath,
})

const sendControllerRevise = async (
  runtime: WorkflowRuntime,
  round: number,
  controllerNotes: string,
  reviewOutput: string,
) => {
  await sendTaskAndWait(
    runtime.implementerPane,
    render(runtime.prompts.controllerImplementer, {
      controllerNotes,
      reviewOutput,
      reviseSkills: runtime.reviseSkills,
      round: String(round),
    }),
    agentWaitOptions(runtime.config.implementer),
  )
}

const conductReview = async (
  runtime: WorkflowRuntime,
  round: number,
  options: ReviewLoopOptions = {},
) => {
  const reviewContext = await prepareReviewContext(runtime.config.projectDir, runtime.baseSha, round)
  if (reviewContext.diffFile) {
    console.log(`Review package: ${reviewContext.diffFile}`)
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
          specPath: runtime.config.specPath,
        })
      : render(runtime.prompts.review, {
          baseSha: reviewContext.baseSha,
          diffFileSection,
          headSha: reviewContext.headSha,
          round: String(round),
          specPath: runtime.config.specPath,
        })

  await sendTaskAndWait(
    runtime.reviewerPane,
    prompt,
    agentWaitOptions(runtime.config.reviewer),
  )

  const reviewOutput = await readAgentOutput(runtime.reviewerPane, 280)
  printSection(`Review Round ${round}`, reviewOutput)

  return { reviewOutput, verdict: parseReviewVerdict(reviewOutput) }
}

const handleNeedsCheck = async (
  runtime: WorkflowRuntime,
  configPath: string,
  round: number,
  reviewOutput: string,
  verdict: ReviewVerdict,
  reuseCurrentPane: boolean,
): Promise<NeedsCheckOutcome> => {
  const decision = await resolveNeedsCheckDecision(
    runtime.args,
    runtime.needsCheckMode,
    round,
    verdict,
    reviewOutput,
    buildCheckpointInput(runtime, configPath, round, reviewOutput, verdict, reuseCurrentPane),
  )

  switch (decision.action) {
    case "approve":
      console.log(`\nWorkflow finished: manually approved after needs_check in round ${round}.`)
      return { type: "approved" }
    case "abort":
      throw new Error(`Workflow aborted by user after needs_check in round ${round}.`)
    case "revise":
      console.log("Needs check → revise: sending controller notes to implementer.")
      await sendControllerRevise(runtime, round, decision.notes, reviewOutput)
      return { type: "continue_round" }
    case "retry-review":
      console.log("Needs check → retry-review: re-reviewing same round with controller context.")
      return {
        type: "retry_same_round",
        controllerNotes: decision.notes,
        lastReviewOutput: reviewOutput,
      }
    default: {
      const _exhaustive: never = decision.action
      throw new Error(`Unknown needs-check action: ${_exhaustive}`)
    }
  }
}

const sendReviseAfterFail = async (
  runtime: WorkflowRuntime,
  round: number,
  reviewOutput: string,
  verdict: ReviewVerdict,
) => {
  if (verdict.hasBlockingIssues) {
    console.log("Blocking issues (Critical/Important) — sending back to implementer.")
  } else {
    console.log("Review failed — sending back to implementer.")
  }

  await sendTaskAndWait(
    runtime.implementerPane,
    render(runtime.prompts.revise, {
      reviewOutput,
      reviseSkills: runtime.reviseSkills,
      round: String(round),
    }),
    agentWaitOptions(runtime.config.implementer),
  )
}

const runReviewLoop = async (
  runtime: WorkflowRuntime,
  configPath: string,
  startRound: number,
  reuseCurrentPane: boolean,
  initialOptions?: ReviewLoopOptions,
) => {
  for (let round = startRound; round <= runtime.config.maxReviewRounds; round += 1) {
    let activeLoopOptions: ReviewLoopOptions | undefined = round === startRound ? initialOptions : undefined
    let retrySameRound = true

    while (retrySameRound) {
      retrySameRound = false

      const { reviewOutput, verdict } = await conductReview(runtime, round, activeLoopOptions ?? {})
      activeLoopOptions = undefined

      if (verdict.kind === "pass") {
        console.log(`\nWorkflow finished: review passed in round ${round}.`)
        if (verdict.specCompliant !== null || verdict.qualityApproved !== null) {
          console.log(
            `Verdict: spec=${verdict.specCompliant ? "✅" : "—"}, quality=${verdict.qualityApproved ? "Approved" : "—"}`,
          )
        }
        return
      }

      if (verdict.kind === "needs_check") {
        const outcome = await handleNeedsCheck(
          runtime,
          configPath,
          round,
          reviewOutput,
          verdict,
          reuseCurrentPane,
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
        throw new Error(`Review failed after ${runtime.config.maxReviewRounds} rounds.`)
      }

      await sendReviseAfterFail(runtime, round, reviewOutput, verdict)
      break
    }
  }

  throw new Error(`Review failed after ${runtime.config.maxReviewRounds} rounds.`)
}

const runWorkflowResume = async (args: ParsedArgs) => {
  const checkpointPath = path.resolve(args["resume-from"])
  const checkpoint = await readNeedsCheckCheckpoint(checkpointPath)

  const action = parseNeedsCheckAction(args["needs-check-action"])
  const notes = (args["needs-check-notes"] ?? "").trim()
  if ((action === "revise" || action === "retry-review") && !notes) {
    throw new Error(`--needs-check-notes is required for action: ${action}`)
  }

  const configPath = path.resolve(args.config ?? checkpoint.configPath)
  const config = await loadConfig(configPath, args)
  const configDir = path.dirname(configPath)
  const prompts = await loadPrompts(config, configDir)
  const reviseSkills = await loadReviseSkills(config, configDir)

  const runtime: WorkflowRuntime = {
    args: { ...args },
    baseSha: checkpoint.baseSha,
    config,
    hasGit: checkpoint.hasGit,
    implementerPane: checkpoint.implementerPane,
    needsCheckMode: parseNeedsCheckMode(args),
    prompts,
    reviewerPane: checkpoint.reviewerPane,
    reviseSkills,
  }

  delete runtime.args["resume-from"]
  delete runtime.args["needs-check-action"]
  delete runtime.args["needs-check-notes"]

  console.log(`Resuming from checkpoint: ${checkpointPath}`)
  console.log(`Needs-check action: ${action}`)

  switch (action) {
    case "approve":
      console.log(`Workflow finished: manually approved after needs_check in round ${checkpoint.round}.`)
      return
    case "abort":
      throw new Error(`Workflow aborted after needs_check in round ${checkpoint.round}.`)
    case "revise":
      await sendControllerRevise(runtime, checkpoint.round, notes, checkpoint.reviewOutput)
      await runReviewLoop(runtime, configPath, checkpoint.round + 1, checkpoint.reuseCurrentPane)
      return
    case "retry-review":
      await runReviewLoop(runtime, configPath, checkpoint.round, checkpoint.reuseCurrentPane, {
        controllerReviewNotes: notes,
        lastReviewOutput: checkpoint.reviewOutput,
      })
      return
    default: {
      const _exhaustive: never = action
      throw new Error(`Unknown needs-check action: ${_exhaustive}`)
    }
  }
}

export const runWorkflow = async (args: ParsedArgs) => {
  if (args["resume-from"]) {
    return runWorkflowResume(args)
  }

  const configPath = path.resolve(args.config)
  const config = await loadConfig(configPath, args)
  const configDir = path.dirname(configPath)
  const prompts = await loadPrompts(config, configDir)
  const implementSkills = await loadImplementSkills(config, configDir)
  const reviseSkills = await loadReviseSkills(config, configDir)
  const needsCheckMode = parseNeedsCheckMode(args)
  const reuseCurrentPane = isFlagEnabled(args, "reuse-current-pane")

  const hasGit = await isGitRepo(config.projectDir)
  const baseSha = await getReviewBaselineSha(config.projectDir)
  if (baseSha) {
    console.log(`Review baseline: ${baseSha}`)
  } else if (hasGit) {
    console.log("Review baseline: (no commits yet — will diff from repo start after implement)")
  } else {
    console.log("Review baseline: (not a git repo)")
  }

  if (needsCheckMode === "llm") {
    console.log("Needs-check mode: llm (pause with checkpoint on REVIEW_NEEDS_CHECK)")
  }

  const implementerPane = await startAgent(config.projectDir, config.implementer)
  await waitForAgentReady(implementerPane, agentWaitOptions(config.implementer))

  const reviewerPane = reuseCurrentPane
    ? await getCurrentPane()
    : await startAgent(config.projectDir, config.reviewer)

  if (reuseCurrentPane) {
    console.log(`Reusing current pane as reviewer: ${reviewerPane}`)
  } else {
    await waitForAgentReady(reviewerPane, agentWaitOptions(config.reviewer))
  }

  const runtime: WorkflowRuntime = {
    args,
    baseSha,
    config,
    hasGit,
    implementerPane,
    needsCheckMode,
    prompts,
    reviewerPane,
    reviseSkills,
  }

  await sendTaskAndWait(
    implementerPane,
    render(prompts.implement, {
      implementSkills,
      maxReviewRounds: String(config.maxReviewRounds),
      specPath: config.specPath,
    }),
    agentWaitOptions(config.implementer),
  )

  await runReviewLoop(runtime, configPath, 1, reuseCurrentPane)
}
