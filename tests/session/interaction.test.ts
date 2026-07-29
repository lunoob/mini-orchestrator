import { describe, expect, test } from "vitest"

const storeModulePath = "@src/session/store"
const runDirectory = "/tmp/mini-orch-interaction-tests"
const agent = { agent: "codex", command: "codex", name: "codex" }

describe("SessionStore interaction lifecycle", () => {
  test("creates a pending interaction and puts session into waiting", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore()
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })
    store.markReady("s1")
    const { turnId } = store.submitMessage({ content: "go", eventId: "e1", sessionId: "s1" })

    const interaction = store.createInteraction({
      interactionId: "int-1",
      sessionId: "s1",
      turnId,
      role: "implementer",
      request: { question: "pick one", options: [{ id: "a", label: "A" }], allowFreeform: false },
    })

    expect(interaction).toMatchObject({
      interactionId: "int-1",
      sessionId: "s1",
      status: "pending",
    })
    expect(store.get("s1")!.status).toBe("waiting")
    expect(store.getPendingInteraction("s1")).toEqual(interaction)
  })

  test("responding resolves the interaction and restores session status", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore({ createId: () => "interaction-1" })
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })
    store.markReady("s1")
    store.submitMessage({ content: "go", eventId: "e1", sessionId: "s1" })
    store.createInteraction({
      interactionId: "int-1",
      sessionId: "s1", role: "implementer",
      request: { question: "pick", options: [{ id: "a", label: "A" }], allowFreeform: false },
    })

    const result = store.respondInteraction("s1", "int-1", { optionId: "a" })

    expect(result).toMatchObject({ optionId: "a" })
    expect(store.get("s1")!.status).not.toBe("waiting")
    expect(store.getPendingInteraction("s1")).toBeUndefined()
    expect(store.getInteraction("s1", "int-1")!.status).toBe("answered")
  })

  test("responding to a non-pending interaction returns the first result idempotently", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore({ createId: () => "interaction-1" })
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })
    store.createInteraction({
      interactionId: "int-1",
      sessionId: "s1", role: "implementer",
      request: { question: "pick", options: [{ id: "a", label: "A" }], allowFreeform: false },
    })
    store.respondInteraction("s1", "int-1", { optionId: "a" })

    const again = store.respondInteraction("s1", "int-1", { optionId: "b" })
    expect(again).toEqual({ optionId: "a" })
  })

  test("responding to an unknown interaction throws", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore()
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })

    expect(() => store.respondInteraction("s1", "missing", { text: "hi" }))
      .toThrow(/Unknown interaction/)
  })

  test("cancelling resolves the interaction and removes pending", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore({ createId: () => "interaction-1" })
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })
    store.markReady("s1")
    store.submitMessage({ content: "go", eventId: "e1", sessionId: "s1" })
    store.createInteraction({
      interactionId: "int-1",
      sessionId: "s1", role: "implementer",
      request: { question: "pick", options: [{ id: "a", label: "A" }], allowFreeform: false },
    })

    store.cancelInteraction("s1", "int-1")

    expect(store.get("s1")!.status).not.toBe("waiting")
    expect(store.getPendingInteraction("s1")).toBeUndefined()
    expect(store.getInteraction("s1", "int-1")!.status).toBe("cancelled")
  })

  test("pending interaction is included in snapshot and restored", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore({ createId: () => "interaction-1" })
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })
    store.markReady("s1")
    store.submitMessage({ content: "go", eventId: "e1", sessionId: "s1" })
    store.createInteraction({
      interactionId: "int-1",
      sessionId: "s1", role: "implementer",
      request: { question: "pick?", options: [{ id: "a", label: "A" }], allowFreeform: false },
    })

    const restored = createSessionStore({ snapshot: store.snapshot() })

    expect(restored.get("s1")!.status).toBe("waiting")
    const pending = restored.getPendingInteraction("s1")
    expect(pending).toMatchObject({
      interactionId: "int-1",
      status: "pending",
      request: expect.objectContaining({ question: "pick?" }),
    })
  })

  test("publishes interaction SSE events to subscribers", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore({ createId: () => "interaction-1" })
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })
    const events: unknown[] = []
    store.subscribe("s1", e => events.push(e))

    store.createInteraction({
      interactionId: "int-1",
      sessionId: "s1", role: "implementer",
      request: { question: "q", options: [{ id: "a", label: "A" }], allowFreeform: false },
    })
    store.respondInteraction("s1", "int-1", { optionId: "a" })

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "interaction.request" }),
      expect.objectContaining({ type: "interaction.response" }),
    ]))
  })

  test("blocks submitMessage while interaction is pending", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore()
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })
    store.markReady("s1")
    store.submitMessage({ content: "go", eventId: "e1", sessionId: "s1" })
    store.createInteraction({
      interactionId: "int-1",
      sessionId: "s1", role: "implementer",
      request: { question: "q", options: [{ id: "a", label: "A" }], allowFreeform: false },
    })

    expect(() => store.submitMessage({ content: "new", eventId: "e2", sessionId: "s1" }))
      .toThrow(/waiting/)
  })

  test("rejects duplicate interactionId", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore()
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })
    store.createInteraction({
      interactionId: "int-1",
      sessionId: "s1", role: "implementer",
      request: { question: "q", options: [{ id: "a", label: "A" }], allowFreeform: false },
    })

    expect(() => store.createInteraction({
      interactionId: "int-1",
      sessionId: "s1", role: "implementer",
      request: { question: "q2", options: [{ id: "b", label: "B" }], allowFreeform: false },
    })).toThrow(/Duplicate interactionId/)
  })

  test("responding to a cancelled interaction throws", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore()
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })
    store.createInteraction({
      interactionId: "int-1",
      sessionId: "s1", role: "implementer",
      request: { question: "q", options: [{ id: "a", label: "A" }], allowFreeform: false },
    })
    store.cancelInteraction("s1", "int-1")

    expect(() => store.respondInteraction("s1", "int-1", { optionId: "a" }))
      .toThrow(/cancelled/)
  })

  test("cancel on unknown interaction throws", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore()
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })

    expect(() => store.cancelInteraction("s1", "unknown"))
      .toThrow(/Unknown interaction/)
  })

  test("validates optionId against request options", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore()
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })
    store.createInteraction({
      interactionId: "int-1",
      sessionId: "s1", role: "implementer",
      request: { question: "q", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], allowFreeform: false },
    })

    expect(() => store.respondInteraction("s1", "int-1", { optionId: "invalid" }))
      .toThrow(/Invalid optionId/)
  })

  test("validates empty text for required freeform", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore()
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })
    store.createInteraction({
      interactionId: "int-1",
      sessionId: "s1", role: "implementer",
      request: { question: "q", allowFreeform: true },
    })

    expect(() => store.respondInteraction("s1", "int-1", { text: "   " }))
      .toThrow(/non-empty text/)
  })

  test("rejects text response when allowFreeform is false", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore()
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })
    store.createInteraction({
      interactionId: "int-1",
      sessionId: "s1", role: "implementer",
      request: { question: "q", options: [{ id: "a", label: "A" }], allowFreeform: false },
    })

    expect(() => store.respondInteraction("s1", "int-1", { text: "sneaky bypass" }))
      .toThrow(/allowFreeform is false/)
  })

  test("registerController accepts same controllerId idempotently", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore()
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })

    store.registerController("s1", "ctrl-1")
    // Same controllerId again — no error
    store.registerController("s1", "ctrl-1")
  })

  test("registerController rejects different controllerId on same session", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore()
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })

    store.registerController("s1", "ctrl-1")
    expect(() => store.registerController("s1", "ctrl-2"))
      .toThrow(/active controller/)
  })

  test("releaseController allows a new controller to register", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore()
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })

    store.registerController("s1", "ctrl-1")
    store.releaseController("s1", "ctrl-1")
    // Now a new controller can register
    store.registerController("s1", "ctrl-2")
  })

  test("releaseController with wrong id is a no-op", async () => {
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore()
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })

    store.registerController("s1", "ctrl-1")
    store.releaseController("s1", "wrong-id")
    // ctrl-1 is still active
    expect(() => store.registerController("s1", "ctrl-2"))
      .toThrow(/active controller/)
  })

  test("expired controller lease allows new registration", async () => {
    let now = 1000
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore({ now: () => new Date(now) })
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })

    // Register at t=1000, lease expires at t=61000
    store.registerController("s1", "ctrl-1")
    // Before expiry — conflict
    expect(() => store.registerController("s1", "ctrl-2"))
      .toThrow(/active controller/)
    // Advance past TTL
    now = 61_001
    // Now expired — new registration succeeds
    store.registerController("s1", "ctrl-2")
  })

  test("refreshController extends the lease", async () => {
    let now = 1000
    const { createSessionStore } = await import(storeModulePath) as typeof import("@src/session/store")
    const store = createSessionStore({ now: () => new Date(now) })
    store.create({ agent, id: "s1", role: "implementer", runDirectory, workspace: "/tmp/p" })

    store.registerController("s1", "ctrl-1")
    // Advance to near expiry
    now = 59_000
    store.refreshController("s1", "ctrl-1")
    // Advance past original expiry but within refreshed window
    now = 61_001
    // Should still be active
    expect(() => store.registerController("s1", "ctrl-2"))
      .toThrow(/active controller/)
  })
})
