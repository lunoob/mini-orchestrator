import { describe, expect, test, vi } from "vitest"

import { createCodexAdapter, type CodexTransport } from "@src/session/adapters/codex"
import type { AdapterEvent } from "@src/session/adapters/types"

const makeTransport = () => {
  const notifications: Array<(notification: { method: string; params: Record<string, unknown> }) => void> = []
  const request = vi.fn(async (method: string) => method === "thread/start" ? { thread: { id: "thread-1" } } : {})
  const transport: CodexTransport = {
    close: vi.fn(async () => undefined),
    onNotification: (listener) => {
      notifications.push(listener)
      return () => undefined
    },
    request,
    start: vi.fn(async () => undefined),
  }
  return { notifications, request, transport }
}

describe("CodexAdapter activity mapping", () => {
  test("maps commandExecution item lifecycle", async () => {
    const { notifications, transport } = makeTransport()
    const emitted: AdapterEvent[] = []
    const adapter = createCodexAdapter({
      agent: { agent: "codex", command: "codex", name: "codex" },
      cwd: "/tmp/project",
      emit: event => { emitted.push(event as AdapterEvent) },
      transport,
    })

    await adapter.start()
    await adapter.sendMessage({ content: "prompt", turnId: "turn-1" })

    // commandExecution started — only shows "exec bash", not the full command
    notifications[0]({
      method: "item/started",
      params: {
        item: { command: "bash -c 'curl -H \"Authorization: Bearer sk-secret\" https://api.example.com'", id: "cmd-1", type: "commandExecution" },
        threadId: "thread-1",
        turnId: "codex-turn-1",
      },
    })

    // commandExecution completed
    notifications[0]({
      method: "item/completed",
      params: {
        item: { command: "bash -c 'curl ...'", id: "cmd-1", status: "completed", type: "commandExecution" },
        threadId: "thread-1",
        turnId: "codex-turn-1",
      },
    })

    notifications[0]({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "codex-turn-1", status: "completed" } },
    })
    await adapter.flush()

    const activityEvents = emitted.filter(e => e.type === "activity")
    expect(activityEvents).toEqual([
      {
        data: { activity: { kind: "tool_started", label: "exec bash", turnId: "turn-1" }, turnId: "turn-1" },
        type: "activity",
      },
      {
        data: { activity: { kind: "tool_completed", label: "exec bash", turnId: "turn-1" }, turnId: "turn-1" },
        type: "activity",
      },
    ])
  })

  test("maps fileChange item with safe path label", async () => {
    const { notifications, transport } = makeTransport()
    const emitted: AdapterEvent[] = []
    const adapter = createCodexAdapter({
      agent: { agent: "codex", command: "codex", name: "codex" },
      cwd: "/tmp/project",
      emit: event => { emitted.push(event as AdapterEvent) },
      transport,
    })

    await adapter.start()
    await adapter.sendMessage({ content: "prompt", turnId: "turn-1" })

    notifications[0]({
      method: "item/started",
      params: {
        item: { id: "fc-1", path: "src/index.ts", type: "fileChange" },
        threadId: "thread-1",
        turnId: "codex-turn-1",
      },
    })

    notifications[0]({
      method: "item/completed",
      params: {
        item: { id: "fc-1", path: "src/index.ts", status: "completed", type: "fileChange" },
        threadId: "thread-1",
        turnId: "codex-turn-1",
      },
    })

    notifications[0]({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "codex-turn-1", status: "completed" } },
    })
    await adapter.flush()

    const activityEvents = emitted.filter(e => e.type === "activity")
    expect(activityEvents).toEqual([
      {
        data: { activity: { kind: "tool_started", label: "fileChange src/index.ts", turnId: "turn-1" }, turnId: "turn-1" },
        type: "activity",
      },
      {
        data: { activity: { kind: "tool_completed", label: "fileChange src/index.ts", turnId: "turn-1" }, turnId: "turn-1" },
        type: "activity",
      },
    ])
  })

  test("maps mcpToolCall item with tool name", async () => {
    const { notifications, transport } = makeTransport()
    const emitted: AdapterEvent[] = []
    const adapter = createCodexAdapter({
      agent: { agent: "codex", command: "codex", name: "codex" },
      cwd: "/tmp/project",
      emit: event => { emitted.push(event as AdapterEvent) },
      transport,
    })

    await adapter.start()
    await adapter.sendMessage({ content: "prompt", turnId: "turn-1" })

    notifications[0]({
      method: "item/started",
      params: {
        item: { id: "mcp-1", name: "github", toolName: "create_pr", type: "mcpToolCall" },
        threadId: "thread-1",
        turnId: "codex-turn-1",
      },
    })

    notifications[0]({
      method: "item/completed",
      params: {
        item: { id: "mcp-1", name: "github", status: "completed", toolName: "create_pr", type: "mcpToolCall" },
        threadId: "thread-1",
        turnId: "codex-turn-1",
      },
    })
    await adapter.flush()

    const activityEvents = emitted.filter(e => e.type === "activity")
    expect(activityEvents).toEqual([
      {
        data: { activity: { kind: "tool_started", label: "mcp:create_pr", turnId: "turn-1" }, turnId: "turn-1" },
        type: "activity",
      },
      {
        data: { activity: { kind: "tool_completed", label: "mcp:create_pr", turnId: "turn-1" }, turnId: "turn-1" },
        type: "activity",
      },
    ])
  })

  test("preserves failed tool detail with length limit", async () => {
    const { notifications, transport } = makeTransport()
    const emitted: AdapterEvent[] = []
    const adapter = createCodexAdapter({
      agent: { agent: "codex", command: "codex", name: "codex" },
      cwd: "/tmp/project",
      emit: event => { emitted.push(event as AdapterEvent) },
      transport,
    })

    await adapter.start()
    await adapter.sendMessage({ content: "prompt", turnId: "turn-1" })

    // Very long error message should be truncated
    const longError = "x".repeat(200)
    notifications[0]({
      method: "item/completed",
      params: {
        item: { command: "bash", error: longError, id: "cmd-1", status: "failed", type: "commandExecution" },
        threadId: "thread-1",
        turnId: "codex-turn-1",
      },
    })

    notifications[0]({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { error: { message: longError }, id: "codex-turn-1", status: "failed" },
      },
    })
    await adapter.flush()

    const activityEvents = emitted.filter(e => e.type === "activity")
    expect(activityEvents).toHaveLength(1)
    // Detail should be truncated to120 chars
    expect(activityEvents[0].data.activity.detail).toHaveLength(120)

    const turnFailed = emitted.filter(e => e.type === "turn.failed")
    expect(turnFailed).toHaveLength(1)
    // Reason should be truncated to120 chars
    const failedData = turnFailed[0].data as Record<string, string>
    expect(failedData.reason).toHaveLength(120)
  })

  test("ignores unknown notifications without breaking adapter", async () => {
    const { notifications, transport } = makeTransport()
    const emitted: AdapterEvent[] = []
    const adapter = createCodexAdapter({
      agent: { agent: "codex", command: "codex", name: "codex" },
      cwd: "/tmp/project",
      emit: event => { emitted.push(event as AdapterEvent) },
      transport,
    })

    await adapter.start()
    await adapter.sendMessage({ content: "prompt", turnId: "turn-1" })

    // Unknown notification — should be silently ignored
    notifications[0]({
      method: "unknown/method",
      params: { someField: "value", threadId: "thread-1", turnId: "codex-turn-1" },
    })

    // Normal turn completion should still work
    notifications[0]({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "codex-turn-1", status: "completed" } },
    })
    await adapter.flush()

    const turnEvents = emitted.filter(e => e.type === "turn.completed")
    expect(turnEvents).toHaveLength(1)
  })

  test("sanitizes control characters in label", async () => {
    const { notifications, transport } = makeTransport()
    const emitted: AdapterEvent[] = []
    const adapter = createCodexAdapter({
      agent: { agent: "codex", command: "codex", name: "codex" },
      cwd: "/tmp/project",
      emit: event => { emitted.push(event as AdapterEvent) },
      transport,
    })

    await adapter.start()
    await adapter.sendMessage({ content: "prompt", turnId: "turn-1" })

    // fileChange with control chars in path
    notifications[0]({
      method: "item/started",
      params: {
        item: { id: "fc-1", path: "src/\x00\x01index.ts", type: "fileChange" },
        threadId: "thread-1",
        turnId: "codex-turn-1",
      },
    })
    await adapter.flush()

    const activityEvents = emitted.filter(e => e.type === "activity")
    expect(activityEvents[0].data.activity.label).toBe("fileChange src/index.ts")
  })
})
