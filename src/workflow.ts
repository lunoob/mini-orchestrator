import path from "node:path"
import { readFile } from "node:fs/promises"

import { readNeedsCheckCheckpoint } from "./checkpoint.js"
import { isFlagEnabled } from "./cli.js"
import { loadConfig, loadImplementSkills, loadPrompts } from "./config.js"
import { getHeadShaSafe, getReviewBaselineSha, isGitRepo } from "./git.js"
import { createSession } from "./session.js"
import {
  agentWaitOptions,
  getCurrentPane,
  runAgentUpdate,
  sendTaskAndWait,
  startAgent,
  stopAgent,
  waitForAgentReady,
} from "./herdr.js"
import {
  parseNeedsCheckAction,
  parseNeedsCheckMode,
  resolveNeedsCheckDecision,
  type NeedsCheckMode,
} from "./needs-check.js"
import { generateReviewPackage } from "./review-package.js"
import type { IssueConfig, LoadedPrompts, ParsedArgs, WorkflowConfig } from "./types.js"
import { extractReviewResult, parseImplementStatus, parseReviewVerdict, printSection, render, type ReviewVerdict } from "./utils.js"

type WorkflowRuntime = {
  args: ParsedArgs
  baseSha: string | undefined
  config: WorkflowConfig
  hasGit: boolean
  implementerPane: string
  needsCheckMode: NeedsCheckMode
  prompts: LoadedPrompts
  reviewerPane: string
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
      `（未生成 diff 文件——${reason}。请审查工作区改动与实现记录。）`,
    ].join("\n")
  }

  return ["", `**Diff 文件（先读此文件）：** ${diffFile}`].join("\n")
}

const formatBaselineLabel = (baseSha: string | undefined) =>
  baseSha ?? "(workflow start — no commits yet)"

const prepareReviewContext = async (
  sessionDir: string,
  projectDir: string,
  baseSha: string | undefined,
  round: number,
) => {
  if (!(await isGitRepo(projectDir))) {
    return { baseSha: "N/A", diffFile: undefined, headSha: "N/A" }
  }

  const headSha = await getHeadShaSafe(projectDir)
  const diffFile = await generateReviewPackage(sessionDir, projectDir, baseSha, headSha, round)
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
  specPath: string,
  issueIndex?: number,
  issues?: IssueConfig[],
) => ({
  baseSha: runtime.baseSha,
  cannotVerifySummary: verdict.cannotVerifySummary,
  configPath,
  hasGit: runtime.hasGit,
  implementerPane: runtime.implementerPane,
  maxReviewRounds: runtime.config.maxReviewRounds,
  mode: runtime.config.mode,
  projectDir: runtime.config.projectDir,
  reviewOutput,
  reviewerPane: runtime.reviewerPane,
  reuseCurrentPane,
  round,
  specPath,
  currentIssueIndex: issueIndex,
  issues,
})

