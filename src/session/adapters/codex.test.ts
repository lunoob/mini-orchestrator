import { describe, expect, test, vi } from "vitest"

import { createCodexAdapter, type CodexTransport } from "./codex.js"

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

describe("CodexAdapter", () => {
  test("delivers each turn once and converts structured Codex notifications to Session events", async () => {
    const { notifications, request, transport } = makeTransport()
    const emit = vi.fn()
    const adapter = createCodexAdapter({
      agent: { agent: "codex", command: "codex --model gpt-5", name: "codex" },
      cwd: "/tmp/project",
      emit,
      transport,
    })

    await adapter.start()
    await adapter.sendMessage({ content: "first prompt", turnId: "turn-1" })
    await adapter.sendMessage({ content: "first prompt", turnId: "turn-1" })
    notifications[0]({
      method: "item/agentMessage/delta",
      params: { delta: "hello", itemId: "item-1", threadId: "thread-1", turnId: "codex-turn-1" },
    })
    notifications[0]({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "codex-turn-1", status: "completed" } },
    })
    await adapter.flush()

    expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      input: [{ text: "first prompt", type: "text" }],
      threadId: "thread-1",
    }))
    expect(request).toHaveBeenCalledTimes(3)
    expect(emit).toHaveBeenCalledWith({ data: { delta: "hello", turnId: "turn-1" }, type: "output_text.delta" })
    expect(emit).toHaveBeenCalledWith({ data: { turnId: "turn-1" }, type: "turn.completed" })
  })

  test("interrupts the matching Codex turn and reports transport failures", async () => {
    const { request, transport } = makeTransport()
    const emit = vi.fn()
    const adapter = createCodexAdapter({
      agent: { agent: "codex", command: "codex", name: "codex" },
      cwd: "/tmp/project",
      emit,
      transport,
    })

    await adapter.start()
    await adapter.sendMessage({ content: "long prompt", turnId: "turn-2" })
    await adapter.interrupt("turn-2")
    expect(request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "thread-1",
      turnId: "codex-turn-2",
    })

    const failing = makeTransport()
    failing.transport.start = vi.fn(async () => { throw new Error("codex unavailable") })
    const failingAdapter = createCodexAdapter({
      agent: { agent: "codex", command: "codex", name: "codex" },
      cwd: "/tmp/project",
      emit,
      transport: failing.transport,
    })
    await expect(failingAdapter.start()).rejects.toThrow("codex unavailable")
  })

  test("waits for asynchronous output acknowledgement before reporting completion", async () => {
    const { notifications, transport } = makeTransport()
    let releaseDelta: (() => void) | undefined
    const deltaSent = new Promise<void>(resolve => { releaseDelta = resolve })
    const started: string[] = []
    const finished: string[] = []
    const emit = vi.fn(async (event: { type: string }) => {
      started.push(event.type)
      if (event.type === "output_text.delta") await deltaSent
      finished.push(event.type)
    })
    const adapter = createCodexAdapter({
      agent: { agent: "codex", command: "codex", name: "codex" },
      cwd: "/tmp/project",
      emit,
      transport,
    })

    await adapter.start()
    await adapter.sendMessage({ content: "prompt", turnId: "turn-ordered" })
    notifications[0]({
      method: "item/agentMessage/delta",
      params: { delta: "partial", itemId: "item-1", threadId: "thread-1", turnId: "codex-turn-ordered" },
    })
    notifications[0]({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "codex-turn-ordered", status: "completed" } },
    })
    await expect.poll(() => started.length).toBe(1)
    expect(started).toEqual(["output_text.delta"])
    expect(finished).toEqual([])

    releaseDelta?.()
    await adapter.flush()
    expect(started).toEqual(["output_text.delta", "turn.completed"])
    expect(finished).toEqual(["output_text.delta", "turn.completed"])
  })
})
