import type { TranscriptEvent } from "./types.js"

/**
 * Claude JSONL adapter（工厂模式：每个 monitor 独立实例，无共享状态）。
 *
 * 仅终端事件（end_turn / AskUserQuestion）携带 text；working 事件不携带文本，
 * 避免 monitor 重复累计中间消息。
 */
export const createClaudeAdapter = () => {
  let lastAssistantText: string | undefined

  const processLine = (line: unknown): TranscriptEvent | undefined => {
    if (typeof line !== "object" || line === null) return undefined

    const obj = line as Record<string, unknown>
    if (obj.type !== "assistant") return undefined

    const message = obj.message as Record<string, unknown> | undefined
    if (!message || !Array.isArray(message.content)) return undefined

    const content = message.content as Array<Record<string, unknown>>
    const stopReason = message.stop_reason as string | undefined

    // 检查 AskUserQuestion → needs_input（携带问题文本）
    for (const block of content) {
      if (block.type === "tool_use" && block.name === "AskUserQuestion") {
        const input = block.input as Record<string, unknown> | undefined
        const questions = (input?.questions as Array<Record<string, unknown>>) ?? []
        const questionText = questions.map((q) => q.question as string).filter(Boolean).join("; ")

        return { type: "needs_input", question: questionText || "Agent needs input" }
      }
    }

    // 提取本轮最终 assistant 文本（仅在终态时输出）
    const textParts = content
      .filter((block) => block.type === "text")
      .map((block) => block.text as string)
      .filter(Boolean)
    const currentText = textParts.length > 0 ? textParts.join("") : undefined

    // 始终更新最近文本（每个 assistant 消息都可能包含新内容）
    if (currentText) lastAssistantText = currentText

    // end_turn → 终态，携带最终文本
    if (stopReason === "end_turn") {
      const finalText = lastAssistantText
      lastAssistantText = undefined
      return { type: "completed", text: finalText }
    }

    // 工具回合：不携带文本，避免中间文本被累计
    if (stopReason === "tool_use") {
      return { type: "working" }
    }

    return { type: "working" }
  }

  return { processLine }
}
