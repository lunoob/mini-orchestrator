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
  /** 关闭 reader 释放文件句柄 */
  close: () => Promise<void>
}

/**
 * 创建 transcript monitor：每个 monitor 有独立的 adapter 实例（无共享状态）。
 *
 * 文本累计策略：
 * - working 事件不携带文本，仅更新内部跟踪
 * - 只有 completed / needs_input 事件携带最终文本
 * - monitor 在终态时设置（非追加）accumulatedText
 */
export const createTranscriptMonitor = (
  handle: AgentSessionHandle,
  deps: TranscriptMonitorDeps = defaultDeps(),
): TranscriptMonitor => {
  const reader: JsonlTailReader = createJsonlTailReader(handle.jsonl)
  let offset = handle.offset
  let accumulatedText = ""
  let currentStatus: AgentStatus = "working"

  // 每个 monitor 独立的 adapter 实例（无模块级共享状态）
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

    let latestEvent: TranscriptEvent | undefined

    for (const line of events) {
      if (!adapter) continue
      const event = adapter.processLine(line)
      if (!event) continue

      latestEvent = event

      // 仅终态事件设置文本（替换而非追加）
      if ((event.type === "completed" || event.type === "needs_input") && event.text) {
        accumulatedText = event.text
      }

      // needs_input 优先于 completed
      if (event.type === "needs_input") {
        currentStatus = "needs_input"
      } else if (event.type === "failed") {
        currentStatus = "failed"
      } else if (event.type === "completed" && currentStatus !== "needs_input") {
        currentStatus = "completed"
      } else if (event.type === "working" && currentStatus !== "needs_input") {
        currentStatus = "working"
      }
    }

    return latestEvent
  }

  return {
    close: async () => { await reader.close() },
    getAccumulatedText: () => accumulatedText,
    getOffset: () => offset,
    getStatus: () => currentStatus,
    poll,
  }
}
