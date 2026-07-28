import { describe, expect, test, vi } from "vitest"

import { createRunnerClient } from "./runner-client.js"
import type { SessionClient } from "./client.js"
import type { SessionItem, SessionRecord } from "./types.js"

const session: SessionRecord = {
  agent: { agent: "codex", command: "codex", integrationAgent: "codex", name: "codex" },
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

const item = (turnId: string, eventId: string, content: string): SessionItem => ({
  content,
  createdAt: new Date().toISOString(),
  eventId,
  id: `item-${eventId}`,
  role: "user",
  turnId,
})

describe("RunnerClient", () => {
  test("registers, dispatches a message once, and handles interrupt/stop from Session events", async () => {
    const events = [
      { sequence: 1, sessionId: session.id, turnId: "turn-1", type: "turn.started" as const },
      { data: { turnId: "turn-1" }, sequence: 2, sessionId: session.id, type: "session.interrupt" as const },
      { data: { turnId: "turn-1" }, sequence: 3, sessionId: session.id, type: "session.stop" as const },
      // stop 后 Codex 终态事件到达，runner 才完成清理
      { sequence: 4, sessionId: session.id, turnId: "turn-1", type: "turn.interrupted" as const },
    ]
    const postEvent = vi.fn(async () => undefined)
    const getItems = vi.fn(async () => [item("turn-1", "event-1", "prompt")])
    const stream = async function* () {
      for (const event of events) yield event
    }
    const client = { getItems, postEvent, stream } as unknown as SessionClient
    const onMessage = vi.fn(async () => undefined)
    const onInterrupt = vi.fn(async () => undefined)
    const onStop = vi.fn(async () => undefined)
    const runner = createRunnerClient({ client, onInterrupt, onMessage, onStop, sessionId: session.id })

    await runner.run()

    expect(postEvent).toHaveBeenCalledWith(session.id, { source: "runner", type: "runner.ready" })
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage).toHaveBeenCalledWith({ content: "prompt", eventId: "event-1", turnId: "turn-1" })
    expect(onInterrupt).toHaveBeenCalledWith("turn-1")
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  test("does not redeliver a confirmed event after a stream reconnect", async () => {
    const streams = [
      [{ sequence: 1, sessionId: session.id, turnId: "turn-1", type: "turn.started" as const }],
      [{ sequence: 2, sessionId: session.id, turnId: "turn-1", type: "turn.started" as const }],
    ]
    const getItems = vi.fn(async () => [item("turn-1", "event-1", "prompt")])
    const postEvent = vi.fn(async () => undefined)
    const stream = vi.fn(async function* () {
      yield* streams.shift() ?? []
    })
    const onMessage = vi.fn(async () => undefined)
    const client = { getItems, postEvent, stream } as unknown as SessionClient
    const runner = createRunnerClient({ client, onMessage, sessionId: session.id })

    await runner.consumeOnce()
    await runner.consumeOnce()

    expect(onMessage).toHaveBeenCalledTimes(1)
  })
})
