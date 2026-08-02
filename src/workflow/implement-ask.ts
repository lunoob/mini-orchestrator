import type { AgentRole, AgentSessionHandle } from "../agent/transcript/types.js"
import { sendTask, waitForAgentWithMonitor } from "../agent/index.js"
import { isProtocolError, parseOutcome, type AgentOutcome } from "../lib/outcome-parser.js"
import { notifyInvalidOutput, notifyNeedsInput, resetNotifyDedup } from "../notify/index.js"
import type { WorkflowEventBus } from "./events.js"

export class ImplementAskAbortError extends Error {
  constructor(context: string) {
    super(`用户取消继续（${context}）`)
    this.name = "ImplementAskAbortError"
  }
}

/** Agent 失败（非用户取消），应导致 workflow 失败并返回退出码 1 */
export class AgentFailError extends Error {
  constructor(context: string, reason: string) {
    super(`Agent 失败（${context}）: ${reason}`)
    this.name = "AgentFailError"
  }
}

export type ImplementAskDeps = {
  log: (message: string) => void
  promptContinue: () => Promise<boolean>
  /** 可选的 event bus，用于 terminal 面板交互 */
  eventBus?: WorkflowEventBus
}

export const defaultImplementAskDeps = (): ImplementAskDeps => ({
  log: (message) => console.log(message),
  promptContinue: async () => { throw new Error("No interaction handler available") },
})

