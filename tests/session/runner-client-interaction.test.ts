import { describe, expect, test, vi } from "vitest"

import { createRunnerClient, type InteractionResult } from "@src/session/runner-client"
import type { SessionClient } from "@src/session/client"
import type { SessionRecord, SessionStreamEvent } from "@src/session/types"

const session: SessionRecord = {
  agent: { agent: "codex", command: "codex", name: "codex" },
  createdAt: new Date().toISOString(),
  id: "session-1",
  role: "implementer",
  runnerReady: false,
  runnerStatus: "starting",
  runDirectory: "/tmp/run",
  status: "starting",
  turns: [],
  workspace: "/tmp/project",
}

describe("RunnerClient interaction dispatch", () => {
  test("dispatches interaction.request to onInteraction callback", async () => {
    const interactionEvent: SessionStreamEvent = {
      data: {
        interactionId: "int-1",
        request: { question: "pick one", options: [{ id: "a", label: "A" }], allowFreeform: false },
        role: "implementer",
      },
      sequence: 1,
      sessionId: session.id,
      type: "interaction.request",
    }
    const stream = async function* () { yield interactionEvent }
    const postEvent = vi.fn(async () => undefined)
    const getItems = vi.fn(async () => [])
    const getInteractions = vi.fn(async () => [])
    const client = { getInteractions, getItems, postEvent, stream } as unknown as SessionClient
    const onInteraction = vi.fn(async (): Promise<InteractionResult> => null)
    const runner = createRunnerClient({
      client,
      onInteraction,
      onMessage: vi.fn(async () => undefined),
      sessionId: session.id,
    })

    await runner.consumeOnce()

    expect(onInteraction).toHaveBeenCalledTimes(1)
    expect(onInteraction).toHaveBeenCalledWith(expect.objectContaining({
      interactionId: "int-1",
      request: expect.objectContaining({ question: "pick one" }),
    }))
  })

  test("posts interaction.response back to session after user answers", async () => {
    const interactionEvent: SessionStreamEvent = {
      data: {
        interactionId: "int-1",
        request: { question: "pick", options: [{ id: "a", label: "A" }], allowFreeform: false },
        role: "implementer",
      },
      sequence: 1,
      sessionId: session.id,
      type: "interaction.request",
    }
    const stream = async function* () { yield interactionEvent }
    const postEvent = vi.fn(async () => undefined)
    const getItems = vi.fn(async () => [])
    const getInteractions = vi.fn(async () => [])
    const client = { getInteractions, getItems, postEvent, stream } as unknown as SessionClient
    const onInteraction = vi.fn(async (): Promise<InteractionResult> => ({ optionId: "a" }))
    const runner = createRunnerClient({
      client,
      onInteraction,
      onMessage: vi.fn(async () => undefined),
      sessionId: session.id,
    })

    await runner.consumeOnce()

    expect(postEvent).toHaveBeenCalledWith(session.id, expect.objectContaining({
      type: "interaction.response",
      data: expect.objectContaining({ interactionId: "int-1", optionId: "a" }),
    }))
  })

  test("posts interaction.cancel when user cancels", async () => {
    const interactionEvent: SessionStreamEvent = {
      data: {
        interactionId: "int-1",
        request: { question: "pick", options: [{ id: "a", label: "A" }], allowFreeform: false },
        role: "implementer",
      },
      sequence: 1,
      sessionId: session.id,
      type: "interaction.request",
    }
    const stream = async function* () { yield interactionEvent }
    const postEvent = vi.fn(async () => undefined)
    const getItems = vi.fn(async () => [])
    const getInteractions = vi.fn(async () => [])
    const client = { getInteractions, getItems, postEvent, stream } as unknown as SessionClient
    const onInteraction = vi.fn(async (): Promise<InteractionResult> => null)
    const runner = createRunnerClient({
      client,
      onInteraction,
      onMessage: vi.fn(async () => undefined),
      sessionId: session.id,
    })

    await runner.consumeOnce()

    expect(postEvent).toHaveBeenCalledWith(session.id, expect.objectContaining({
      type: "interaction.cancel",
      data: expect.objectContaining({ interactionId: "int-1" }),
    }))
  })

  test("serializes multiple interaction requests — second waits for first to complete", async () => {
    const events: SessionStreamEvent[] = [
      {
        data: { interactionId: "int-1", request: { question: "first", options: [{ id: "a", label: "A" }], allowFreeform: false }, role: "implementer" },
        sequence: 1, sessionId: session.id, type: "interaction.request",
      },
      {
        data: { interactionId: "int-2", request: { question: "second", options: [{ id: "b", label: "B" }], allowFreeform: false }, role: "implementer" },
        sequence: 2, sessionId: session.id, type: "interaction.request",
      },
    ]
    const stream = async function* () { for (const e of events) yield e }
    const postEvent = vi.fn(async () => undefined)
    const getItems = vi.fn(async () => [])
    const getInteractions = vi.fn(async () => [])
    const client = { getInteractions, getItems, postEvent, stream } as unknown as SessionClient
    let resolveFirst!: () => void
    const firstPromise = new Promise<void>(r => { resolveFirst = r })
    const onInteraction = vi.fn(async (req: { interactionId: string }): Promise<InteractionResult> => {
      if (req.interactionId === "int-1") {
        await firstPromise
        return { optionId: "a" }
      }
      return { optionId: "b" }
    })
    const runner = createRunnerClient({
      client,
      onInteraction,
      onMessage: vi.fn(async () => undefined),
      sessionId: session.id,
    })

    const runPromise = runner.consumeOnce()
    // Let first interaction start
    await new Promise(r => setTimeout(r, 10))
    // Only first interaction should have been called
    expect(onInteraction).toHaveBeenCalledTimes(1)
    resolveFirst()
    await runPromise
    // Wait for queued interactions to complete
    await runner.drainInteractions()
    expect(onInteraction).toHaveBeenCalledTimes(2)
  })

  test("restores pending interactions on reconnect — SSE confirmed before getInteractions", async () => {
    const callOrder: string[] = []
    const stream = async function* () {
      callOrder.push("stream.next")
      // First event confirms SSE is live
      yield { type: "session.heartbeat" as const, sequence: 1, sessionId: session.id }
    }
    const postEvent = vi.fn(async () => undefined)
    const getItems = vi.fn(async () => [])
    const getInteractions = vi.fn(async () => {
      callOrder.push("getInteractions")
      return [{
        interactionId: "pending-1",
        sessionId: session.id,
        status: "pending" as const,
        request: { question: "restore me", options: [{ id: "a", label: "A" }], allowFreeform: false },
        role: "implementer" as const,
        createdAt: new Date().toISOString(),
      }]
    })
    const client = { getInteractions, getItems, postEvent, stream } as unknown as SessionClient
    const onInteraction = vi.fn(async (): Promise<InteractionResult> => ({ optionId: "a" }))
    const runner = createRunnerClient({
      client,
      onInteraction,
      onMessage: vi.fn(async () => undefined),
      sessionId: session.id,
    })

    await runner.consumeOnce()
    await runner.drainInteractions()

    // stream.next (SSE) must happen BEFORE getInteractions
    expect(callOrder).toEqual(["stream.next", "getInteractions"])
    expect(onInteraction).toHaveBeenCalledWith(expect.objectContaining({
      interactionId: "pending-1",
      request: expect.objectContaining({ question: "restore me" }),
    }))
    expect(postEvent).toHaveBeenCalledWith(session.id, expect.objectContaining({
      type: "interaction.response",
      data: expect.objectContaining({ interactionId: "pending-1", optionId: "a" }),
    }))
  })

  test("runner picks up controllerId from SSE and includes in subsequent events", async () => {
    const postedEvents: any[] = []
    const stream = async function* () {
      // Server sends controllerId via SSE event
      yield { controllerId: "sse-cid", type: "runner.controller" as const, sequence: 1, sessionId: session.id }
      // Then an interaction to trigger a response (which includes controllerId)
      yield {
        data: { interactionId: "int-sse", request: { question: "q", options: [{ id: "a", label: "A" }], allowFreeform: false }, role: "implementer" },
        sequence: 2, sessionId: session.id, type: "interaction.request" as const,
      }
    }
    const postEvent = vi.fn(async (_sid: string, event: any) => {
      postedEvents.push(event)
      return undefined
    })
    const getItems = vi.fn(async () => [])
    const getInteractions = vi.fn(async () => [])
    const client = { getInteractions, getItems, postEvent, stream } as unknown as SessionClient
    const onInteraction = vi.fn(async (): Promise<InteractionResult> => ({ optionId: "a" }))
    const runner = createRunnerClient({
      client,
      onInteraction,
      onMessage: vi.fn(async () => undefined),
      sessionId: session.id,
    })

    await runner.consumeOnce()
    await runner.drainInteractions()

    // The interaction response event should include the controllerId from SSE
    const responseEvent = postedEvents.find(e => e.type === "interaction.response")
    expect(responseEvent?.controllerId).toBe("sse-cid")
  })

  test("deduplicates repeated interaction.request events with same ID", async () => {
    const interactionEvent: SessionStreamEvent = {
      data: {
        interactionId: "int-dup",
        request: { question: "pick", options: [{ id: "a", label: "A" }], allowFreeform: false },
        role: "implementer",
      },
      sequence: 1,
      sessionId: session.id,
      type: "interaction.request",
    }
    const stream = async function* () {
      yield interactionEvent
      yield { ...interactionEvent, sequence: 2 } // duplicate
    }
    const postEvent = vi.fn(async () => undefined)
    const getItems = vi.fn(async () => [])
    const getInteractions = vi.fn(async () => [])
    const client = { getInteractions, getItems, postEvent, stream } as unknown as SessionClient
    const onInteraction = vi.fn(async (): Promise<InteractionResult> => ({ optionId: "a" }))
    const runner = createRunnerClient({
      client,
      onInteraction,
      onMessage: vi.fn(async () => undefined),
      sessionId: session.id,
    })

    await runner.consumeOnce()
    await runner.drainInteractions()

    // Should only be called once despite two events with same interactionId
    expect(onInteraction).toHaveBeenCalledTimes(1)
  })
})
