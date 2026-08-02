import { describe, expect, it, vi } from "vitest"
import { writeFile } from "node:fs/promises"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { createTranscriptMonitor, type TranscriptMonitorDeps } from "./monitor.js"
import type { AgentSessionHandle } from "./types.js"

const tmpFile = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mini-orch-monitor-"))
  return path.join(dir, "session.jsonl")
}

const claudeWorkingLine = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "Working..." }], stop_reason: "tool_use" },
})

const claudeCompletedLine = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "STATUS: IMPLEMENT_DONE\nDone." }], stop_reason: "end_turn" },
})

const claudeAskLine = JSON.stringify({
  type: "assistant",
  message: {
    content: [{
      type: "tool_use",
      name: "AskUserQuestion",
      input: { questions: [{ question: "Which way?", header: "Dir", options: [] }] },
    }],
    stop_reason: "tool_use",
  },
})

const writeJsonl = async (filePath: string, lines: string[]) => {
  await writeFile(filePath, lines.join("\n") + "\n", "utf8")
}

const mockDeps = (overrides: Partial<TranscriptMonitorDeps> = {}): TranscriptMonitorDeps => ({
  pollIntervalMs: 10,
  sleep: vi.fn().mockResolvedValue(undefined),
  ...overrides,
})

describe("createTranscriptMonitor", () => {
  it("returns initial state before first poll", () => {
    const handle: AgentSessionHandle = { provider: "claude", resumeId: "abc", jsonl: "/tmp/test.jsonl", offset: 0 }
    const monitor = createTranscriptMonitor(handle, mockDeps())

    expect(monitor.getStatus()).toBe("working")
    expect(monitor.getAccumulatedText()).toBe("")
  })

  it("polls JSONL and updates state to completed", async () => {
    const filePath = tmpFile()
    await writeJsonl(filePath, [claudeWorkingLine])

    const handle: AgentSessionHandle = { provider: "claude", resumeId: "abc", jsonl: filePath, offset: 0 }
    const monitor = createTranscriptMonitor(handle, mockDeps())

    // 首次 poll 读取 working 事件
    const event1 = await monitor.poll()
    expect(event1).not.toBeUndefined()
    expect(event1!.type).toBe("working")

    // 追加完成行
    await writeJsonl(filePath, [claudeWorkingLine, claudeCompletedLine])

    const event2 = await monitor.poll()
    expect(event2).not.toBeUndefined()
    expect(event2!.type).toBe("completed")
    expect(event2!.text).toContain("STATUS: IMPLEMENT_DONE")
    expect(monitor.getStatus()).toBe("completed")
  })

  it("detects needs_input from AskUserQuestion", async () => {
    const filePath = tmpFile()
    await writeJsonl(filePath, [claudeAskLine])

    const handle: AgentSessionHandle = { provider: "claude", resumeId: "abc", jsonl: filePath, offset: 0 }
    const monitor = createTranscriptMonitor(handle, mockDeps())

    const event = await monitor.poll()
    expect(event).not.toBeUndefined()
    expect(event!.type).toBe("needs_input")
    expect(event!.question).toContain("Which way?")
    expect(monitor.getStatus()).toBe("needs_input")
  })

  it("only sets text on terminal events (completed), not on intermediate working", async () => {
    const filePath = tmpFile()
    const line1 = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Part 1. " }], stop_reason: "tool_use" },
    })
    const line2 = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Part 2." }], stop_reason: "end_turn" },
    })

    await writeJsonl(filePath, [line1])

    const handle: AgentSessionHandle = { provider: "claude", resumeId: "abc", jsonl: filePath, offset: 0 }
    const monitor = createTranscriptMonitor(handle, mockDeps())

    await monitor.poll()
    // working 事件不携带文本
    expect(monitor.getAccumulatedText()).toBe("")

    // 追加终态行 → completed 事件携带最终文本
    await writeJsonl(filePath, [line1, line2])
    await monitor.poll()

    expect(monitor.getAccumulatedText()).toBe("Part 2.")
  })

  it("handles Codex provider events", async () => {
    const filePath = tmpFile()
    const startedLine = JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started" },
    })
    const completedLine = JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "STATUS: IMPLEMENT_DONE\nDone." },
    })

    await writeJsonl(filePath, [startedLine])

    const handle: AgentSessionHandle = { provider: "codex", resumeId: "xyz", jsonl: filePath, offset: 0 }
    const monitor = createTranscriptMonitor(handle, mockDeps())

    const event1 = await monitor.poll()
    expect(event1!.type).toBe("working")

    await writeJsonl(filePath, [startedLine, completedLine])
    const event2 = await monitor.poll()
    expect(event2!.type).toBe("completed")
  })

  it("handles Cursor provider events with turn_ended", async () => {
    const filePath = tmpFile()
    const workingLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Working..." }] },
    })
    const turnEndLine = JSON.stringify({ type: "turn_ended", status: "success" })

    await writeJsonl(filePath, [workingLine])

    const handle: AgentSessionHandle = { provider: "cursor", resumeId: "cur", jsonl: filePath, offset: 0 }
    const monitor = createTranscriptMonitor(handle, mockDeps())

    await monitor.poll()
    expect(monitor.getStatus()).toBe("working")

    await writeJsonl(filePath, [workingLine, turnEndLine])
    const event2 = await monitor.poll()
    expect(event2!.type).toBe("completed")
  })

  it("handles Cursor turn_ended error as failed", async () => {
    const filePath = tmpFile()
    await writeJsonl(filePath, [JSON.stringify({ type: "turn_ended", status: "error" })])

    const handle: AgentSessionHandle = { provider: "cursor", resumeId: "cur", jsonl: filePath, offset: 0 }
    const monitor = createTranscriptMonitor(handle, mockDeps())

    const event = await monitor.poll()
    expect(event!.type).toBe("failed")
  })

  it("preserves needs_input question when followed by completed in same batch", async () => {
    const filePath = tmpFile()
    // 同一批中出现 needs_input 和 completed，应保留 needs_input 的 question
    const lines = [
      claudeAskLine,
      claudeCompletedLine,
    ]

    await writeJsonl(filePath, lines)

    const handle: AgentSessionHandle = { provider: "claude", resumeId: "abc", jsonl: filePath, offset: 0 }
    const monitor = createTranscriptMonitor(handle, mockDeps())

    const event = await monitor.poll()
    expect(event).not.toBeUndefined()
    // 应返回 needs_input（首个终态事件），而非 completed
    expect(event!.type).toBe("needs_input")
    expect(event!.question).toContain("Which way?")
    // 状态应为 needs_input
    expect(monitor.getStatus()).toBe("needs_input")
  })

  it("preserves failed reason when followed by completed in same batch", async () => {
    const filePath = tmpFile()
    const claudeFailedLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "API error" }], stop_reason: "error" },
    })

    await writeJsonl(filePath, [claudeFailedLine, claudeCompletedLine])

    const handle: AgentSessionHandle = { provider: "claude", resumeId: "abc", jsonl: filePath, offset: 0 }
    const monitor = createTranscriptMonitor(handle, mockDeps())

    const event = await monitor.poll()
    expect(event!.type).toBe("failed")
    expect(event!.reason).toContain("API error")
    expect(monitor.getStatus()).toBe("failed")
  })
})
