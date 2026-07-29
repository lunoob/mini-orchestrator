import { randomUUID } from "node:crypto"

import type { SessionClient } from "../session/client.js"
import type { SessionStreamEvent } from "../session/types.js"
import type {
  AgentRole,
  InputRequest,
  UserDecision,
  UserDecisionBroker,
} from "./agent-outcome.js"

type SessionBrokerOptions = {
  client: Pick<SessionClient, "getInteractions" | "postEvent" | "stream">
}

/**
 * Creates a UserDecisionBroker that communicates through the Session API.
 *
 * Race-safe sequence:
 * 1. Open SSE stream and wait for server confirmation (heartbeat)
 * 2. Post interaction.request — SSE is confirmed live
 * 3. Check persisted interaction state (catches any remaining race)
 * 4. Drain buffered + live SSE events for our interactionId
 */
export const createSessionUserDecisionBroker = (
  options: SessionBrokerOptions,
): UserDecisionBroker => ({
  requestDecision: async (
    sessionId: string,
    role: AgentRole,
    request: InputRequest,
    turnId?: string,
  ): Promise<UserDecision | null> => {
    const interactionId = randomUUID()

    // Step 1: Open SSE and wait for server confirmation (heartbeat).
    // The server sends a heartbeat on subscribe, so receiving it proves the connection is live.
    const eventQueue: SessionStreamEvent[] = []
    let streamDone = false
    let streamError: unknown = null
    let waiters: Array<() => void> = []

    const iterator = options.client.stream(sessionId)[Symbol.asyncIterator]()
    const readerPromise = (async () => {
      try {
        while (true) {
          const next = await iterator.next()
          if (next.done) { streamDone = true; break }
          eventQueue.push(next.value)
          for (const w of waiters) w()
          waiters = []
        }
      } catch (e) {
        streamError = e
        streamDone = true
        for (const w of waiters) w()
        waiters = []
      }
    })()

    // Wait for the first event (heartbeat) to confirm the SSE connection is live.
    // This blocks until the server has actually established the subscription.
    await new Promise<void>((resolve, reject) => {
      if (eventQueue.length > 0) { resolve(); return }
      if (streamDone) { reject(streamError ?? new Error("SSE stream closed before confirmation")); return }
      waiters.push(resolve)
    })

    // Step 2: Post interaction request. SSE is confirmed live.
    await options.client.postEvent(sessionId, {
      data: { interactionId, request, role, turnId },
      type: "interaction.request",
    })

    // Step 3: Check persisted state (catches responses that arrived between subscribe and post)
    const interactions = await options.client.getInteractions(sessionId)
    const existing = interactions.find(i => i.interactionId === interactionId)
    if (existing) {
      if (existing.status === "answered" && existing.response) {
        await iterator.return?.()
        await readerPromise.catch(() => {})
        return existing.response
      }
      if (existing.status === "cancelled") {
        await iterator.return?.()
        await readerPromise.catch(() => {})
        return null
      }
    }

    // Step 4: Drain buffered + live SSE events for our interactionId
    const drain = async function* (): AsyncGenerator<SessionStreamEvent> {
      let idx = 0
      while (true) {
        if (idx < eventQueue.length) {
          yield eventQueue[idx++]
          continue
        }
        if (streamDone) break
        await new Promise<void>(r => waiters.push(r))
        if (streamError) throw streamError
      }
    }

    try {
      for await (const event of drain()) {
        if (event.type === "interaction.response" &&
            event.data?.interactionId === interactionId) {
          return {
            optionId: event.data.optionId as string | undefined,
            text: event.data.text as string | undefined,
          }
        }
        if (event.type === "interaction.cancel" &&
            event.data?.interactionId === interactionId) {
          return null
        }
      }
      return null
    } finally {
      await iterator.return?.()
      await readerPromise.catch(() => {})
    }
  },
})
