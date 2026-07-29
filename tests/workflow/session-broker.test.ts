import { describe, expect, test, vi } from "vitest"

import type { InputRequest } from "@src/workflow/agent-outcome"
import type { SessionStreamEvent } from "@src/session/types"

describe("SessionUserDecisionBroker", () => {
  test("waits for SSE heartbeat confirmation before posting request", async () => {
    const { createSessionUserDecisionBroker } = await import("@src/workflow/session-broker")

    const callOrder: string[] = []
    let resolveHeartbeat!: (event: SessionStreamEvent) => void
    const heartbeatPromise = new Promise<SessionStreamEvent>(r => { resolveHeartbeat = r })
    let resolveResponse!: (event: SessionStreamEvent) => void
    const responsePromise = new Promise<SessionStreamEvent>(r => { resolveResponse = r })
    let eventIdx = 0

    const postEvent = vi.fn(async () => { callOrder.push("post") })
    const getInteractions = vi.fn(async () => [])
    const stream = async function* () {
      // First yield: heartbeat (SSE confirmation)
      callOrder.push("stream.start")
      yield await heartbeatPromise
      callOrder.push("heartbeat.received")
      // Then yield the response
      yield await responsePromise
    }
    const client = { getInteractions, postEvent, stream } as any

    const broker = createSessionUserDecisionBroker({ client })
    const decisionPromise = broker.requestDecision("s1", "implementer", {
      question: "Pick",
      options: [{ id: "a", label: "A" }],
      allowFreeform: false,
    })

    // Give the broker time to start the stream
    await new Promise(r => setTimeout(r, 10))
    expect(callOrder).toContain("stream.start")
    // post should NOT have been called yet — waiting for heartbeat
    expect(callOrder).not.toContain("post")

    // Send heartbeat to confirm SSE is live
    resolveHeartbeat({
      type: "session.heartbeat",
      sequence: 1,
      sessionId: "s1",
    })

    // Now post should happen after heartbeat
    await new Promise(r => setTimeout(r, 20))
    expect(callOrder).toEqual(expect.arrayContaining(["stream.start", "heartbeat.received", "post"]))

    // Now send the response
    const interactionId = (postEvent.mock.calls[0] as any[])[1].data.interactionId
    resolveResponse({
      type: "interaction.response",
      data: { interactionId, optionId: "a" },
      sequence: 2,
      sessionId: "s1",
    })

    const decision = await decisionPromise
    expect(decision).toEqual({ optionId: "a" })
  })

  test("returns null when interaction is cancelled", async () => {
    const { createSessionUserDecisionBroker } = await import("@src/workflow/session-broker")

    let resolveCancel!: (event: SessionStreamEvent) => void
    const cancelPromise = new Promise<SessionStreamEvent>(r => { resolveCancel = r })

    const postEvent = vi.fn(async () => undefined)
    const getInteractions = vi.fn(async () => [])
    const stream = async function* () {
      yield { type: "session.heartbeat", sequence: 0, sessionId: "s1" } as SessionStreamEvent
      yield await cancelPromise
    }
    const client = { getInteractions, postEvent, stream } as any

    const broker = createSessionUserDecisionBroker({ client })
    const decisionPromise = broker.requestDecision("s1", "implementer", {
      question: "Continue?",
      allowFreeform: true,
    })

    await new Promise(r => setTimeout(r, 20))
    const interactionId = (postEvent.mock.calls[0] as any[])[1].data.interactionId
    resolveCancel({
      type: "interaction.cancel",
      data: { interactionId },
      sequence: 1,
      sessionId: "s1",
    })

    const decision = await decisionPromise
    expect(decision).toBeNull()
  })

  test("ignores events for other interactionIds", async () => {
    const { createSessionUserDecisionBroker } = await import("@src/workflow/session-broker")

    let resolveCorrect!: (event: SessionStreamEvent) => void
    const correctPromise = new Promise<SessionStreamEvent>(r => { resolveCorrect = r })

    const postEvent = vi.fn(async () => undefined)
    const getInteractions = vi.fn(async () => [])
    const stream = async function* () {
      yield { type: "session.heartbeat", sequence: 0, sessionId: "s1" } as SessionStreamEvent
      yield { type: "interaction.response", data: { interactionId: "wrong-id", optionId: "x" }, sequence: 1, sessionId: "s1" } as SessionStreamEvent
      yield await correctPromise
    }
    const client = { getInteractions, postEvent, stream } as any

    const broker = createSessionUserDecisionBroker({ client })
    const decisionPromise = broker.requestDecision("s1", "implementer", {
      question: "Pick",
      options: [{ id: "a", label: "A" }],
      allowFreeform: false,
    })

    await new Promise(r => setTimeout(r, 20))
    const interactionId = (postEvent.mock.calls[0] as any[])[1].data.interactionId
    resolveCorrect({
      type: "interaction.response",
      data: { interactionId, optionId: "a" },
      sequence: 2,
      sessionId: "s1",
    })

    const decision = await decisionPromise
    expect(decision).toEqual({ optionId: "a" })
  })

  test("handles race: interaction already answered before SSE check", async () => {
    const { createSessionUserDecisionBroker } = await import("@src/workflow/session-broker")

    let capturedInteractionId: string | undefined
    const postEvent = vi.fn(async (_sessionId: string, event: any) => {
      capturedInteractionId = event.data?.interactionId
    })
    const getInteractions = vi.fn(async (sessionId: string) => {
      if (!capturedInteractionId) return []
      return [{
        interactionId: capturedInteractionId,
        sessionId,
        status: "answered",
        response: { optionId: "a" },
        request: { question: "Pick", options: [{ id: "a", label: "A" }], allowFreeform: false },
        role: "implementer",
        createdAt: new Date().toISOString(),
        respondedAt: new Date().toISOString(),
      }]
    })
    const stream = async function* (): AsyncGenerator<SessionStreamEvent> {
      yield { type: "session.heartbeat", sequence: 1, sessionId: "s1" }
    }
    const client = { getInteractions, postEvent, stream } as any

    const broker = createSessionUserDecisionBroker({ client })
    const decision = await broker.requestDecision("s1", "implementer", {
      question: "Pick",
      options: [{ id: "a", label: "A" }],
      allowFreeform: false,
    })

    expect(decision).toEqual({ optionId: "a" })
  })
})
