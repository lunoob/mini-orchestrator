import { describe, expect, test } from "vitest"

const storeModulePath = "./store.js"
const runDirectory = "/tmp/mini-orch-store-tests"
const agent = {
  agent: "codex",
  command: "codex",
  integrationAgent: "codex",
  name: "codex",
}

describe("SessionStore edge cases", () => {
  test("moves a session directly to stopped on a stop control event", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("./store.js")
    const store = createSessionStore()
    store.create({ agent, id: "session-1", role: "implementer", runDirectory, workspace: "/tmp/project" })
    store.markReady("session-1")

    const ack = store.applyEvent({ event: { eventId: "stop-1", type: "stop" }, sessionId: "session-1" })

    expect(ack).toEqual({ eventId: "stop-1", queued: false })
    expect(store.get("session-1")).toMatchObject({ runnerStatus: "stopped", status: "stopped" })
  })

  test("does not finish a turn until the runner reports turn.interrupted", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("./store.js")
    const store = createSessionStore({ createId: () => "turn-1" })
    store.create({ agent, id: "session-1", role: "implementer", runDirectory, workspace: "/tmp/project" })
    const events: unknown[] = []
    const unsubscribe = store.subscribe("session-1", event => events.push(event))
    const { turnId } = store.submitMessage({ content: "prompt", eventId: "event-1", sessionId: "session-1" })

    store.applyEvent({ event: { eventId: "interrupt-1", type: "interrupt" }, sessionId: "session-1" })

    expect(store.getTurn("session-1", turnId)).toMatchObject({ status: "running" })
    expect(events).toContainEqual(expect.objectContaining({ data: { turnId }, type: "session.interrupt" }))
    unsubscribe()
  })

  test("persists an empty assistant output when a turn completes", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("./store.js")
    const store = createSessionStore({ createId: () => "turn-empty" })
    store.create({ agent, id: "session-1", role: "implementer", runDirectory, workspace: "/tmp/project" })
    const { turnId } = store.submitMessage({ content: "prompt", eventId: "event-empty", sessionId: "session-1" })

    store.completeTurn({ content: "", sessionId: "session-1", turnId })

    expect(store.getItems("session-1")).toContainEqual(expect.objectContaining({ content: "", role: "assistant", turnId }))
  })

  test("returns persisted items in created-at order after restoring a snapshot", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("./store.js")
    const store = createSessionStore({
      snapshot: {
        items: {
          "session-1": [
            { content: "later", createdAt: "2026-01-02T00:00:00.000Z", id: "item-2", role: "assistant", turnId: "turn-1" },
            { content: "earlier", createdAt: "2026-01-01T00:00:00.000Z", id: "item-1", role: "user", turnId: "turn-1" },
          ],
        },
        sequence: 0,
        sessions: [{ agent, createdAt: "2026-01-01T00:00:00.000Z", id: "session-1", role: "implementer", runnerReady: false, runnerStatus: "starting", runDirectory, status: "starting", turns: [], workspace: "/tmp/project" }],
        submittedEvents: [],
      },
    })

    expect(store.getItems("session-1").map(item => item.content)).toEqual(["earlier", "later"])
  })
})
