import type { TranscriptEvent } from "./types.js"

/**
 * Cursor (cursor-agent) JSONL adapter（工厂模式：每个 monitor 独立实例）。
 *
 * 仅终端事件（turn_ended / AskQuestion）携带 text；中间 assistant 消息不携带文本。
 */
export const createCursorAdapter = () => {
  let lastAssistantText: string | undefined

  const processLine = (line: unknown): TranscriptEvent | undefined => {
    if (typeof line !== "object" || line === null) return undefined

    const obj = line as Record<string, unknown>

    // turn_ended → 终态
    if (obj.type === "turn_ended") {
      const status = obj.status as string | undefined
      const finalText = lastAssistantText
      lastAssistantText = undefined
      if (status === "success") return { type: "completed", text: finalText }
      if (status === "error") return { type: "failed" }
      return undefined
    }

    // assistant 消息
    if (obj.type !== "assistant") return undefined

    const message = obj.message as Record<string, unknown> | undefined
    if (!message || !Array.isArray(message.content)) return undefined

    const content = message.content as Array<Record<string, unknown>>

    // AskQuestion → needs_input（携带问题文本）
    for (const block of content) {
      if (block.type === "tool_use" && block.name === "AskQuestion") {
        const input = block.input as Record<string, unknown> | undefined
        const title = (input?.title as string) ?? ""
        const questions = (input?.questions as Array<Record<string, unknown>>) ?? []
        const questionText = [title, ...questions.map((q) => q.question as string)]
          .filter(Boolean)
          .join("; ")

        return { type: "needs_input", question: questionText || "Agent needs input" }
      }
    }

    // 缓存文本但不输出（仅终态时携带）
    const textParts = content
      .filter((block) => block.type === "text")
      .map((block) => block.text as string)
      .filter(Boolean)
    if (textParts.length > 0) lastAssistantText = textParts.join("")

    return { type: "working" }
  }

  return { processLine }
}