const CONTINUATION_PROMPT = "Based on the user's response above, continue with the previous task. Output the outcome as a JSON object with the required schema."

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
): Promise<string> => {
  const label = role === "implementer" ? "Implementer" : "Reviewer"

  // 使用 eventBus 面板交互（必须可用，无 readline fallback）
  const promptUser = async (
    prompt: string,
    requestConfig?: { question: string; options?: Array<{id: string; label: string; description?: string}>; recommendation?: string; allowFreeform: boolean; inputHint?: string },
  ): Promise<{ shouldContinue: boolean; answer?: string; optionId?: string }> => {
    if (!deps.eventBus) {
      throw new Error("[Intervention] No interaction handler available — cannot prompt user")
    }
    const hasPresetOptions = !!requestConfig?.options?.length
    if (hasPresetOptions) {
      // 有预设选项：显示选项按钮
      const actions = requestConfig!.options!.map((o) => o.id)
      if (requestConfig?.allowFreeform && !actions.includes("other")) {
        actions.push("other")
      }
      const textRequiredFor = ["other"]
      const result = await deps.eventBus.requestInteraction({
        prompt,
        agent: role,
        actions,
        textRequiredFor,
        textOptional: requestConfig?.allowFreeform !== false,
        textInputPlaceholder: requestConfig?.inputHint ?? "输入你的回答…",
        requestOptions: requestConfig?.options,
        recommendation: requestConfig?.recommendation,
        allowFreeform: requestConfig?.allowFreeform,
        inputHint: requestConfig?.inputHint,
      })
      const optionId = result.optionId ? result.optionId : undefined
      return { shouldContinue: result.action !== "abort", answer: result.text, optionId }
    }
    // 无预设选项：直接进入文本输入模式，无按钮
    const result = await deps.eventBus.requestInteraction({
      prompt,
      agent: role,
      actions: [],
      textRequiredFor: [],
      textOptional: false,
      textInputPlaceholder: requestConfig?.inputHint ?? "输入你的回答…",
      allowFreeform: true,
      inputHint: requestConfig?.inputHint,
    })
    return { shouldContinue: result.action !== "abort", answer: result.text, optionId: undefined }
  }

  // 构建结构化 user message
  const buildUserMessage = (optionId?: string, text?: string): string => {
    const msg: Record<string, unknown> = { type: "user_response" }
    if (optionId) msg.optionId = optionId
    if (text) msg.text = text
    return JSON.stringify(msg)
  }

  let needsInput = !isInvalidOutput
  let isInvalid = isInvalidOutput
  let invalidRetries = 0
  const MAX_INVALID_RETRIES = 1
  let currentOutput = output
  let currentQuestion = initialQuestion

  const isNotCompleted = (output: string) => {
    const r = parseOutcome(output, role)
    return isProtocolError(r) || r.outcome !== "completed"
  }

  while (true) {
    // 检查当前状态
    if (!needsInput && !isInvalid) {
      const tempResult = parseOutcome(currentOutput, role)
      if (isProtocolError(tempResult)) { isInvalid = true; currentQuestion = tempResult.reason; continue }
      if (tempResult.outcome === "completed") return currentOutput
      if (tempResult.outcome === "needs_input") { needsInput = true; currentQuestion = tempResult.request.question; continue }
      // failed → Agent 合法失败，直接终止，不进入重试
      if (tempResult.outcome === "failed") {
        deps.log(`[Intervention] ${label} Agent reported failure: ${tempResult.failure.message}`)
        throw new ImplementAskAbortError(`${context} (agent failed: ${tempResult.failure.message})`)
      }
    }

    // isInvalid: 通知并暂停（最多重试 MAX_INVALID_RETRIES 次）
    if (isInvalid) {
      invalidRetries++
      const reason = currentQuestion ?? "输出中未找到有效的 JSON outcome"
      // 每次无效输出都发送通知，再检查重试上限
      notifyInvalidOutput(role, sessionHandle.provider, reason, sessionHandle.resumeId, paneId, String(sessionHandle.offset))
      deps.log(`[Intervention] ${label} 输出无效（${context}, 重试 ${invalidRetries}/${MAX_INVALID_RETRIES}）: ${reason}`)

      if (invalidRetries > MAX_INVALID_RETRIES) {
        deps.log(`[Intervention] ${label} 超过最大无效重试次数 (${MAX_INVALID_RETRIES})，中止。`)
        throw new ImplementAskAbortError(`${context} (max invalid retries exceeded)`)
      }

      const { shouldContinue } = await promptUser(
        `[${label}] pane: ${paneId}\n输出无效: ${reason}\n可在 pane 中处理后选择继续`,
      )
      if (!shouldContinue) throw new ImplementAskAbortError(`${context} (invalid_output)`)

      let handled = false
      try {
        const quickCheck = await waitForAgentWithMonitor(sessionHandle, { timeoutMs: 3000, pollIntervalMs: 500 })
        sessionHandle.offset = quickCheck.finalOffset
        resetNotifyDedup()
        // P2-2: Agent 已失败时立即终止，不发送 continuation prompt
        if (quickCheck.status === "failed") {
          const failReason = quickCheck.lastEvent?.reason ?? quickCheck.lastEvent?.question ?? "Agent failed"
          deps.log(`[Intervention] ${label} Agent failed during invalid_output recovery: ${failReason}`)
          throw new AgentFailError(context, failReason)
        }
        if (quickCheck.status !== "working") {
          currentOutput = quickCheck.finalText
          needsInput = quickCheck.status === "needs_input"
          isInvalid = !needsInput && quickCheck.status !== "completed" && (isNotCompleted(currentOutput))
          currentQuestion = quickCheck.lastEvent?.question
          handled = true
        }
      } catch (e) { if (e instanceof ImplementAskAbortError || e instanceof AgentFailError) throw e; /* timeout = not completed */ }

      if (!handled) {
        await sendTask(paneId, buildUserMessage(undefined, reason))
        const result = await waitForAgentWithMonitor(sessionHandle)
        sessionHandle.offset = result.finalOffset
        resetNotifyDedup()
        if (result.status === "failed") {
          const failReason = result.lastEvent?.reason ?? result.lastEvent?.question ?? "Agent failed"
          deps.log(`[Intervention] ${label} Agent failed after sendTask: ${failReason}`)
          throw new AgentFailError(context, failReason)
        }
        currentOutput = result.finalText
        needsInput = result.status === "needs_input"
        isInvalid = !needsInput && (isNotCompleted(currentOutput))
        currentQuestion = result.lastEvent?.question
      }
      continue
    }

    // needsInput: 通知提问并等待用户交互
    const questionDisplay = currentQuestion ?? "需要人工确认"
    deps.log(`[Intervention] ${label} 需要确认（${context}）：${questionDisplay}`)
    deps.log("可在 agent 侧继续交互，完成后选择是否继续。")

    notifyNeedsInput(role, sessionHandle.provider, questionDisplay, sessionHandle.resumeId, paneId, String(sessionHandle.offset))

    // 从当前输出中提取 RequestConfig（用于结构化交互面板）
    const currentOutcome = parseOutcome(currentOutput, role)
    const reqConfig = !isProtocolError(currentOutcome) && currentOutcome.outcome === "needs_input"
      ? currentOutcome.request : undefined

    const { shouldContinue, answer, optionId } = await promptUser(
      `[${label}] pane: ${paneId}\n${questionDisplay}\n可在 pane 中处理后选择继续，或输入回答`,
      reqConfig ? {
        question: reqConfig.question,
        options: reqConfig.options?.map((o) => ({ id: o.id, label: o.label, description: o.description })),
        recommendation: reqConfig.recommendation,
        allowFreeform: reqConfig.allowFreeform,
        inputHint: reqConfig.inputHint,
      } : undefined,
    )
    if (!shouldContinue) throw new ImplementAskAbortError(context)

    let handled = false
    try {
      const quickCheck = await waitForAgentWithMonitor(sessionHandle, { timeoutMs: 3000, pollIntervalMs: 500 })
      sessionHandle.offset = quickCheck.finalOffset
      resetNotifyDedup()
      // P2-2: Agent 已失败时立即终止，不发送 continuation prompt
      if (quickCheck.status === "failed") {
        const failReason = quickCheck.lastEvent?.reason ?? quickCheck.lastEvent?.question ?? "Agent failed"
        deps.log(`[Intervention] ${label} Agent failed during needs_input recovery: ${failReason}`)
        throw new AgentFailError(context, failReason)
      }
      if (quickCheck.status !== "working") {
        currentOutput = quickCheck.finalText
        needsInput = quickCheck.status === "needs_input"
        isInvalid = !needsInput && quickCheck.status !== "completed" && (isNotCompleted(currentOutput))
        currentQuestion = quickCheck.lastEvent?.question
        handled = true
      }
    } catch (e) { if (e instanceof ImplementAskAbortError || e instanceof AgentFailError) throw e; /* timeout = not completed */ }

    if (handled) continue

    deps.log(`[Intervention] ${label} 未自动完成，发送结构化 user response...`)
    const userMessage = buildUserMessage(optionId, answer)
    await sendTask(paneId, `${userMessage}\n${CONTINUATION_PROMPT}`)

    const result = await waitForAgentWithMonitor(sessionHandle)
    sessionHandle.offset = result.finalOffset
    resetNotifyDedup()

    // P2-2: Agent 已失败时立即终止
    if (result.status === "failed") {
      const failReason = result.lastEvent?.reason ?? result.lastEvent?.question ?? "Agent failed"
      deps.log(`[Intervention] ${label} Agent failed after sendTask: ${failReason}`)
      throw new AgentFailError(context, failReason)
    }

    currentOutput = result.finalText
    needsInput = result.status === "needs_input"
    isInvalid = !needsInput && (isNotCompleted(currentOutput))
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
  const parseResult = parseOutcome(output, "implementer")
  const isInvalid = isProtocolError(parseResult) || parseResult.outcome === "failed"
  const isAsk = !isProtocolError(parseResult) && parseResult.outcome === "needs_input" || initialQuestion !== undefined

  if (!isAsk && !isInvalid) return output

  return handleIntervention(
    "implementer", paneId, output, context, sessionHandle, deps,
    initialQuestion ?? (isProtocolError(parseResult) ? parseResult.reason : parseResult.outcome === "failed" ? parseResult.failure.message : undefined),
    isInvalid,
  )
}
