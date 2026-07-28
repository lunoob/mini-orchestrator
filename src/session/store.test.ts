import { describe, expect, test } from "vitest"

const storeModulePath = "./store.js"
const runDirectory = "/tmp/mini-orch-store-tests"
const agent = {
  agent: "codex",
  command: "codex",
  integrationAgent: "codex",
  name: "codex",
}

describe("SessionStore", () => {
  test("creates a starting session with its agent launch metadata", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("./store.js")
    const store = createSessionStore()

    const session = store.create({
      agent,
      id: "session-1",
      role: "implementer",
      runDirectory,
      workspace: "/tmp/project",
    })

    expect(session).toMatchObject({
      agent,
      id: "session-1",
      role: "implementer",
      status: "starting",
      workspace: "/tmp/project",
    })
    expect(session.createdAt).toEqual(expect.any(String))
  })

  test("keeps a retried message event bound to one turn and one input item", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("./store.js")
    const store = createSessionStore({ createId: () => "turn-1" })
    store.create({
      agent,
      id: "session-1",
      role: "implementer",
      runDirectory,
      workspace: "/tmp/project",
    })

    const first = store.submitMessage({
      content: "Implement the feature",
      eventId: "event-1",
      sessionId: "session-1",
    })
    const replay = store.submitMessage({
      content: "Implement the feature",
      eventId: "event-1",
      sessionId: "session-1",
    })

    expect(first).toEqual({ queued: true, turnId: "turn-1" })
    expect(replay).toEqual(first)
    expect(store.getItems("session-1")).toEqual([
      expect.objectContaining({
        content: "Implement the feature",
        eventId: "event-1",
        role: "user",
        turnId: "turn-1",
      }),
    ])
  })

  test("persists a completed turn output and returns the session to ready", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("./store.js")
    const store = createSessionStore({ createId: () => "turn-1" })
    store.create({
      agent,
      id: "session-1",
      role: "implementer",
      runDirectory,
      workspace: "/tmp/project",
    })
    store.markReady("session-1")
    const { turnId } = store.submitMessage({
      content: "Implement the feature",
      eventId: "event-1",
      sessionId: "session-1",
    })

    store.completeTurn({
      content: "Feature implemented",
      sessionId: "session-1",
      turnId,
    })

    expect(store.get("session-1")).toMatchObject({
      activeTurnId: undefined,
      status: "ready",
    })
    expect(store.getItems("session-1")).toContainEqual(expect.objectContaining({
      content: "Feature implemented",
      role: "assistant",
      turnId,
    }))
  })

  test("publishes status changes to live session subscribers", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("./store.js")
    const store = createSessionStore({ createId: () => "turn-1" })
    store.create({
      agent,
      id: "session-1",
      role: "implementer",
      runDirectory,
      workspace: "/tmp/project",
    })
    const events: unknown[] = []
    const unsubscribe = store.subscribe("session-1", event => events.push(event))

    store.markReady("session-1")
    store.submitMessage({
      content: "Implement the feature",
      eventId: "event-1",
      sessionId: "session-1",
    })

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "ready", type: "session.status" }),
      expect.objectContaining({ status: "running", type: "session.status" }),
    ]))
    unsubscribe()
  })

  test("restores sessions, items and submitted event deduplication from a snapshot", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("./store.js")
    const store = createSessionStore({ createId: () => "turn-1" })
    store.create({
      agent,
      id: "session-1",
      role: "implementer",
      runDirectory,
      workspace: "/tmp/project",
    })
    store.submitMessage({
      content: "Implement the feature",
      eventId: "event-1",
      sessionId: "session-1",
    })

    const restored = createSessionStore({
      createId: () => "unexpected-turn",
      snapshot: store.snapshot(),
    })

    expect(restored.get("session-1")).toMatchObject({
      activeTurnId: "turn-1",
      status: "running",
    })
    expect(restored.getItems("session-1")).toHaveLength(1)
    expect(restored.submitMessage({
      content: "Implement the feature",
      eventId: "event-1",
      sessionId: "session-1",
    })).toEqual({ queued: true, turnId: "turn-1" })
  })

  test("keeps separate terminal state for consecutive turns", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("./store.js")
    const ids = ["turn-1", "turn-2"]
    const store = createSessionStore({ createId: () => ids.shift() ?? "unexpected" })
    store.create({
      agent,
      id: "session-1",
      role: "implementer",
      runDirectory,
      workspace: "/tmp/project",
    })

    const first = store.submitMessage({
      content: "first",
      eventId: "event-1",
      sessionId: "session-1",
    })
    const second = store.submitMessage({
      content: "second",
      eventId: "event-2",
      sessionId: "session-1",
    })

    store.applyEvent({
      sessionId: "session-1",
      event: {
        data: { content: "second output", turnId: second.turnId },
        type: "turn.completed",
      },
    })

    expect(store.getTurn("session-1", first.turnId)).toMatchObject({ status: "running" })
    expect(store.getTurn("session-1", second.turnId)).toMatchObject({ status: "completed" })
    expect(store.getItems("session-1")).not.toContainEqual(
      expect.objectContaining({ content: "second output", turnId: first.turnId }),
    )
  })

  test("advances persisted event sequence even without a live subscriber", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("./store.js")
    const store = createSessionStore()
    store.create({
      agent,
      id: "session-1",
      role: "implementer",
      runDirectory,
      workspace: "/tmp/project",
    })

    store.submitMessage({
      content: "first",
      eventId: "event-1",
      sessionId: "session-1",
    })

    const events: unknown[] = []
    const unsubscribe = store.subscribe("session-1", event => events.push(event))
    store.markReady("session-1")

    expect(store.snapshot().sequence).toBeGreaterThan(0)
    expect(events[0]).toEqual(expect.objectContaining({ sequence: 3 }))
    unsubscribe()
  })

  test("finishes a turn through failed and interrupted terminal events", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("./store.js")
    const ids = ["turn-failed", "turn-interrupted"]
    const store = createSessionStore({ createId: () => ids.shift() ?? "unexpected" })
    store.create({
      agent,
      id: "session-1",
      role: "implementer",
      runDirectory,
      workspace: "/tmp/project",
    })

    const failed = store.submitMessage({ content: "fail", eventId: "event-1", sessionId: "session-1" })
    store.applyEvent({
      sessionId: "session-1",
      event: { data: { reason: "runner crashed", turnId: failed.turnId }, type: "turn.failed" },
    })
    expect(store.get("session-1")).toMatchObject({ lastError: "runner crashed", status: "failed" })
    expect(() => store.submitMessage({
      content: "blocked",
      eventId: "event-2",
      sessionId: "session-1",
    })).toThrow("Session is not accepting messages: failed")

    store.create({
      agent,
      id: "session-2",
      role: "implementer",
      runDirectory,
      workspace: "/tmp/project",
    })
    const interrupted = store.submitMessage({ content: "interrupt", eventId: "event-3", sessionId: "session-2" })
    store.applyEvent({
      sessionId: "session-2",
      event: { data: { turnId: interrupted.turnId }, type: "turn.interrupted" },
    })

    expect(store.getTurn("session-1", failed.turnId)).toMatchObject({
      error: "runner crashed",
      status: "failed",
    })
    expect(store.getTurn("session-2", interrupted.turnId)).toMatchObject({ status: "interrupted" })
  })

})
