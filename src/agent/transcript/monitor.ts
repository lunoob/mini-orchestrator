import { createJsonlTailReader, type JsonlTailReader } from "./tail-reader.js"
import { createClaudeAdapter } from "./claude.js"
import { createCodexAdapter } from "./codex.js"
import { createCursorAdapter } from "./cursor.js"
import type { AgentSessionHandle, AgentStatus, TranscriptEvent } from "./types.js"

export type TranscriptMonitorDeps = {
  pollIntervalMs: number
  sleep: (ms: number) => Promise<void>
}

const defaultDeps = (): TranscriptMonitorDeps => ({
  pollIntervalMs: 10_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})

export type TranscriptMonitor = {
  getAccumulatedText: () => string
  getStatus: () => AgentStatus
  poll: () => Promise<TranscriptEvent | undefined>
  getOffset: () => number
  close: () => Promise<void>
}

/** 终态优先级：needs_input > failed > completed */
const TERMINAL_PRIORITY: Record<string, number> = { needs_input: 3, failed: 2, completed: 1 }

/**
 * 创建 transcript monitor。
 *
 * 批次处理策略：
 * - 按优先级（needs_input > failed > completed）在同批中选出最佳终态事件
 * - 即使 completed 先出现，后出现的 needs_input 也会覆盖它
 * - 优先级更高的终态事件不会被较低优先级覆盖
 */
export const createTranscriptMonitor = (
  handle: AgentSessionHandle,
  deps: TranscriptMonitorDeps = defaultDeps(),
): TranscriptMonitor => {
  const reader: JsonlTailReader = createJsonlTailReader(handle.jsonl)
  let offset = handle.offset
  let accumulatedText = ""
  let currentStatus: AgentStatus = "working"

  const adapter = (() => {
    switch (handle.provider) {
      case "claude": return createClaudeAdapter()
      case "codex": return createCodexAdapter()
      case "cursor": return createCursorAdapter()
      default: return undefined
    }
  })()

  const poll = async (): Promise<TranscriptEvent | undefined> => {
    const { events, nextOffset } = await reader.readNewLines(offset)
    offset = nextOffset

    if (events.length === 0) return undefined

    let bestTerminalEvent: TranscriptEvent | undefined
    let bestPriority = 0
    let lastEvent: TranscriptEvent | undefined
    let seenTerminal = false

    for (const line of events) {
      if (!adapter) continue
      const event = adapter.processLine(line)
      if (!event) continue

      lastEvent = event
      const p = TERMINAL_PRIORITY[event.type] ?? 0

      if (p > 0) {
        seenTerminal = true
        // 按优先级保存最佳终态事件（同优先级保留先出现的）
        if (p > bestPriority) {
          bestTerminalEvent = event
          bestPriority = p
        }
        if (event.text) accumulatedText = event.text

        // 状态由最高优先级决定
        if ((currentStatus as string) === "needs_input") continue // needs_input 不可被覆盖
        if (event.type === "needs_input") currentStatus = "needs_input"
        else if (event.type === "failed") currentStatus = "failed"
        else if (currentStatus !== "needs_input" && currentStatus !== "failed") currentStatus = "completed"
      } else if (!seenTerminal) {
        currentStatus = "working"
      }
    }

    return bestTerminalEvent ?? lastEvent
  }

  return {
    close: async () => { await reader.close() },
    getAccumulatedText: () => accumulatedText,
    getOffset: () => offset,
    getStatus: () => currentStatus,
    poll,
  }
}
