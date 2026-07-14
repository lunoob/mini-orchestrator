import { randomUUID } from "node:crypto"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { readNeedsCheckCheckpoint } from "./checkpoint.js"
import { loadConfig, loadImplementSkills, loadPrompts } from "./config.js"
import { getHeadShaSafe, getReviewBaselineSha, isGitRepo } from "./git.js"
import { createSession } from "./session.js"
import {
  agentWaitOptions,
  readAgentOutputWithRetry,
  runAgentUpdate,
  sendTask,
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
import type { IssueConfig, LoadedPrompts, ParsedArgs, TaskFile, TaskRole, WorkflowConfig } from "./types.js"
import { createTask, buildTaskProtocol, waitForTaskCompleted } from "./task-status.js"
import {
  IMPLEMENT_RESULT_END,
  IMPLEMENT_RESULT_START,
  REVIEW_RESULT_END,
  REVIEW_RESULT_START,
} from "./prompt-delimiters.js"
import { extractReviewResult, parseReviewVerdict, printSection, render, stripStatusLines, type ReviewVerdict } from "./utils.js"

/** 编排器主入口的绝对路径，agent 通过它执行 report-task 命令 */
const orchestratorMain = fileURLToPath(new URL("./main.ts", import.meta.url))

/**
 * 生成唯一 runId，使用完整 UUID（128-bit）后缀确保跨进程唯一，
 * resume 等场景下不会意外复用旧 runId。
 */
export const buildRunId = (issueIndex: number, role: TaskRole, round: number, subtype = "") => {
  const suffix = randomUUID()
  const base = `${issueIndex}-${role}-r${round}`
  return subtype ? `${base}-${subtype}-${suffix}` : `${base}-${suffix}`
}

/**
 * 在任务完成后延迟等待 output 同步，然后通过分隔符校验读取最终结果。
 * delayMs 和 readFn 可注入，便于测试。
 */
export const waitForOutputAfterCompletion = async (
  paneId: string,
  role: TaskRole,
  delayMs = 5000,
  readFn: typeof readAgentOutputWithRetry = readAgentOutputWithRetry,
) => {
  await new Promise(resolve => setTimeout(resolve, delayMs))

  // 构建与角色对应的 output 校验器：必须包含结果分隔符且正文非空
  const delimiterStart = role === "implementer" ? IMPLEMENT_RESULT_START : REVIEW_RESULT_START
  const delimiterEnd = role === "implementer" ? IMPLEMENT_RESULT_END : REVIEW_RESULT_END

  const isValidOutput = (output: string) => {
    const startIdx = output.lastIndexOf(delimiterStart)
    if (startIdx === -1) return false
    const afterStart = startIdx + delimiterStart.length
    const endIdx = output.lastIndexOf(delimiterEnd)
    if (endIdx <= afterStart) return false
    return output.slice(afterStart, endIdx).trim().length > 0
  }

  return readFn(paneId, 280, isValidOutput)
}

/**
 * 文件状态驱动的任务发送：创建任务文件、注入协议、发送、等待完成、延迟读取 output。
 * 替代原有的 sendTaskAndWait（依赖 herdr pane 状态轮询）。
 */
const sendTaskWithTaskFile = async (
  paneId: string,
  prompt: string,
  tasksDir: string,
  runId: string,
  role: TaskRole,
) => {
  const { filePath: taskFilePath, runId: actualRunId } = await createTask(tasksDir, runId, role)
  const protocol = buildTaskProtocol(taskFilePath, actualRunId, role, orchestratorMain)
  const fullPrompt = prompt + "\n" + protocol

  await sendTask(paneId, fullPrompt)

  console.log(`[TaskStatus] Waiting for task ${actualRunId} to complete...`)
  const completedTask = await waitForTaskCompleted(taskFilePath)

  console.log(`[TaskStatus] Task ${actualRunId} completed (${completedTask.status}). Waiting 5s for output sync...`)
  const output = await waitForOutputAfterCompletion(paneId, role)

  return { output, task: completedTask }
}

/** 从 task.status 构建 ReviewVerdict，cannotVerifySummary 仍从 output 提取 */
export const mapTaskToReviewVerdict = (task: TaskFile, output: string): ReviewVerdict => {
  const parsed = parseReviewVerdict(extractReviewResult(output))
  const kind = task.status === "REVIEW_FAIL" ? "fail" as const
    : task.status === "REVIEW_NEEDS_CHECK" ? "needs_check" as const
    : "pass" as const

  return {
    cannotVerifySummary: parsed.cannotVerifySummary,
    hasCannotVerify: parsed.hasCannotVerify,
    kind,
    passed: kind === "pass",
  }
}

type WorkflowRuntime = {
  args: ParsedArgs
  baseSha: string | undefined
  config: WorkflowConfig
  hasGit: boolean
  implementerPane: string
  issueIndex: number
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
  issueIndex: number,
  issues: IssueConfig[],
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
  currentIssueIndex: issueIndex,
  issues,
})

