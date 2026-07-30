import type { TranscriptEvent } from "./types.js"

/**
 * Codex JSONL adapter（工厂模式：每个 monitor 独立实例，无共享状态）。
 *
 * 仅终端事件（task_complete）携带 text；agent_message 缓存但不输出文本，
 * 避免中间消息被 monitor 重复累计。
 */
export const createCodexAdapter = () => {
  let lastAgentMessage: string | undefined

  const processLine = (line: unknown): TranscriptEvent | undefined => {
    if (typeof line !== "object" || line === null) return undefined

    const obj = line as Record<string, unknown>
    const eventMsg = obj.event_msg as Record<string, unknown> | undefined
    if (!eventMsg) return undefined

    const payload = eventMsg.payload as Record<string, unknown> | undefined
    if (!payload) return undefined

    const payloadType = payload.type as string | undefined

    if (payloadType === "task_started") {
      return { type: "working" }
    }

    // 缓存 agent_message 文本，不输出（避免重复累计）
    if (payloadType === "agent_message") {
      const text = payload.message as string | undefined
      if (text) lastAgentMessage = text
      return { type: "working" }
    }

    if (payloadType === "task_complete") {
      const finalText = (payload.last_agent_message as string | undefined) ?? lastAgentMessage
      lastAgentMessage = undefined
      return { type: "completed", text: finalText }
    }

    return undefined
  }

  return { processLine }
}
