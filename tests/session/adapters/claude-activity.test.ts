import { describe, expect, test, vi } from "vitest"

import { createClaudeAdapter, type ClaudeTransport } from "@src/session/adapters/claude"
import type { AdapterEvent } from "@src/session/adapters/types"

type MockClaudeTransport = ClaudeTransport & { emit: (event: Record<string, unknown>) => void }

const makeClaudeTransport = (): MockClaudeTransport => {
  const listeners: Array<(event: Record<string, unknown>) => void> = []
  return {
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    emit: (event: Record<string, unknown>) => { for (const l of listeners) l(event) },
    onEvent: vi.fn((listener: (event: Record<string, unknown>) => void) => {
      listeners.push(listener)
      return () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1) }
    }) as unknown as ClaudeTransport["onEvent"],
    send: vi.fn(async () => ({ turnId: "claude-raw-1" })),
    start: vi.fn(async () => undefined),
  } as unknown as MockClaudeTransport
}

describe("ClaudeAdapter activity behavior", () => {
  /** Wait for adapter's async event processing queue to drain */
  const waitForAsync = () => new Promise<void>(r => setTimeout(r, 50))

  test("does not emit activity events from text or result events", async () => {
    const transport = makeClaudeTransport()
    const emitted: AdapterEvent[] = []
    const adapter = createClaudeAdapter({
      agent: { agent: "claude", command: "claude", name: "claude" },
      cwd: "/tmp/project",
      transport,
    })
    adapter.onEvent(e => emitted.push(e))

    await adapter.start()
    await adapter.deliverMessage({ content: "prompt", turnId: "turn-1" })

    // Claude transport emits text and done events — no activity
    transport.emit({ text: "hello", turnId: "claude-raw-1" })
    await waitForAsync()
    transport.emit({ done: true, turnId: "claude-raw-1" })
    await waitForAsync()

    const activityEvents = emitted.filter(e => e.type === "activity")
    expect(activityEvents).toEqual([])
    expect(emitted).toEqual([
      { data: { delta: "hello", turnId: "turn-1" }, type: "output_text.delta" },
      { data: { turnId: "turn-1" }, type: "turn.completed" },
    ])
  })

  test("unknown fields in raw events are safely ignored", async () => {
    const transport = makeClaudeTransport()
    const emitted: AdapterEvent[] = []
    const adapter = createClaudeAdapter({
      agent: { agent: "claude", command: "claude", name: "claude" },
      cwd: "/tmp/project",
      transport,
    })
    adapter.onEvent(e => emitted.push(e))

    await adapter.start()
    await adapter.deliverMessage({ content: "prompt", turnId: "turn-1" })

    // Unknown fields should be safely ignored
    transport.emit({ tool_call: { name: "read", status: "started" }, turnId: "claude-raw-1" })
    await waitForAsync()
    // Normal events should still work
    transport.emit({ done: true, turnId: "claude-raw-1" })
    await waitForAsync()

    expect(emitted).toEqual([
      { data: { turnId: "turn-1" }, type: "turn.completed" },
    ])
  })
})