const sendControllerRevise = async (
  runtime: WorkflowRuntime,
  round: number,
  controllerNotes: string,
  reviewOutput: string,
) => {
  const output = await sendTaskAndWait(
    runtime.implementerPane,
    render(runtime.prompts.controllerImplementer, {
      controllerNotes,
      reviewOutput: extractReviewResult(reviewOutput),
      round: String(round),
    }),
    agentWaitOptions(runtime.config.implementer),
  )

  const implementStatus = parseImplementStatus(output)
  if (implementStatus === "needs_input") {
    throw new Error(
      `Implementer has questions during controller revise round ${round} — needs human input.`,
    )
  }
  if (implementStatus === "unknown") {
    console.warn(
      `Warning: implementer did not output STATUS: IMPLEMENT_DONE after controller revise round ${round}.`,
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
          specPath,
        })
      : render(runtime.prompts.review, {
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
  sessionDir: string,
  specPath: string,
  issueIndex?: number,
  issues?: IssueConfig[],
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

type PostReviewStatus = "REVIEW_PASS" | "REVIEW_NEEDS_CHECK"

const sendPostReviewCheck = async (
  runtime: WorkflowRuntime,
  round: number,
  reviewStatus: PostReviewStatus,
) => {
  console.log(`Review ${reviewStatus} — sending implementer to verify TypeScript and lint checks.`)

  const output = await sendTaskAndWait(
    runtime.implementerPane,
    render(runtime.prompts.postReviewCheck, {
      reviewStatus,
      round: String(round),
    }),
    agentWaitOptions(runtime.config.implementer),
  )

  const implementStatus = parseImplementStatus(output)
  if (implementStatus === "needs_input") {
    throw new Error(
      `Implementer has questions during post-review check round ${round} — needs human input.`,
    )
  }
  if (implementStatus === "unknown") {
    console.warn(
      `Warning: implementer did not output STATUS: IMPLEMENT_DONE after post-review check round ${round}.`,
    )
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

  const output = await sendTaskAndWait(
    runtime.implementerPane,
    render(runtime.prompts.revise, {
      reviewOutput: extractReviewResult(reviewOutput),
      round: String(round),
    }),
    agentWaitOptions(runtime.config.implementer),
  )

  const implementStatus = parseImplementStatus(output)
  if (implementStatus === "needs_input") {
    throw new Error(
      `Implementer has questions during revise round ${round} — needs human input.`,
    )
  }
  if (implementStatus === "unknown") {
    console.warn(
      `Warning: implementer did not output STATUS: IMPLEMENT_DONE after revise round ${round}.`,
    )
  }
}

const runReviewLoop = async (
  runtime: WorkflowRuntime,
  configPath: string,
  startRound: number,
  reuseCurrentPane: boolean,
  sessionDir: string,
  specPath: string,
  initialOptions?: ReviewLoopOptions,
  issueIndex?: number,
  issues?: IssueConfig[],
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
        console.log(`\nWorkflow finished: review passed in round ${round}.`)
        if (verdict.specCompliant !== null || verdict.qualityApproved !== null) {
          console.log(
            `Verdict: spec=${verdict.specCompliant ? "✅" : "—"}, quality=${verdict.qualityApproved ? "Approved" : "—"}`,
          )
        }
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
        throw new Error(`Review failed after ${runtime.config.maxReviewRounds} rounds.`)
      }

      await sendReviseAfterFail(runtime, round, reviewOutput, verdict)
      break
    }
  }

  throw new Error(`Review failed after ${runtime.config.maxReviewRounds} rounds.`)
}

/**
 * 对单个 spec 执行完整的实现 + review 循环。
 * spec 模式与 issue 模式的每个 issue 都复用此函数。
 */
const runSingleSpecCycle = async (
  runtime: WorkflowRuntime,
  configPath: string,
  specPath: string,
  sessionDir: string,
  implementSkills: string,
  startRound?: number,
  controllerReviewNotes?: string,
  lastReviewOutput?: string,
  issueIndex?: number,
  issues?: IssueConfig[],
) => {
  const round = startRound ?? 1
  const initialOptions: ReviewLoopOptions | undefined =
    controllerReviewNotes && lastReviewOutput ? { controllerReviewNotes, lastReviewOutput } : undefined

  const specContent = await readFile(specPath, "utf8")
  const configContent = await readFile(configPath, "utf8")
  const { sessionDir: specSessionDir } = await createSession(
    runtime.config.projectDir, configPath, configContent, specPath, specContent, runtime.args,
  )

  console.log(`Session: ${specSessionDir}`)

  const implementOutput = await sendTaskAndWait(
    runtime.implementerPane,
    render(runtime.prompts.implement, {
      implementSkills,
      maxReviewRounds: String(runtime.config.maxReviewRounds),
      specPath,
    }),
    agentWaitOptions(runtime.config.implementer),
  )

  const implementStatus = parseImplementStatus(implementOutput)
  if (implementStatus === "needs_input") {
    printSection("Implementer Needs Input", implementOutput)
    throw new Error("Implementer has questions — needs human input before review.")
  }
  if (implementStatus === "unknown") {
    console.warn(
      "Warning: implementer did not output STATUS: IMPLEMENT_DONE. " +
        "The implementation may be incomplete. Proceeding to review anyway.",
    )
  }

  await runReviewLoop(runtime, configPath, round, false, specSessionDir, specPath, initialOptions, issueIndex, issues)
}

/**
 * issue 模式：按数组顺序串行执行每个 issue。
 * 任一 issue 失败时停止。
 */
const runIssueQueue = async (
  runtime: WorkflowRuntime,
  configPath: string,
  implementSkills: string,
) => {
  // 统一在循环前执行一次 update（若有配置），避免每次循环重复更新
  await runAgentUpdate(runtime.config.projectDir, runtime.config.implementer)
  await runAgentUpdate(runtime.config.projectDir, runtime.config.reviewer)

  await runIssueQueueFromIndex(runtime, configPath, 0, runtime.config.issues!, implementSkills)
}

const runWorkflowResume = async (args: ParsedArgs) => {
  const checkpointPath = path.resolve(args["resume-from"])
  const sessionDir = path.dirname(checkpointPath)
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
  const implementSkills = await loadImplementSkills(config, configDir)

  const runtime: WorkflowRuntime = {
    args: { ...args },
    baseSha: checkpoint.baseSha,
    config,
    hasGit: checkpoint.hasGit,
    implementerPane: checkpoint.implementerPane,
    needsCheckMode: parseNeedsCheckMode(args),
    prompts,
    reviewerPane: checkpoint.reviewerPane,
  }

  delete runtime.args["resume-from"]
  delete runtime.args["needs-check-action"]
  delete runtime.args["needs-check-notes"]

  console.log(`Resuming from checkpoint: ${checkpointPath}`)
  console.log(`Needs-check action: ${action}`)

  // issue 模式 resume
  if (checkpoint.mode === "issue" && checkpoint.issues) {
    const currentIndex = checkpoint.currentIssueIndex ?? 0
    const currentIssue = checkpoint.issues[currentIndex]

    if (!currentIssue) {
      throw new Error(`Invalid checkpoint: issue index ${currentIndex} out of range`)
    }

    switch (action) {
      case "approve":
        console.log(`Issue approved: ${currentIssue.title}`)
        // 若还有后续 issue，继续执行
        if (currentIndex + 1 < checkpoint.issues.length) {
          // 推进 baseline 到 HEAD：当前 issue 已完成，后续 issue 不应包含其变更
          await advanceBaseline(runtime)
          await runIssueQueueFromIndex(runtime, configPath, currentIndex + 1, checkpoint.issues)
          return
        }
        // 最后一个 issue，清理 agent
        await stopAgent(runtime.implementerPane)
        await stopAgent(runtime.reviewerPane)
        console.log("\nWorkflow finished: all issues manually approved.")
        return
      case "abort":
        throw new Error(`Workflow aborted after needs_check in round ${checkpoint.round}.`)
      case "revise":
        await sendControllerRevise(runtime, checkpoint.round, notes, checkpoint.reviewOutput)
        // 仅继续 review 循环，不重新发送 implement prompt
        await runReviewLoop(runtime, configPath, checkpoint.round + 1, checkpoint.reuseCurrentPane, sessionDir, currentIssue.specPath, undefined, currentIndex, checkpoint.issues)
        // 当前 issue review 通过，若还有后续 issue 则继续
        if (currentIndex + 1 < checkpoint.issues.length) {
          // 推进 baseline：当前 issue 的变更已通过 review
          await advanceBaseline(runtime)
          await runIssueQueueFromIndex(runtime, configPath, currentIndex + 1, checkpoint.issues)
          return
        }
        // 最后一个 issue，清理 agent
        await stopAgent(runtime.implementerPane)
        await stopAgent(runtime.reviewerPane)
        return
      case "retry-review":
        // 仅继续 review 循环（同轮带补充上下文），不重新发送 implement prompt
        await runReviewLoop(runtime, configPath, checkpoint.round, checkpoint.reuseCurrentPane, sessionDir, currentIssue.specPath, { controllerReviewNotes: notes, lastReviewOutput: checkpoint.reviewOutput }, currentIndex, checkpoint.issues)
        // 当前 issue review 通过，若还有后续 issue 则继续
        if (currentIndex + 1 < checkpoint.issues.length) {
          // 推进 baseline：当前 issue 的变更已通过 review
          await advanceBaseline(runtime)
          await runIssueQueueFromIndex(runtime, configPath, currentIndex + 1, checkpoint.issues)
          return
        }
        // 最后一个 issue，清理 agent
        await stopAgent(runtime.implementerPane)
        await stopAgent(runtime.reviewerPane)
        return
      default: {
        const _exhaustive: never = action
        throw new Error(`Unknown needs-check action: ${_exhaustive}`)
      }
    }
  }

  // 原有 spec 模式 resume
  switch (action) {
    case "approve":
      console.log(`Workflow finished: manually approved after needs_check in round ${checkpoint.round}.`)
      return
    case "abort":
      throw new Error(`Workflow aborted after needs_check in round ${checkpoint.round}.`)
    case "revise":
      await sendControllerRevise(runtime, checkpoint.round, notes, checkpoint.reviewOutput)
      // 仅继续 review 循环，不重新发送 implement prompt
      await runReviewLoop(runtime, configPath, checkpoint.round + 1, checkpoint.reuseCurrentPane, sessionDir, checkpoint.specPath)
      return
    case "retry-review":
      // 仅继续 review 循环（同轮带补充上下文），不重新发送 implement prompt
      await runReviewLoop(runtime, configPath, checkpoint.round, checkpoint.reuseCurrentPane, sessionDir, checkpoint.specPath, { controllerReviewNotes: notes, lastReviewOutput: checkpoint.reviewOutput })
      return
    default: {
      const _exhaustive: never = action
      throw new Error(`Unknown needs-check action: ${_exhaustive}`)
    }
  }
}

/**
 * 从指定 index 开始执行 issue 队列。
 */
const runIssueQueueFromIndex = async (
  runtime: WorkflowRuntime,
  configPath: string,
  startIndex: number,
  issues: IssueConfig[],
  implementSkills?: string,
) => {
  if (!implementSkills) {
    implementSkills = await loadImplementSkills(runtime.config, path.dirname(configPath))
  }

  for (let index = startIndex; index < issues.length; index += 1) {
    const issue = issues[index]
    console.log(`\n=== Issue ${index + 1}/${issues.length}: ${issue.title} ===`)
    console.log(`Spec path: ${issue.specPath}`)

    // 清理上个 issue 残留的 agent（resume 路径会从 checkpoint 带入旧 pane）
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

      await runSingleSpecCycle(runtime, configPath, issue.specPath, "", implementSkills, undefined, undefined, undefined, index, issues)

      // 当前 issue 完成，推进 baseline 到 HEAD，使后续 issue 仅审查自身变更
      await advanceBaseline(runtime)
    } finally {
      // 按逆序关闭 agent
      if (startedReviewer) await stopAgent(runtime.reviewerPane)
      if (startedImplementer) await stopAgent(runtime.implementerPane)
    }
  }
}

