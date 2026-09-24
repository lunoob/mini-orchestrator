import type { AgentRole, AgentSessionHandle, AgentStatus } from "../agent/transcript/types.js"
import { sendTask, waitForAgentWithMonitor } from "../agent/index.js"
import { notifyNeedsInput, resetNotifyDedup } from "../notify/index.js"
import type { WorkflowEventBus } from "./events.js"
import { parseStatus } from "../lib/status-parser.js"

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
  /** 可选的 event bus，用于 terminal 面板交互 */
  eventBus?: WorkflowEventBus
  /** workflow 任务标题，用于系统通知 */
  workflowTitle?: string
}

export const defaultImplementAskDeps = (): ImplementAskDeps => ({
  log: (message) => console.log(message),
})

export const CONTINUATION_PROMPT = "Based on the user's response above, continue with the previous task. When finished, output the status marker."

const MISSING_STATUS_PROMPT = "请输出状态标记（STATUS: 行），格式与任务说明一致。"

/** 无 STATUS 标记时的重试次数上限 */
const MAX_MISSING_STATUS_RETRIES = 2

/** quickCheck 的等待时长：判断 agent 是否已自行继续 */
const QUICK_CHECK_TIMEOUT_MS = 3000
const QUICK_CHECK_POLL_MS = 500

const labelOf = (role: AgentRole) => (role === "implementer" ? "Implementer" : "Reviewer")

const isFailed = (status: string | undefined): status is "failed" =>
  status === "failed" || status === "IMPLEMENT_FAILED"

const getStatusKey = (output: string, role: AgentRole): string | null => parseStatus(output, role).status

export type GateResult = {
  finalText: string
  /** gate 结束时 monitor 的终态（completed / needs_input / working） */
  status: AgentStatus
  /** gate 结束时 monitor 的最新提问（agent 再次提问时携带） */
  question?: string
}

/**
 * yes/no 门卫：agent 需要人工处理（输出 ASK 标记或原生提问）后，通知用户并等待 yes/no。
 *
 * - yes：先 quickCheck 兜底（agent 已自愈则直接收尾），否则发 continuation 让 agent 继续
 * - no：抛 ImplementAskAbortError 终止调度器
 *
 * 返回 gate 结束后的 { finalText, status }；status 为 needs_input 时调用方应再次门卫。
 */
