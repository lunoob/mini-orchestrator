import { describe, expect, test, vi } from "vitest"

import { createCursorAdapter, type CursorTransport } from "@src/session/adapters/cursor"
import type { AdapterEvent } from "@src/session/adapters/types"

type MockCursorTransport = CursorTransport & { emit: (event: Record<string, unknown>) => void }

const makeCursorTransport = (): MockCursorTransport => {
  const listeners: Array<(event: Record<string, unknown>) => void> = []
  return {
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    emit: (event: Record<string, unknown>) => { for (const l of listeners) l(event) },
    onEvent: vi.fn((listener: (event: Record<string, unknown>) => void) => {
      listeners.push(listener)
      return () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1) }
    }) as unknown as CursorTransport["onEvent"],
    send: vi.fn(async () => ({ turnId: "cursor-raw-1" })),
    start: vi.fn(async () => undefined),
  } as unknown as MockCursorTransport
}

describe("CursorAdapter activity mapping", () => {
  /** Wait for adapter's async event processing queue to drain */
  const waitForAsync = () => new Promise<void>(r => setTimeout(r, 50))

  test("maps tool_call.started to tool_started activity", async () => {
    const transport = makeCursorTransport()
    const emitted: AdapterEvent[] = []
    const adapter = createCursorAdapter({
      agent: { agent: "cursor", command: "cursor-agent", name: "cursor" },
      cwd: "/tmp/project",
      transport,
    })
    adapter.onEvent(e => emitted.push(e))

    await adapter.start()
    await adapter.deliverMessage({ content: "prompt", turnId: "turn-1" })

    // Simulate Cursor stream-json tool_call.started event
    transport.emit({
      activity: { kind: "tool_started", label: "Read src/file.ts" },
      turnId: "cursor-raw-1",
    })
    await waitForAsync()

    expect(emitted).toEqual([
      {
        data: { activity: { kind: "tool_started", label: "Read src/file.ts", turnId: "turn-1" }, turnId: "turn-1" },
        type: "activity",
      },
    ])
  })

  test("maps tool_call.completed to tool_completed activity", async () => {
    const transport = makeCursorTransport()
    const emitted: AdapterEvent[] = []
    const adapter = createCursorAdapter({
      agent: { agent: "cursor", command: "cursor-agent", name: "cursor" },
      cwd: "/tmp/project",
      transport,
    })
    adapter.onEvent(e => emitted.push(e))

    await adapter.start()
    await adapter.deliverMessage({ content: "prompt", turnId: "turn-1" })

    transport.emit({
      activity: { kind: "tool_completed", label: "Write output.md" },
      turnId: "cursor-raw-1",
    })
    await waitForAsync()

    expect(emitted).toEqual([
      {
        data: { activity: { kind: "tool_completed", label: "Write output.md", turnId: "turn-1" }, turnId: "turn-1" },
        type: "activity",
      },
    ])
  })

  test("preserves text delta alongside activity events", async () => {
    const transport = makeCursorTransport()
    const emitted: AdapterEvent[] = []
    const adapter = createCursorAdapter({
      agent: { agent: "cursor", command: "cursor-agent", name: "cursor" },
      cwd: "/tmp/project",
      transport,
    })
    adapter.onEvent(e => emitted.push(e))

    await adapter.start()
    await adapter.deliverMessage({ content: "prompt", turnId: "turn-1" })

    transport.emit({ text: "hello", turnId: "cursor-raw-1" })
    await waitForAsync()
    transport.emit({
      activity: { kind: "tool_started", label: "Bash ls" },
      turnId: "cursor-raw-1",
    })
    await waitForAsync()
    transport.emit({ text: " world", turnId: "cursor-raw-1" })
    await waitForAsync()
    transport.emit({ done: true, turnId: "cursor-raw-1" })
    await waitForAsync()

    expect(emitted).toEqual([
      { data: { delta: "hello", turnId: "turn-1" }, type: "output_text.delta" },
      { data: { activity: { kind: "tool_started", label: "Bash ls", turnId: "turn-1" }, turnId: "turn-1" }, type: "activity" },
      { data: { delta: " world", turnId: "turn-1" }, type: "output_text.delta" },
      { data: { turnId: "turn-1" }, type: "turn.completed" },
    ])
  })

  test("ignores unknown event fields without breaking adapter", async () => {
    const transport = makeCursorTransport()
    const emitted: AdapterEvent[] = []
    const adapter = createCursorAdapter({
      agent: { agent: "cursor", command: "cursor-agent", name: "cursor" },
      cwd: "/tmp/project",
      transport,
    })
    adapter.onEvent(e => emitted.push(e))

    await adapter.start()
    await adapter.deliverMessage({ content: "prompt", turnId: "turn-1" })

    // Unknown event shape — should be silently ignored
    transport.emit({ unknownField: "something", turnId: "cursor-raw-1" })
    await waitForAsync()
    // Normal events should still work after unknown event
    transport.emit({ done: true, turnId: "cursor-raw-1" })
    await waitForAsync()

    expect(emitted).toEqual([
      { data: { turnId: "turn-1" }, type: "turn.completed" },
    ])
  })

  test("Cursor thinking events are NOT emitted as activity", async () => {
    const transport = makeCursorTransport()
    const emitted: AdapterEvent[] = []
    const adapter = createCursorAdapter({
      agent: { agent: "cursor", command: "cursor-agent", name: "cursor" },
      cwd: "/tmp/project",
      transport,
    })
    adapter.onEvent(e => emitted.push(e))

    await adapter.start()
    await adapter.deliverMessage({ content: "prompt", turnId: "turn-1" })

    // Cursor thinking should NOT produce any event
    transport.emit({ thinking: "internal reasoning", turnId: "cursor-raw-1" })
    await waitForAsync()
    transport.emit({ done: true, turnId: "cursor-raw-1" })
    await waitForAsync()

    expect(emitted).toEqual([
      { data: { turnId: "turn-1" }, type: "turn.completed" },
    ])
  })
})