const advanceBaseline = async (runtime: WorkflowRuntime) => {
  if (!runtime.hasGit) return
  const headSha = await getHeadShaSafe(runtime.config.projectDir)
  if (headSha) {
    runtime.baseSha = headSha
    console.log(`Review baseline advanced: ${headSha}`)
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

  const mode = config.mode ?? "spec"

  if (mode === "issue") {
    // issue 模式：agent 按 issue 启动/销毁，由 runIssueQueue 管理生命周期
    const runtime: WorkflowRuntime = {
      args,
      baseSha,
      config,
      hasGit,
      implementerPane: "",
      needsCheckMode,
      prompts,
      reviewerPane: "",
    }
    await runIssueQueue(runtime, configPath, implementSkills)
    return
  }

  // spec 模式：在开头启动一次 agent，复用至工作流结束
  await runAgentUpdate(config.projectDir, config.implementer)

  const implementerPane = await startAgent(config.projectDir, config.implementer, {
    ensureUniqueName: true,
  })
  await waitForAgentReady(implementerPane, agentWaitOptions(config.implementer))

  let reviewerPane: string
  if (reuseCurrentPane) {
    reviewerPane = await getCurrentPane()
  } else {
    await runAgentUpdate(config.projectDir, config.reviewer)
    reviewerPane = await startAgent(config.projectDir, config.reviewer, {
      ensureUniqueName: true,
    })
  }

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
  }

  // spec 模式：原有单 spec 工作流
  const specContent = await readFile(config.specPath!, "utf8")
  const configContent = await readFile(configPath, "utf8")
  const { sessionDir } = await createSession(
    config.projectDir, configPath, configContent, config.specPath!, specContent, args,
  )
  console.log(`Session: ${sessionDir}`)

  const implementOutput = await sendTaskAndWait(
    implementerPane,
    render(prompts.implement, {
      implementSkills,
      maxReviewRounds: String(config.maxReviewRounds),
      specPath: config.specPath!,
    }),
    agentWaitOptions(config.implementer),
  )

  const implementStatus = parseImplementStatus(implementOutput)
  if (implementStatus === "needs_input") {
    printSection("Implementer Needs Input", implementOutput)
    throw new Error("Implementer has questions — needs human input before review.")
  }
  if (implementStatus === "unknown") {
    console.warn(
      "Warning: implementer did not output STATUS: IMPLEMENT_DONE. " +
        "The implementation may be incomplete. Proceeding to review anyway.",
    )
  }

  await runReviewLoop(runtime, configPath, 1, reuseCurrentPane, sessionDir, config.specPath!)
}