const sendControllerRevise = async (
  runtime: WorkflowRuntime,
  round: number,
  controllerNotes: string,
  reviewOutput: string,
  tasksDir: string,
) => {
  const runId = buildRunId(runtime.issueIndex, "implementer", round, "controller")
  const { output, task } = await sendTaskWithTaskFile(
    runtime.implementerPane,
    render(runtime.prompts.controllerImplementer, {
      controllerNotes,
      reviewOutput: stripStatusLines(extractReviewResult(reviewOutput)),
      round: String(round),
    }),
    tasksDir,
    runId,
    "implementer",
  )

  if (task.status === "IMPLEMENT_ASK") {
    throw new Error(
      `[Controller] Implementer has questions during controller revise round ${round} — needs human input.`,
    )
  }
  if (task.status !== "IMPLEMENT_DONE") {
    console.warn(
      `[Controller] Warning: implementer status is ${task.status ?? "missing"} after controller revise round ${round}.`,
    )
  }
}

const conductReview = async (
  runtime: WorkflowRuntime,
  round: number,
  sessionDir: string,
  specPath: string,
  tasksDir: string,
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

  const runId = buildRunId(runtime.issueIndex, "reviewer", round)
  const { output: reviewOutput, task } = await sendTaskWithTaskFile(
    runtime.reviewerPane,
    prompt,
    tasksDir,
    runId,
    "reviewer",
  )
  printSection(`Review Round ${round}`, reviewOutput)

  return { reviewOutput, verdict: mapTaskToReviewVerdict(task, reviewOutput) }
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
  issueIndex: number,
  issues: IssueConfig[],
  tasksDir: string,
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
      await sendControllerRevise(runtime, round, decision.notes, reviewOutput, tasksDir)
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

type PostReviewStatus = "REVIEW_PASS" | "REVIEW_NEEDS_CHECK"

const sendPostReviewCheck = async (
  runtime: WorkflowRuntime,
  round: number,
  reviewStatus: PostReviewStatus,
  tasksDir: string,
) => {
  console.log(`[PostCheck] Review ${reviewStatus} — sending implementer to verify TypeScript and lint checks.`)

  const runId = buildRunId(runtime.issueIndex, "implementer", round, "postcheck")
  const { task } = await sendTaskWithTaskFile(
    runtime.implementerPane,
    render(runtime.prompts.postReviewCheck, {
      reviewStatus,
      round: String(round),
    }),
    tasksDir,
    runId,
    "implementer",
  )

  if (task.status === "IMPLEMENT_ASK") {
    throw new Error(
      `[PostCheck] Implementer has questions during post-review check round ${round} — needs human input.`,
    )
  }
  if (task.status !== "IMPLEMENT_DONE") {
    console.warn(
      `[PostCheck] Warning: implementer status is ${task.status ?? "missing"} after post-review check round ${round}.`,
    )
  }
}

const sendReviseAfterFail = async (
  runtime: WorkflowRuntime,
  round: number,
  reviewOutput: string,
  tasksDir: string,
) => {
  console.log("[Revise] Review failed — sending back to implementer.")

  const runId = buildRunId(runtime.issueIndex, "implementer", round, "revise")
  const { task } = await sendTaskWithTaskFile(
    runtime.implementerPane,
    render(runtime.prompts.revise, {
      reviewOutput: stripStatusLines(extractReviewResult(reviewOutput)),
      round: String(round),
    }),
    tasksDir,
    runId,
    "implementer",
  )

  if (task.status === "IMPLEMENT_ASK") {
    throw new Error(
      `[Revise] Implementer has questions during revise round ${round} — needs human input.`,
    )
  }
  if (task.status !== "IMPLEMENT_DONE") {
    console.warn(
      `[Revise] Warning: implementer status is ${task.status ?? "missing"} after revise round ${round}.`,
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
  issueIndex: number,
  issues: IssueConfig[],
  tasksDir: string,
  initialOptions?: ReviewLoopOptions,
) => {
  for (let round = startRound; round <= runtime.config.maxReviewRounds; round += 1) {
    let activeLoopOptions: ReviewLoopOptions | undefined = round === startRound ? initialOptions : undefined
    let retrySameRound = true

    while (retrySameRound) {
      retrySameRound = false

      const { reviewOutput, verdict } = await conductReview(runtime, round, sessionDir, specPath, tasksDir, activeLoopOptions ?? {})
      activeLoopOptions = undefined

      if (verdict.kind === "pass") {
        await sendPostReviewCheck(runtime, round, "REVIEW_PASS", tasksDir)
        console.log(`\n[Review] Workflow finished: review passed in round ${round}.`)
        return
      }

      if (verdict.kind === "needs_check") {
        await sendPostReviewCheck(runtime, round, "REVIEW_NEEDS_CHECK", tasksDir)
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
          tasksDir,
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

      await sendReviseAfterFail(runtime, round, reviewOutput, tasksDir)
      break
    }
  }

  throw new Error(`[Review] Review failed after ${runtime.config.maxReviewRounds} rounds.`)
}

/**
 * 对单个 issue 执行完整的实现 + review 循环。
 */
const runSingleSpecCycle = async (
  runtime: WorkflowRuntime,
  configPath: string,
  specPath: string,
  sessionDir: string,
  implementSkills: string,
  issueIndex: number,
  issues: IssueConfig[],
  startRound?: number,
  controllerReviewNotes?: string,
  lastReviewOutput?: string,
) => {
  const round = startRound ?? 1
  const initialOptions: ReviewLoopOptions | undefined =
    controllerReviewNotes && lastReviewOutput ? { controllerReviewNotes, lastReviewOutput } : undefined

  const specContent = await readFile(specPath, "utf8")
  const configContent = await readFile(configPath, "utf8")
  const { sessionDir: specSessionDir } = await createSession(
    runtime.config.projectDir, configPath, configContent, specPath, specContent, runtime.args,
  )

  console.log(`[Session] Session: ${specSessionDir}`)

  const tasksDir = path.join(specSessionDir, "tasks")

  const runId = buildRunId(issueIndex, "implementer", round)
  const { output: implementOutput, task: implementTask } = await sendTaskWithTaskFile(
    runtime.implementerPane,
    render(runtime.prompts.implement, {
      implementSkills,
      maxReviewRounds: String(runtime.config.maxReviewRounds),
      specPath,
    }),
    tasksDir,
    runId,
    "implementer",
  )

  if (implementTask.status === "IMPLEMENT_ASK") {
    printSection("Implementer Needs Input", implementOutput)
    throw new Error("[Implement] Implementer has questions — needs human input before review.")
  }
  if (implementTask.status !== "IMPLEMENT_DONE") {
    console.warn(
      "[Implement] Warning: implementer status is " +
        `${implementTask.status ?? "missing"}. ` +
        "The implementation may be incomplete. Proceeding to review anyway.",
    )
  }

  await runReviewLoop(runtime, configPath, round, false, specSessionDir, specPath, issueIndex, issues, tasksDir, initialOptions)
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

  await runIssueQueueFromIndex(runtime, configPath, 0, runtime.config.issues, implementSkills)
}

const runWorkflowResume = async (args: ParsedArgs) => {
  const checkpointPath = path.resolve(args["resume-from"])
  const sessionDir = path.dirname(checkpointPath)
  const checkpoint = await readNeedsCheckCheckpoint(checkpointPath)

  const action = parseNeedsCheckAction(args["needs-check-action"])
  const notes = (args["needs-check-notes"] ?? "").trim()
  if ((action === "revise" || action === "retry-review") && !notes) {
    throw new Error(`[Resume] --needs-check-notes is required for action: ${action}`)
  }

  const configPath = path.resolve(args.config ?? checkpoint.configPath)
  const config = await loadConfig(configPath, args)
  const configDir = path.dirname(configPath)
  const prompts = await loadPrompts(config, configDir)
  const implementSkills = await loadImplementSkills(config, configDir)

  const currentIndex = checkpoint.currentIssueIndex

  const runtime: WorkflowRuntime = {
    args: { ...args },
    baseSha: checkpoint.baseSha,
    config,
    hasGit: checkpoint.hasGit,
    implementerPane: checkpoint.implementerPane,
    issueIndex: currentIndex,
    needsCheckMode: parseNeedsCheckMode(args),
    prompts,
    reviewerPane: checkpoint.reviewerPane,
  }

  delete runtime.args["resume-from"]
  delete runtime.args["needs-check-action"]
  delete runtime.args["needs-check-notes"]

  console.log(`[Resume] Resuming from checkpoint: ${checkpointPath}`)
  console.log(`[Resume] Needs-check action: ${action}`)

  const currentIssue = checkpoint.issues[currentIndex]

  if (!currentIssue) {
    throw new Error(`[Resume] Invalid checkpoint: issue index ${currentIndex} out of range`)
  }

  // 从 checkpoint 的 session 目录派生 tasksDir
  const tasksDir = path.join(sessionDir, "tasks")

  switch (action) {
    case "approve":
      console.log(`[Issue] Issue approved: ${currentIssue.title}`)
      // 若还有后续 issue，继续执行
      if (currentIndex + 1 < checkpoint.issues.length) {
        await advanceBaseline(runtime)
        await runIssueQueueFromIndex(runtime, configPath, currentIndex + 1, checkpoint.issues)
        return
      }
      // 最后一个 issue，清理 agent
      await stopAgent(runtime.implementerPane)
      await stopAgent(runtime.reviewerPane)
      console.log("\n[Issue] Workflow finished: all issues manually approved.")
      return
    case "abort":
      throw new Error(`[Resume] Workflow aborted after needs_check in round ${checkpoint.round}.`)
    case "revise":
      await sendControllerRevise(runtime, checkpoint.round, notes, checkpoint.reviewOutput, tasksDir)
      await runReviewLoop(runtime, configPath, checkpoint.round + 1, checkpoint.reuseCurrentPane, sessionDir, currentIssue.specPath, currentIndex, checkpoint.issues, tasksDir)
      // 当前 issue review 通过，若还有后续 issue 则继续
      if (currentIndex + 1 < checkpoint.issues.length) {
        await advanceBaseline(runtime)
        await runIssueQueueFromIndex(runtime, configPath, currentIndex + 1, checkpoint.issues)
        return
      }
      // 最后一个 issue，清理 agent
      await stopAgent(runtime.implementerPane)
      await stopAgent(runtime.reviewerPane)
      return
    case "retry-review":
      await runReviewLoop(runtime, configPath, checkpoint.round, checkpoint.reuseCurrentPane, sessionDir, currentIssue.specPath, currentIndex, checkpoint.issues, tasksDir, { controllerReviewNotes: notes, lastReviewOutput: checkpoint.reviewOutput })
      // 当前 issue review 通过，若还有后续 issue 则继续
      if (currentIndex + 1 < checkpoint.issues.length) {
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
      throw new Error(`[Resume] Unknown needs-check action: ${_exhaustive}`)
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
    console.log(`\n[Issue] === Issue ${index + 1}/${issues.length}: ${issue.title} ===`)
    console.log(`[Issue] Spec path: ${issue.specPath}`)

    // 更新当前 issue 索引，供 buildRunId 使用
    runtime.issueIndex = index

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

      await runSingleSpecCycle(runtime, configPath, issue.specPath, "", implementSkills, index, issues)

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
    console.log(`[Baseline] Review baseline advanced: ${headSha}`)
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

  const hasGit = await isGitRepo(config.projectDir)
  const baseSha = await getReviewBaselineSha(config.projectDir)
  if (baseSha) {
    console.log(`[Workflow] Review baseline: ${baseSha}`)
  } else if (hasGit) {
    console.log("[Workflow] Review baseline: (no commits yet — will diff from repo start after implement)")
  } else {
    console.log("[Workflow] Review baseline: (not a git repo)")
  }

  if (needsCheckMode === "llm") {
    console.log("[Workflow] Needs-check mode: llm (pause with checkpoint on REVIEW_NEEDS_CHECK)")
  }

  const runtime: WorkflowRuntime = {
    args,
    baseSha,
    config,
    hasGit,
    implementerPane: "",
    issueIndex: 0,
    needsCheckMode,
    prompts,
    reviewerPane: "",
  }

  await runIssueQueue(runtime, configPath, implementSkills)
}