export const handleNeedsInputGate = async (
  role: AgentRole,
  paneId: string,
  context: string,
  sessionHandle: AgentSessionHandle,
  deps: ImplementAskDeps = defaultImplementAskDeps(),
  question?: string,
): Promise<GateResult> => {
  const label = labelOf(role)
  const reason = question ?? "Agent 需要人工处理"
  deps.log(`[Gate] ${label} 需要确认（${context}）：${reason}`)
  deps.log(`可在 pane: ${paneId} 中处理后返回，选择继续或终止。`)

  // 始终发送系统通知（用户可能不盯着面板），去重由 turnId 保证
  notifyNeedsInput(role, sessionHandle.provider, reason, sessionHandle.resumeId, paneId, String(sessionHandle.offset), deps.workflowTitle)

  if (deps.eventBus) {
    const result = await deps.eventBus.requestInteraction({
      prompt: `${label} 需要人工处理（${context}）：\n${reason}\n\n请到 pane: ${paneId} 中处理，完成后选择是否继续。`,
      agent: role,
      actions: ["yes", "no"],
    })
    if (result.action !== "yes") {
      throw new ImplementAskAbortError(context)
    }
  } else {
    // 无面板：发通知后阻塞等待 agent 自行继续（用户会在 agent 侧处理，monitor 轮询到终态）
    deps.log("[Gate] 无交互面板，已发送系统通知。请处理后在 agent 侧继续。")
    const waitResult = await waitForAgentWithMonitor(sessionHandle)
    sessionHandle.offset = waitResult.finalOffset
    resetNotifyDedup()
    if (isFailed(waitResult.status)) {
      const failReason = waitResult.lastEvent?.reason ?? waitResult.lastEvent?.question ?? "Agent failed"
      throw new AgentFailError(context, failReason)
    }
    return { finalText: waitResult.finalText, status: waitResult.status, question: waitResult.lastEvent?.question }
  }

  // 已选 yes：quickCheck 兜底，agent 已自愈则直接收尾
  let quick: { finalText: string; status: AgentStatus; finalOffset: number; lastEvent?: { reason?: string; question?: string } }
  try {
    quick = await waitForAgentWithMonitor(sessionHandle, {
      timeoutMs: QUICK_CHECK_TIMEOUT_MS,
      pollIntervalMs: QUICK_CHECK_POLL_MS,
    })
  } catch {
    // 超时 = agent 还在处理用户问题（无新终态事件），继续走 continuation
    quick = { finalText: "", status: "working", finalOffset: sessionHandle.offset }
  }
  sessionHandle.offset = quick.finalOffset
  resetNotifyDedup()
  if (isFailed(quick.status)) {
    const failReason = quick.lastEvent?.reason ?? quick.lastEvent?.question ?? "Agent failed"
    throw new AgentFailError(context, failReason)
  }
  if (quick.status !== "working") return { finalText: quick.finalText, status: quick.status, question: quick.lastEvent?.question }

  // 仍 working：发 continuation 让 agent 继续，等待终态
  await sendTask(paneId, CONTINUATION_PROMPT)
  const result = await waitForAgentWithMonitor(sessionHandle)
  sessionHandle.offset = result.finalOffset
  resetNotifyDedup()
  if (isFailed(result.status)) {
    const failReason = result.lastEvent?.reason ?? result.lastEvent?.question ?? "Agent failed"
    throw new AgentFailError(context, failReason)
  }
  return { finalText: result.finalText, status: result.status, question: result.lastEvent?.question }
}

/**
 * 无 STATUS 标记时的重试循环：发提示让 agent 补标记，最多 MAX_MISSING_STATUS_RETRIES 次。
 * 返回 { finalText, status }；超限则抛错。
 */
export const ensureStatusRetry = async (
  role: AgentRole,
  paneId: string,
  initialOutput: string,
  context: string,
  sessionHandle: AgentSessionHandle,
  deps: ImplementAskDeps = defaultImplementAskDeps(),
): Promise<GateResult> => {
  let currentOutput = initialOutput
  let currentStatus: AgentStatus = "completed"
  for (let attempt = 0; attempt < MAX_MISSING_STATUS_RETRIES; attempt++) {
    const status = getStatusKey(currentOutput, role)
    if (status) return { finalText: currentOutput, status: currentStatus }

    deps.log(`[Gate] ${labelOf(role)} 未输出状态标记（${context}），第 ${attempt + 1}/${MAX_MISSING_STATUS_RETRIES} 次重试`)
    await sendTask(paneId, MISSING_STATUS_PROMPT)
    const result = await waitForAgentWithMonitor(sessionHandle)
    sessionHandle.offset = result.finalOffset
    resetNotifyDedup()
    if (isFailed(result.status)) {
      const failReason = result.lastEvent?.reason ?? result.lastEvent?.question ?? "Agent failed"
      throw new AgentFailError(context, failReason)
    }
    currentOutput = result.finalText
    currentStatus = result.status
  }
  throw new Error(`[Gate] ${labelOf(role)} 多次未输出状态标记（${context}），终止。`)
}

/**
 * @deprecated 使用 handleNeedsInputGate / ensureStatusRetry 替代
 */
export const handleImplementAskIfNeeded = async (
  paneId: string,
  output: string,
  context: string,
  sessionHandle: AgentSessionHandle,
  deps: ImplementAskDeps = defaultImplementAskDeps(),
): Promise<string> => {
  const parseResult = parseStatus(output, "implementer")
  if (parseResult.status === "IMPLEMENT_DONE") return output

  const gated = await handleNeedsInputGate(
    "implementer", paneId, context, sessionHandle, deps,
    parseResult.status === "IMPLEMENT_ASK" ? "Agent 需要确认" : undefined,
  )
  return gated.finalText
}
