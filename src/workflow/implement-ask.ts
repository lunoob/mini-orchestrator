import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"

import type { AgentRole, AgentSessionHandle } from "../agent/transcript/types.js"
import { sendTask, waitForAgentWithMonitor } from "../agent/index.js"
import { parseAgentOutput } from "../lib/status-parser.js"
import { notifyImplementAsk, notifyInvalidOutput, notifyNeedsInput, resetNotifyDedup } from "../notify/index.js"
import type { WorkflowEventBus } from "./events.js"

export class ImplementAskAbortError extends Error {
  constructor(context: string) {
    super(`用户取消继续（${context}）`)
    this.name = "ImplementAskAbortError"
  }
}

export type ImplementAskDeps = {
  log: (message: string) => void
  promptContinue: () => Promise<boolean>
  /** 可选的 event bus，用于 terminal 面板交互 */
  eventBus?: WorkflowEventBus
}

const promptContinueInteractive = async (): Promise<boolean> => {
  const rl = createInterface({ input, output })

  try {
    while (true) {
      const answer = (await rl.question("agent 需要确认，是否继续？[yes / no]: "))
        .trim()
        .toLowerCase()

      if (answer === "yes" || answer === "y") return true
      if (answer === "no" || answer === "n") return false
      console.log("[Intervention] 无效输入，请输入：yes / no")
    }
  } finally {
    rl.close()
  }
}

export const defaultImplementAskDeps = (): ImplementAskDeps => ({
  log: (message) => console.log(message),
  promptContinue: promptContinueInteractive,
})

const CONTINUATION_PROMPT = "Based on the user's response above, continue with the previous task. Output the STATUS marker as required."

/** checkpoint 上下文：由调用方提供真实 workflow 数据 */
export type InterventionCheckpointContext = {
  configPath: string
  projectDir: string
  issues: Array<{ title: string; specPath: string }>
  currentIssueIndex: number
  round: number
  maxReviewRounds: number
  phase: string
  implementerSession?: AgentSessionHandle
  reviewerSession?: AgentSessionHandle
  baseSha: string | undefined
  hasGit: boolean
  reuseCurrentPane: boolean
  /** post-check 阶段的 review 状态，恢复时决定后续流程 */
  reviewStatus?: string
  /** 触发 intervention 的原始 reviewer 输出（post-check 阶段时保留） */
  interventionReviewOutput?: string
}

/**
 * 统一 intervention handler。
 *
 * @param role 角色（implementer / reviewer）
 * @param paneId agent pane ID
 * @param output 当前 agent 输出
 * @param context 描述文本
 * @param sessionHandle 当前干预角色的会话句柄
 * @param deps 依赖注入
 * @param initialQuestion 原生提问文本（monitor 提供）
 * @param isInvalidOutput 是否为 invalid_output
 * @param needsCheckMode LLM/terminal 模式
 * @param checkpointCtx LLM 模式下的 checkpoint 上下文（调用方提供真实数据）
 */
