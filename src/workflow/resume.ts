import path from "node:path"

import { readNeedsCheckCheckpoint } from "../review/checkpoint.js"
import { loadConfig, loadPrompts } from "../config/load.js"
import { parseNeedsCheckAction, parseNeedsCheckMode } from "../review/needs-check.js"
import { bootstrapSession, startAgentResumed, stopAgent } from "../agent/index.js"
import type { ParsedArgs } from "../types.js"
import { createWorkflowEventBus } from "./events.js"
import { sendControllerRevise, runReviewLoop } from "./review-loop.js"
import { advanceBaseline } from "./review-context.js"
import { runIssueQueueFromIndex } from "./issues.js"
import { markIssueFinished, markIssueInReview } from "../config/persist.js"
import type { WorkflowRuntime } from "./types.js"
import { buildCheckpointInput } from "./types.js"

export const runWorkflowResume = async (args: ParsedArgs, options?: import("./index.js").WorkflowOptions) => {
  const checkpointPath = path.resolve(args["resume-from"])
  const sessionDir = path.dirname(checkpointPath)
  const checkpoint = await readNeedsCheckCheckpoint(checkpointPath)

  const action = parseNeedsCheckAction(args["needs-check-action"])
  const notes = (args["needs-check-notes"] ?? "").trim()
  // intervention 恢复时 notes 为必填（abort 除外）；常规 needs-check 的 revise/retry-review 也需要 notes
  const isIntervention = !!(checkpoint as any).interventionRole && !!(checkpoint as any).interventionType
  if (action !== "abort" && !notes) {
    if (isIntervention || action === "revise" || action === "retry-review") {
      throw new Error(`[Resume] --needs-check-notes is required for action: ${action}`)
    }
  }

  const configPath = path.resolve(args.config ?? checkpoint.configPath)
  const config = await loadConfig(configPath, args)
  const configDir = path.dirname(configPath)
  const prompts = await loadPrompts(config, configDir)

  const currentIndex = checkpoint.currentIssueIndex

  const eventBus = options?.eventBus ?? createWorkflowEventBus()
  // 从 checkpoint 初始化 issue 快照
  const initIssue = checkpoint.issues[checkpoint.currentIssueIndex]
  if (initIssue) {
    eventBus.publish({ type: "issue_change", issueIndex: checkpoint.currentIssueIndex, issueCount: checkpoint.issues.length, issueTitle: initIssue.title })
  }

  const runtime: WorkflowRuntime = {
    args: { ...args },
    baseSha: checkpoint.baseSha,
    config,
    configPath,
    eventBus,
    hasGit: checkpoint.hasGit,
    implementerPane: "",
    issueIndex: checkpoint.currentIssueIndex,
    needsCheckMode: parseNeedsCheckMode(args),
    prompts,
    reviewerPane: "",
    implementerSession: checkpoint.implementerSession,
    reviewerSession: checkpoint.reviewerSession,
  }

  delete runtime.args["resume-from"]
  delete runtime.args["needs-check-action"]
  delete runtime.args["needs-check-notes"]

  console.log(`[Resume] Resuming from checkpoint: ${checkpointPath}`)
  console.log(`[Resume] Needs-check action: ${action}`)

  // 通知 UI 工作流实际开始时间
  runtime.eventBus.publish({ type: "workflow_started", startedAt: Date.now() })

  // P1-5: abort 优先处理
  if (action === "abort" && checkpoint.interventionRole) {
    throw new Error(`[Resume] Intervention aborted for ${checkpoint.interventionRole} (${checkpoint.interventionType})`)
  }

  // P1-2: intervention checkpoint 单独处理
  if (checkpoint.interventionRole && checkpoint.interventionType) {
    const session = checkpoint.interventionRole === "implementer"
      ? checkpoint.implementerSession : checkpoint.reviewerSession
    if (!session?.resumeId) {
      throw new Error(`[Resume] Intervention checkpoint missing ${checkpoint.interventionRole} session handle`)
    }

    const agentConfig = checkpoint.interventionRole === "implementer"
      ? runtime.config.implementer : runtime.config.reviewer

    const createdPaneIds: string[] = []
    let paneId = ""
    try {
      paneId = await startAgentResumed(
        runtime.config.projectDir, agentConfig, session.resumeId, { ensureUniqueName: true },
      )
      createdPaneIds.push(paneId)

      // intervention 仅支持携带必填回答继续（abort 已在上方处理）
      const { sendTask, waitForAgentWithMonitor } = await import("../agent/index.js")

      // P1-3: 统一使用结构化 user_response 恢复
      const requestConfig = checkpoint.interventionRequestConfig
      const structuredResponse: Record<string, unknown> = { type: "user_response" }
      if (requestConfig) {
        // 尝试从 notes 匹配预设选项的 optionId
        const matchedOption = requestConfig.options?.find(
          (o) => o.id === notes || o.label === notes
        )
        if (matchedOption) {
          structuredResponse.optionId = matchedOption.id
        } else if (notes) {
          structuredResponse.text = notes
        }
      } else if (notes) {
        structuredResponse.text = notes
      }
      const userMessage = JSON.stringify(structuredResponse)
      const combinedPrompt = `${userMessage}\n\nBased on the response above, continue with the previous task. Output the outcome as a JSON object with the required schema.`
      await sendTask(paneId, combinedPrompt)

      console.log(`[Resume] Intervention: sent reply to ${checkpoint.interventionRole} pane ${paneId}. Waiting...`)

      const result = await waitForAgentWithMonitor(session)
      session.offset = result.finalOffset
      console.log(`[Resume] Intervention agent completed: status=${result.status}`)

      if (checkpoint.interventionRole === "implementer") {
        runtime.implementerPane = paneId; runtime.implementerSession = session
      } else {
        runtime.reviewerPane = paneId; runtime.reviewerSession = session
      }

      const { isProtocolError, parseOutcome } = await import("../lib/outcome-parser.js")
      const parseResult = parseOutcome(result.finalText, checkpoint.interventionRole!)

      // helper: write re-checkpoint and throw
      const recheckpoint = async (type: string, question?: string, requestConfig?: import("../lib/outcome-parser.js").RequestConfig) => {
        const { writeNeedsCheckCheckpoint } = await import("../review/checkpoint.js")
        const rePath = await writeNeedsCheckCheckpoint(path.dirname(checkpointPath), {
          baseSha: checkpoint.baseSha, cannotVerifySummary: result.finalText.slice(0, 500),
          configPath: checkpoint.configPath, hasGit: checkpoint.hasGit,
          implementerPane: runtime.implementerPane, implementerSession: runtime.implementerSession,
          maxReviewRounds: checkpoint.maxReviewRounds, projectDir: checkpoint.projectDir,
          reviewOutput: result.finalText, reviewerPane: runtime.reviewerPane,
          reviewerSession: runtime.reviewerSession,
          reuseCurrentPane: checkpoint.reuseCurrentPane, round: checkpoint.round,
          currentIssueIndex: checkpoint.currentIssueIndex, issues: checkpoint.issues,
          interventionType: type, interventionRole: checkpoint.interventionRole,
          interventionQuestion: question, interventionRequestConfig: requestConfig,
          interventionPhase: checkpoint.interventionPhase,
          reviewStatus: checkpoint.reviewStatus,
          interventionReviewOutput: checkpoint.interventionReviewOutput,
        })
        const reason = question ?? (type === "invalid_output" ? "输出缺少合法 outcome" : "需要人工确认")
        const notificationContext = {
          role: checkpoint.interventionRole!,
          provider: session!.provider,
          paneId,
          reason,
          turnId: String(session!.offset),
          interventionType: type as "needs_input" | "invalid_output",
          checkpointPath: rePath,
        }
        console.log(`[Resume] Re-checkpoint: ${rePath}\nSTATUS: ORCHESTRATOR_NEEDS_CHECK\nCHECKPOINT: ${rePath}`)
        const { NeedsCheckPauseError } = await import("../review/needs-check.js")
        throw new NeedsCheckPauseError(rePath, notificationContext)
      }

      // monitor-level or outcome-level failed → 终止恢复流程
      if (result.status === "failed" || (!isProtocolError(parseResult) && parseResult.outcome === "failed")) {
        const failReason = !isProtocolError(parseResult) && parseResult.outcome === "failed"
          ? parseResult.failure.message : (result.lastEvent?.reason ?? result.lastEvent?.question ?? "Agent failed")
        runtime.eventBus.publish({ type: "fail", reason: `Resume: ${checkpoint.interventionRole} failed — ${failReason}` })
        throw new Error(`[Resume] ${checkpoint.interventionRole} failed during intervention recovery: ${failReason}`)
      }

      // monitor-level needs_input → re-checkpoint（尝试从 finalText 提取结构化选项）
      // P2: 使用当前实际状态，而非旧的 checkpoint.interventionType
      if (result.status === "needs_input") {
        const monitorReqConfig = !isProtocolError(parseResult) && parseResult.outcome === "needs_input"
          ? parseResult.request : undefined
        await recheckpoint("needs_input", result.lastEvent?.question ?? monitorReqConfig?.question, monitorReqConfig)
      }

      // P1-3: needs_input → recheckpoint（包括 reviewer，保留结构化选项上下文）
      if (isProtocolError(parseResult) ||
          (!isProtocolError(parseResult) && parseResult.outcome === "needs_input")) {
        const requestConfig = !isProtocolError(parseResult) && parseResult.outcome === "needs_input"
          ? parseResult.request : undefined
        const question = requestConfig?.question
        await recheckpoint(!isProtocolError(parseResult) && parseResult.outcome === "needs_input" ? "needs_input" : "invalid_output", question, requestConfig)
      }

      // --- phase dispatch ---
      const phase = checkpoint.interventionPhase || "review"
      const ci = checkpoint.issues[checkpoint.currentIssueIndex]
      if (!ci || checkpoint.currentIssueIndex >= checkpoint.issues.length) return

      console.log(`[Resume] Intervention resolved (phase: ${phase}).`)

      const ensureImplPane = async () => {
        if (!runtime.implementerPane && runtime.implementerSession?.resumeId) {
          runtime.implementerPane = await startAgentResumed(
            runtime.config.projectDir, runtime.config.implementer,
            runtime.implementerSession.resumeId, { ensureUniqueName: true },
          )
          createdPaneIds.push(runtime.implementerPane)
          console.log(`[Resume] Created implementer pane: ${runtime.implementerPane}`)
        }
      }

      if (phase === "review") {
        const reviewCompleted = !isProtocolError(parseResult) && parseResult.outcome === "completed" && "review" in parseResult && (parseResult as any).review !== undefined
        if (reviewCompleted) {
          const verdict = (parseResult as any).review!.verdict as string
          if (verdict === "pass") {
            console.log(`[Resume] Review PASS — running post-review check.`)
            await ensureImplPane()
            const { sendPostReviewCheck } = await import("./review-loop.js")
            await sendPostReviewCheck(runtime, checkpoint.round, "REVIEW_PASS", result.finalText)
            await markIssueFinished(configPath, checkpoint.currentIssueIndex, checkpoint.issues)
          } else if (verdict === "needs_check") {
            // needs_check → 复用人工核查流程
            await ensureImplPane()
            const { sendPostReviewCheck } = await import("./review-loop.js")
            await sendPostReviewCheck(runtime, checkpoint.round, "REVIEW_NEEDS_CHECK", result.finalText)

            const reviewerSession = runtime.reviewerSession ?? checkpoint.reviewerSession
            const notificationContext = reviewerSession
              ? { role: "reviewer", provider: reviewerSession.provider, paneId: runtime.reviewerPane, reason: "Review 需要人工核查", turnId: String(reviewerSession.offset), interventionType: "needs_input" as const }
              : undefined

            const { resolveNeedsCheckDecision } = await import("../review/needs-check.js")
            const decision = await resolveNeedsCheckDecision(
              runtime.args, runtime.needsCheckMode, checkpoint.round,
              { kind: "needs_check", passed: false, cannotVerifySummary: null, hasCannotVerify: false },
              result.finalText,
              buildCheckpointInput(runtime, configPath, checkpoint.round, result.finalText,
                { cannotVerifySummary: null, hasCannotVerify: false, kind: "needs_check", passed: false },
                false, ci.specPath, checkpoint.currentIssueIndex, checkpoint.issues),
              sessionDir, notificationContext, runtime.eventBus,
            )
            if (decision.action === "approve") await markIssueFinished(configPath, checkpoint.currentIssueIndex, checkpoint.issues)
            else if (decision.action === "abort") throw new Error(`[Resume] Workflow aborted after REVIEW_NEEDS_CHECK`)
            else if (decision.action === "revise") {
              await ensureImplPane()
              const { sendControllerRevise } = await import("./review-loop.js")
              await sendControllerRevise(runtime, checkpoint.round, decision.notes, result.finalText)
              await runReviewLoop(runtime, configPath, checkpoint.round + 1, checkpoint.reuseCurrentPane, sessionDir, ci.specPath, checkpoint.currentIssueIndex, checkpoint.issues)
              await markIssueFinished(configPath, checkpoint.currentIssueIndex, checkpoint.issues)
            } else {
              await runReviewLoop(runtime, configPath, checkpoint.round, checkpoint.reuseCurrentPane, sessionDir, ci.specPath, checkpoint.currentIssueIndex, checkpoint.issues,
                { controllerReviewNotes: decision.notes, lastReviewOutput: result.finalText })
              await markIssueFinished(configPath, checkpoint.currentIssueIndex, checkpoint.issues)
            }
          } else {
            // fail
            if (checkpoint.round >= checkpoint.maxReviewRounds) {
              throw new Error(`[Resume] Review failed after ${checkpoint.maxReviewRounds} rounds.`)
            }
            console.log(`[Resume] Review FAIL — sending revise to implementer.`)
            await ensureImplPane()
            const { sendReviseAfterFail } = await import("./review-loop.js")
            await sendReviseAfterFail(runtime, checkpoint.round, result.finalText)
            await runReviewLoop(runtime, configPath, checkpoint.round + 1, checkpoint.reuseCurrentPane,
              sessionDir, ci.specPath, checkpoint.currentIssueIndex, checkpoint.issues)
            await markIssueFinished(configPath, checkpoint.currentIssueIndex, checkpoint.issues)
          }
        } else if (!isProtocolError(parseResult) && parseResult.outcome === "needs_input") {
          // P3: 同正常流程 — 先 post-check，再 needs-check 决策
          await ensureImplPane()
          const { sendPostReviewCheck } = await import("./review-loop.js")
          await sendPostReviewCheck(runtime, checkpoint.round, "REVIEW_NEEDS_CHECK", result.finalText)

          // 构建通知上下文（与正常 review 流程共用逻辑）
          const reviewerSession = runtime.reviewerSession ?? checkpoint.reviewerSession
          const notificationContext = reviewerSession
            ? {
                role: "reviewer",
                provider: reviewerSession.provider,
                paneId: runtime.reviewerPane,
                reason: "Review 需要人工核查",
                turnId: String(reviewerSession.offset),
                interventionType: "needs_input" as const,
              }
            : undefined

          const { resolveNeedsCheckDecision } = await import("../review/needs-check.js")
          const decision = await resolveNeedsCheckDecision(
            runtime.args, runtime.needsCheckMode, checkpoint.round,
            { kind: "needs_check", passed: false, cannotVerifySummary: null, hasCannotVerify: false },
            result.finalText,
            buildCheckpointInput(runtime, configPath, checkpoint.round, result.finalText,
              { cannotVerifySummary: null, hasCannotVerify: false, kind: "needs_check", passed: false },
              false, ci.specPath, checkpoint.currentIssueIndex, checkpoint.issues),
            sessionDir,
            notificationContext,
            runtime.eventBus,
          )
          console.log(`[Resume] REVIEW_NEEDS_CHECK → decision: ${decision.action}`)

          if (decision.action === "abort") {
            throw new Error(`[Resume] Workflow aborted after REVIEW_NEEDS_CHECK`)
          }
          if (decision.action === "approve") {
            await markIssueFinished(configPath, checkpoint.currentIssueIndex, checkpoint.issues)
          } else if (decision.action === "revise") {
            await ensureImplPane()
            const { sendControllerRevise } = await import("./review-loop.js")
            await sendControllerRevise(runtime, checkpoint.round, decision.notes, result.finalText)
            await runReviewLoop(runtime, configPath, checkpoint.round + 1, checkpoint.reuseCurrentPane,
              sessionDir, ci.specPath, checkpoint.currentIssueIndex, checkpoint.issues)
            await markIssueFinished(configPath, checkpoint.currentIssueIndex, checkpoint.issues)
          } else {
            await runReviewLoop(runtime, configPath, checkpoint.round, checkpoint.reuseCurrentPane,
              sessionDir, ci.specPath, checkpoint.currentIssueIndex, checkpoint.issues,
              { controllerReviewNotes: decision.notes, lastReviewOutput: result.finalText })
            await markIssueFinished(configPath, checkpoint.currentIssueIndex, checkpoint.issues)
          }
        }
      } else if (phase === "implement") {
        await markIssueInReview(checkpoint.configPath, checkpoint.currentIssueIndex, checkpoint.issues)
        if (!runtime.reviewerSession) {
          const { bootstrapSession } = await import("../agent/index.js")
          runtime.reviewerSession = await bootstrapSession(runtime.config.reviewer)
        }
        await runReviewLoop(runtime, configPath, 1, false,
          sessionDir, ci.specPath, checkpoint.currentIssueIndex, checkpoint.issues)
        await markIssueFinished(configPath, checkpoint.currentIssueIndex, checkpoint.issues)
      } else if (phase === "post-check") {
        // P1: 根据原 review 状态决定后续流程
        const reviewStatus = checkpoint.reviewStatus || "REVIEW_PASS"
        if (reviewStatus === "REVIEW_NEEDS_CHECK") {
          // 恢复 post-check 后发现原 review 需人工核查
          const reviewerSession = runtime.reviewerSession ?? checkpoint.reviewerSession
          const notificationContext = reviewerSession
            ? {
                role: "reviewer",
                provider: reviewerSession.provider,
                paneId: runtime.reviewerPane,
                reason: "Review 需要人工核查",
                turnId: String(reviewerSession.offset),
                interventionType: "needs_input" as const,
              }
            : undefined

          const { resolveNeedsCheckDecision } = await import("../review/needs-check.js")
          const reviewerOut = checkpoint.interventionReviewOutput || checkpoint.reviewOutput
          const decision = await resolveNeedsCheckDecision(
            runtime.args, runtime.needsCheckMode, checkpoint.round,
            { kind: "needs_check", passed: false, cannotVerifySummary: null, hasCannotVerify: false },
            reviewerOut,
            buildCheckpointInput(runtime, configPath, checkpoint.round, reviewerOut,
              { cannotVerifySummary: null, hasCannotVerify: false, kind: "needs_check", passed: false },
              false, ci.specPath, checkpoint.currentIssueIndex, checkpoint.issues),
            sessionDir,
            notificationContext,
            runtime.eventBus,
          )
          console.log(`[Resume] Post-check REVIEW_NEEDS_CHECK → decision: ${decision.action}`)
          if (decision.action === "approve") {
            await markIssueFinished(configPath, checkpoint.currentIssueIndex, checkpoint.issues)
          } else if (decision.action === "abort") {
            throw new Error(`[Resume] Workflow aborted after REVIEW_NEEDS_CHECK`)
          } else if (decision.action === "revise") {
            await ensureImplPane()
            const { sendControllerRevise } = await import("./review-loop.js")
            await sendControllerRevise(runtime, checkpoint.round, decision.notes, reviewerOut)
            await runReviewLoop(runtime, configPath, checkpoint.round + 1, checkpoint.reuseCurrentPane,
              sessionDir, ci.specPath, checkpoint.currentIssueIndex, checkpoint.issues)
            await markIssueFinished(configPath, checkpoint.currentIssueIndex, checkpoint.issues)
          } else {
            await runReviewLoop(runtime, configPath, checkpoint.round, checkpoint.reuseCurrentPane,
              sessionDir, ci.specPath, checkpoint.currentIssueIndex, checkpoint.issues,
              { controllerReviewNotes: decision.notes, lastReviewOutput: reviewerOut })
            await markIssueFinished(configPath, checkpoint.currentIssueIndex, checkpoint.issues)
          }
        } else {
          await markIssueFinished(configPath, checkpoint.currentIssueIndex, checkpoint.issues)
        }
      } else {
        // revise / controller-revise / review-intervention
        const nextRound = phase === "revise" || phase === "controller-revise" ? checkpoint.round + 1 : checkpoint.round
        await runReviewLoop(runtime, configPath, nextRound, checkpoint.reuseCurrentPane,
          sessionDir, ci.specPath, checkpoint.currentIssueIndex, checkpoint.issues)
        await markIssueFinished(configPath, checkpoint.currentIssueIndex, checkpoint.issues)
      }

      if (checkpoint.currentIssueIndex + 1 < checkpoint.issues.length) {
        await advanceBaseline(runtime)
        await runIssueQueueFromIndex(runtime, configPath, checkpoint.currentIssueIndex + 1, checkpoint.issues)
      } else {
        // 最后一个 issue 完成，发布 workflow complete
        runtime.eventBus.publish({ type: "complete" })
      }
    } finally {
      // P2: 清理本次恢复中创建的所有 pane（含 runReviewLoop 内部创建的）
      for (const pid of createdPaneIds) {
        await stopAgent(pid).catch(() => {})
      }
      if (runtime.implementerPane) { await stopAgent(runtime.implementerPane).catch(() => {}); runtime.implementerPane = "" }
      if (runtime.reviewerPane) { await stopAgent(runtime.reviewerPane).catch(() => {}); runtime.reviewerPane = "" }
    }
    return
  }

  // 非 intervention：常规 needs-check 恢复
  const currentIssue = checkpoint.issues[checkpoint.currentIssueIndex]

  if (!currentIssue) {
    throw new Error(`[Resume] Invalid checkpoint: issue index ${checkpoint.currentIssueIndex} out of range`)
  }

  const ensureImplementerPane = async () => {
    if (!runtime.implementerPane && runtime.implementerSession?.resumeId) {
      runtime.implementerPane = await startAgentResumed(
        runtime.config.projectDir, runtime.config.implementer,
        runtime.implementerSession.resumeId, { ensureUniqueName: true },
      )
      console.log(`[Resume] Created implementer pane: ${runtime.implementerPane}`)
    }
  }

  const ensureReviewerPane = async () => {
    if (!runtime.reviewerPane && runtime.reviewerSession?.resumeId) {
      runtime.reviewerPane = await startAgentResumed(
        runtime.config.projectDir, runtime.config.reviewer,
        runtime.reviewerSession.resumeId, { ensureUniqueName: true },
      )
      console.log(`[Resume] Created reviewer pane: ${runtime.reviewerPane}`)
    }
  }

  const cleanupPanes = async () => {
    if (runtime.implementerPane) { await stopAgent(runtime.implementerPane); runtime.implementerPane = "" }
    if (runtime.reviewerPane) { await stopAgent(runtime.reviewerPane); runtime.reviewerPane = "" }
  }

  switch (action) {
    case "approve":
      console.log(`[Issue] Issue approved: ${currentIssue.title}`)
      await markIssueFinished(configPath, checkpoint.currentIssueIndex, checkpoint.issues)
      if (checkpoint.currentIssueIndex + 1 < checkpoint.issues.length) {
        await advanceBaseline(runtime)
        await runIssueQueueFromIndex(runtime, configPath, checkpoint.currentIssueIndex + 1, checkpoint.issues)
      } else {
        console.log("\n[Issue] Workflow finished: all issues manually approved.")
        runtime.eventBus.publish({ type: "complete" })
      }
      return
    case "abort":
      // 不创建 pane，直接抛错
      throw new Error(`[Resume] Workflow aborted after needs_check in round ${checkpoint.round}.`)
    case "revise":
      await ensureImplementerPane()
      if (!runtime.reviewerSession) {
        runtime.reviewerSession = await bootstrapSession(runtime.config.reviewer)
      }
      await ensureReviewerPane()
      await sendControllerRevise(runtime, checkpoint.round, notes, checkpoint.reviewOutput)
      if (!runtime.reviewerSession) {
        runtime.reviewerSession = await bootstrapSession(runtime.config.reviewer)
      }
      await ensureReviewerPane()
      try {
        await runReviewLoop(runtime, configPath, checkpoint.round + 1, checkpoint.reuseCurrentPane, sessionDir, currentIssue.specPath, checkpoint.currentIssueIndex, checkpoint.issues)
        await markIssueFinished(configPath, checkpoint.currentIssueIndex, checkpoint.issues)
        if (checkpoint.currentIssueIndex + 1 < checkpoint.issues.length) {
          await advanceBaseline(runtime)
          await runIssueQueueFromIndex(runtime, configPath, checkpoint.currentIssueIndex + 1, checkpoint.issues)
        } else {
          runtime.eventBus.publish({ type: "complete" })
        }
      } finally {
        await cleanupPanes()
      }
      return
    case "retry-review":
      if (!runtime.reviewerSession) {
        runtime.reviewerSession = await bootstrapSession(runtime.config.reviewer)
      }
      await ensureReviewerPane()
      try {
        await runReviewLoop(runtime, configPath, checkpoint.round, checkpoint.reuseCurrentPane, sessionDir, currentIssue.specPath, checkpoint.currentIssueIndex, checkpoint.issues, { controllerReviewNotes: notes, lastReviewOutput: checkpoint.reviewOutput })
        await markIssueFinished(configPath, checkpoint.currentIssueIndex, checkpoint.issues)
        if (checkpoint.currentIssueIndex + 1 < checkpoint.issues.length) {
          await advanceBaseline(runtime)
          await runIssueQueueFromIndex(runtime, configPath, checkpoint.currentIssueIndex + 1, checkpoint.issues)
        } else {
          runtime.eventBus.publish({ type: "complete" })
        }
      } finally {
        await cleanupPanes()
      }
      return
    default: {
      const _exhaustive: never = action
      throw new Error(`[Resume] Unknown needs-check action: ${_exhaustive}`)
    }
  }
}
