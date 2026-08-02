import type { TranscriptEvent } from "./types.js"

/**
 * Codex JSONL adapter（工厂模式：每个 monitor 独立实例，无共享状态）。
 *
 * 仅终端事件（task_complete）携带 text；agent_message 缓存但不输出文本，
 * 避免中间消息被 monitor 重复累计。
 *
 * 失败终态映射：
 * - task_error / task_failed → failed（保留错误信息）
 * - exception → failed
 */
export const createCodexAdapter = () => {
  let lastAgentMessage: string | undefined

  const processLine = (line: unknown): TranscriptEvent | undefined => {
    if (typeof line !== "object" || line === null) return undefined

    const obj = line as Record<string, unknown>
    if (obj.type !== "event_msg") return undefined

    const payload = obj.payload as Record<string, unknown> | undefined
    if (!payload) return undefined

    const payloadType = payload.type as string | undefined

    if (payloadType === "task_started") {
      return { type: "working" }
    }

    // 缓存 agent_message 文本，不输出（避免重复累计）
    if (payloadType === "agent_message") {
      const text = payload.message as string | undefined
      if (text) lastAgentMessage = text

      // Codex 中途提问 → needs_input
      const toolCalls = (payload.tool_calls ?? payload.tool_use) as Array<Record<string, unknown>> | undefined
      if (toolCalls && Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          const name = call.name as string | undefined ?? call.function as string | undefined
          if (name === "AskUserQuestion" || name === "ask_user_question") {
            const args = (call.arguments ?? call.input) as Record<string, unknown> | undefined
            const questions = (args?.questions as Array<Record<string, unknown>>) ?? []
            const questionText = questions.map((q) => q.question as string).filter(Boolean).join("; ")
            return { type: "needs_input", question: questionText || "Agent needs input" }
          }
        }
      }

      return { type: "working" }
    }

    if (payloadType === "task_complete") {
      const finalText = (payload.last_agent_message as string | undefined) ?? lastAgentMessage
      lastAgentMessage = undefined
      return { type: "completed", text: finalText }
    }

    // 失败终态：保留错误原因
    if (payloadType === "task_error" || payloadType === "task_failed") {
      const errorMsg = (payload.error as string) ?? (payload.message as string) ?? "Codex task failed"
      lastAgentMessage = undefined
      return { type: "failed", reason: errorMsg, text: errorMsg }
    }

    // 异常事件 → failed
    if (payloadType === "exception") {
      const errorMsg = (payload.message as string) ?? (payload.error as string) ?? "Codex exception"
      lastAgentMessage = undefined
      return { type: "failed", reason: errorMsg, text: errorMsg }
    }

    return undefined
  }

  return { processLine }
}