export const handleIntervention = async (
  role: AgentRole,
  paneId: string,
  output: string,
  context: string,
  sessionHandle: AgentSessionHandle,
  deps: ImplementAskDeps = defaultImplementAskDeps(),
  initialQuestion?: string,
  isInvalidOutput = false,
  needsCheckMode: "interactive" | "llm" = "interactive",
  checkpointCtx?: InterventionCheckpointContext,
): Promise<string> => {
  const label = role === "implementer" ? "Implementer" : "Reviewer"

  // LLM 模式：写 checkpoint 后退出
  if (needsCheckMode === "llm") {
    const ctx = checkpointCtx ?? {
      configPath: "", projectDir: "", issues: [], currentIssueIndex: 0,
      round: 1, maxReviewRounds: 8, phase: context,
      baseSha: undefined, hasGit: false, reuseCurrentPane: false,
    }
    const { writeNeedsCheckCheckpoint } = await import("../review/checkpoint.js")
    const checkpointPath = await writeNeedsCheckCheckpoint(
      `/tmp/mini-orch-intervention-${Date.now()}`,
      {
        baseSha: ctx.baseSha,
        cannotVerifySummary: isInvalidOutput ? output.slice(0, 500) : null,
        configPath: ctx.configPath,
        hasGit: ctx.hasGit,
        implementerPane: role === "implementer" ? paneId : "",
        implementerSession: ctx.implementerSession ?? (role === "implementer" ? sessionHandle : undefined),
        maxReviewRounds: ctx.maxReviewRounds,
        projectDir: ctx.projectDir,
        reviewOutput: output,
        reviewerPane: role === "reviewer" ? paneId : "",
        reviewerSession: ctx.reviewerSession ?? (role === "reviewer" ? sessionHandle : undefined),
        reuseCurrentPane: ctx.reuseCurrentPane,
        round: ctx.round,
        currentIssueIndex: ctx.currentIssueIndex,
        issues: ctx.issues,
        interventionType: isInvalidOutput ? "invalid_output" : "needs_input",
        interventionRole: role,
        interventionQuestion: initialQuestion,
        /** 触发阶段描述 */
        interventionPhase: ctx.phase,
        reviewStatus: ctx.reviewStatus,
        interventionReviewOutput: ctx.interventionReviewOutput,
      },
    )
    // 通知上下文传递给 NeedsCheckPauseError，由主入口统一发送
    const reason = isInvalidOutput
      ? (initialQuestion ?? "输出缺少合法 STATUS")
      : (initialQuestion ?? "需要人工确认")
    const notificationContext = {
      role,
      provider: sessionHandle.provider,
      paneId,
      reason,
      turnId: String(sessionHandle.offset),
      interventionType: (isInvalidOutput ? "invalid_output" : "needs_input") as "invalid_output" | "needs_input",
      checkpointPath,
    }
    deps.log(`[Intervention] LLM 模式：已保存 checkpoint 到 ${checkpointPath}`)
    deps.log(`ROLE: ${role}  TYPE: ${isInvalidOutput ? "invalid_output" : "needs_input"}  PHASE: ${ctx.phase}`)
    if (initialQuestion) deps.log(`QUESTION: ${initialQuestion}`)
    deps.log(`STATUS: ORCHESTRATOR_NEEDS_CHECK`)
    deps.log(`CHECKPOINT: ${checkpointPath}`)
    const { NeedsCheckPauseError } = await import("../review/needs-check.js")
    throw new NeedsCheckPauseError(checkpointPath, notificationContext)
  }

  // 使用 eventBus 面板交互或回退到 readline
  const promptUser = async (prompt: string): Promise<{ shouldContinue: boolean; answer?: string }> => {
    if (deps.eventBus) {
      try {
        const result = await deps.eventBus.requestInteraction({
          prompt,
          agent: role,
          actions: ["continue", "abort"],
          textOptional: true,
          textInputPlaceholder: "回答（可选，将发送给 Agent）",
        })
        return { shouldContinue: result.action === "continue", answer: result.text }
      } catch {
        // 非交互模式（无 handler），回退到 readline
        return { shouldContinue: await deps.promptContinue() }
      }
    }
    return { shouldContinue: await deps.promptContinue() }
  }

  let needsInput = !isInvalidOutput
  let isInvalid = isInvalidOutput
  let currentOutput = output
  let currentQuestion = initialQuestion

  while (true) {
    // 检查当前状态
    if (!needsInput && !isInvalid) {
      const parsed = parseAgentOutput(currentOutput, role)
      if (parsed.status === "completed") return currentOutput
      if (parsed.status === "needs_input") { needsInput = true; continue }
      if (parsed.status === "invalid_output") { isInvalid = true; continue }
      return currentOutput
    }

    // isInvalid: 通知 invalid_output 并暂停
    if (isInvalid) {
      const parsed = parseAgentOutput(currentOutput, role)
      const reason = parsed.status === "invalid_output" && "reason" in parsed ? parsed.reason : "输出缺少合法 STATUS"
      notifyInvalidOutput(role, sessionHandle.provider, reason, sessionHandle.resumeId, paneId, String(sessionHandle.offset))
      deps.log(`[Intervention] ${label} 输出无效（${context}）: ${reason}`)
      deps.log(`[Intervention] 继续等待修正？`)

      const { shouldContinue } = await promptUser(
        `[${label}] pane: ${paneId}\n输出无效: ${reason}\n可在 pane 中处理后选择继续`,
      )
      if (!shouldContinue) throw new ImplementAskAbortError(`${context} (invalid_output)`)

      // 先增量检查 JSONL，若用户已在 pane 中修正则直接消费终态
      let handled = false
      try {
        const quickCheck = await waitForAgentWithMonitor(sessionHandle, { timeoutMs: 3000 })
        sessionHandle.offset = quickCheck.finalOffset
        resetNotifyDedup()
        if (quickCheck.status !== "working" && quickCheck.status !== "failed") {
          currentOutput = quickCheck.finalText
          needsInput = quickCheck.status === "needs_input"
          isInvalid = !needsInput && quickCheck.status !== "completed" && parseAgentOutput(currentOutput, role).status === "invalid_output"
          currentQuestion = quickCheck.lastEvent?.question
          handled = true
        }
      } catch { /* timeout = not completed */ }

      if (!handled) {
        await sendTask(paneId, CONTINUATION_PROMPT)
        const result = await waitForAgentWithMonitor(sessionHandle)
        sessionHandle.offset = result.finalOffset
        resetNotifyDedup()
        currentOutput = result.finalText
        needsInput = result.status === "needs_input"
        isInvalid = !needsInput && parseAgentOutput(currentOutput, role).status === "invalid_output"
        currentQuestion = result.lastEvent?.question
      }
      continue
    }

    // needsInput: 通知提问并等待用户交互
    const questionDisplay = currentQuestion ?? "需要人工确认"
    deps.log(`[Intervention] ${label} 需要确认（${context}）：${questionDisplay}`)
    deps.log("可在 agent 侧继续交互，完成后选择是否继续。")

    notifyNeedsInput(role, sessionHandle.provider, questionDisplay, sessionHandle.resumeId, paneId, String(sessionHandle.offset))

    const { shouldContinue, answer } = await promptUser(
      `[${label}] pane: ${paneId}\n${questionDisplay}\n可在 pane 中处理后选择继续，或输入回答`,
    )
    if (!shouldContinue) throw new ImplementAskAbortError(context)

    // 快速检查是否已自行完成
    let handled = false
    try {
      const quickCheck = await waitForAgentWithMonitor(sessionHandle, { timeoutMs: 3000 })
      sessionHandle.offset = quickCheck.finalOffset
      resetNotifyDedup()
      if (quickCheck.status !== "working" && quickCheck.status !== "failed") {
        currentOutput = quickCheck.finalText
        needsInput = quickCheck.status === "needs_input"
        isInvalid = !needsInput && quickCheck.status !== "completed" && parseAgentOutput(currentOutput, role).status === "invalid_output"
        currentQuestion = quickCheck.lastEvent?.question
        handled = true
      }
    } catch { /* timeout = not completed */ }

    if (handled) continue

    // 发送续办 prompt（包含用户回答如有）
    deps.log(`[Intervention] ${label} 未自动完成，发送续办 prompt...`)
    const continuationText = answer
      ? `User answered: ${answer}\n${CONTINUATION_PROMPT}`
      : CONTINUATION_PROMPT
    await sendTask(paneId, continuationText)

    const result = await waitForAgentWithMonitor(sessionHandle)
    sessionHandle.offset = result.finalOffset
    resetNotifyDedup()

    currentOutput = result.finalText
    needsInput = result.status === "needs_input"
    isInvalid = !needsInput && result.status !== "completed" && parseAgentOutput(currentOutput, role).status === "invalid_output"
    currentQuestion = result.lastEvent?.question
  }
}

/**
 * @deprecated 使用 handleIntervention 替代
 */
export const handleImplementAskIfNeeded = async (
  paneId: string,
  output: string,
  context: string,
  sessionHandle: AgentSessionHandle,
  deps: ImplementAskDeps = defaultImplementAskDeps(),
  initialQuestion?: string,
): Promise<string> => {
  const parsed = parseAgentOutput(output, "implementer")
  const isInvalid = parsed.status === "invalid_output"
  const isAsk = parsed.status === "needs_input" || initialQuestion !== undefined

  if (!isAsk && !isInvalid) return output

  return handleIntervention(
    "implementer", paneId, output, context, sessionHandle, deps,
    initialQuestion ?? (isInvalid && "reason" in parsed ? parsed.reason : undefined),
    isInvalid,
  )
}
