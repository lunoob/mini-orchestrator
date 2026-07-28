import { describe, expect, test } from "vitest"

import { createSessionApiServer } from "./server.js"
import { waitForTurn } from "./turn-wait.js"
import type { SessionClient } from "./client.js"
import type { SessionItem, SessionRecord, SessionStreamEvent } from "./types.js"

const clientModulePath = "./client.js"
const serverModulePath = "./server.js"
const runDirectory = "/tmp/mini-orch-session-client-tests"
const agent = {
  agent: "codex",
  command: "codex",
  integrationAgent: "codex",
  name: "codex",
}

const postJson = async (url: string, token: string, body: unknown) =>
  fetch(url, {
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method: "POST",
  })

describe("SessionClient", () => {
  test("creates a session and sends an idempotent prompt through the Session API", async () => {
    const { createSessionClient } = await import(clientModulePath) as typeof import("./client.js")
    const server = createSessionApiServer({ runDirectory, token: "test-token" })
    const { baseUrl } = await server.start()
    const client = createSessionClient({ baseUrl, token: "test-token" })

    try {
      const session = await client.create({
        agent,
        role: "implementer",
        runDirectory,
        workspace: "/tmp/project",
      })
      await client.postEvent(session.id, { type: "runner.ready" })

      const first = await client.sendMessage(session.id, {
        content: "Implement the feature",
        eventId: "event-1",
      })
      const replay = await client.sendMessage(session.id, {
        content: "Implement the feature",
        eventId: "event-1",
      })

      expect(replay).toEqual(first)
      expect((await client.get(session.id)).status).toBe("running")
      expect(await client.getItems(session.id)).toEqual([
        expect.objectContaining({ content: "Implement the feature", role: "user" }),
      ])
    } finally {
      await server.stop()
    }
  })

  test("waits for the matching turn and returns its persisted output item", async () => {
    const { createSessionClient } = await import(clientModulePath) as typeof import("./client.js")
    const server = createSessionApiServer({ runDirectory, token: "test-token" })
    const { baseUrl } = await server.start()
    const client = createSessionClient({ baseUrl, token: "test-token" })

    try {
      const session = await client.create({
        agent,
        role: "implementer",
        runDirectory,
        workspace: "/tmp/project",
      })
      const { turnId } = await client.sendMessage(session.id, {
        content: "Implement the feature",
        eventId: "event-1",
      })
      const waiting = client.waitForTurn(session.id, turnId)

      await client.postEvent(session.id, {
        data: { content: "Feature implemented", turnId },
        type: "runner.turn.completed",
      })

      await expect(waiting).resolves.toMatchObject({
        content: "Feature implemented",
        role: "assistant",
        turnId,
      })
    } finally {
      await server.stop()
    }
  })

  test("does not resolve the first turn when only the second turn completes", async () => {
    const { createSessionClient } = await import(clientModulePath) as typeof import("./client.js")
    const server = createSessionApiServer({ runDirectory, token: "test-token" })
    const { baseUrl } = await server.start()
    const client = createSessionClient({ baseUrl, token: "test-token" })

    try {
      const session = await client.create({
        agent,
        role: "implementer",
        runDirectory,
        workspace: "/tmp/project",
      })
      const first = await client.sendMessage(session.id, { content: "first", eventId: "event-1" })
      const second = await client.sendMessage(session.id, { content: "second", eventId: "event-2" })
      const waiting = waitForTurn(client, session.id, first.turnId)

      await client.postEvent(session.id, {
        data: { content: "second output", turnId: second.turnId },
        type: "runner.turn.completed",
      })
      const settledAfterSecond = await Promise.race([
        waiting.then(() => "resolved"),
        Promise.resolve("pending"),
      ])
      expect(settledAfterSecond).toBe("pending")

      await client.postEvent(session.id, {
        data: { content: "first output", turnId: first.turnId },
        type: "runner.turn.completed",
      })
      await expect(waiting).resolves.toMatchObject({
        output: expect.objectContaining({ content: "first output" }),
        turn: { id: first.turnId, status: "completed" },
      })
    } finally {
      await server.stop()
    }
  })

  test.each([
    ["failed", "runner crashed"],
    ["interrupted", undefined],
  ] as const)("returns a deterministic %s turn result", async (status, reason) => {
    const { createSessionClient } = await import(clientModulePath) as typeof import("./client.js")
    const server = createSessionApiServer({ runDirectory, token: "test-token" })
    const { baseUrl } = await server.start()
    const client = createSessionClient({ baseUrl, token: "test-token" })

    try {
      const session = await client.create({ agent, role: "implementer", workspace: "/tmp/project", runDirectory })
      const { turnId } = await client.sendMessage(session.id, {
        content: "prompt",
        eventId: `event-${status}`,
      })
      const waiting = waitForTurn(client, session.id, turnId)
      if (status === "failed") {
        await client.postEvent(session.id, { data: { reason: reason ?? "", turnId }, type: "turn.failed" })
      } else {
        await client.postEvent(session.id, { data: { turnId }, type: "turn.interrupted" })
      }

      const result = await waiting
      expect(result.turn).toMatchObject({ id: turnId, status })
      if (reason) expect(result.turn.error).toBe(reason)
    } finally {
      await server.stop()
    }
  })

  test("reconciles a disconnected SSE window from snapshot and items without duplicating output", async () => {
    const { createSessionClient } = await import(clientModulePath) as typeof import("./client.js")
    const server = createSessionApiServer({ runDirectory, token: "test-token" })
    const { baseUrl } = await server.start()
    const client = createSessionClient({ baseUrl, token: "test-token" })

    try {
      const session = await client.create({ agent, role: "implementer", workspace: "/tmp/project", runDirectory })
      const { turnId } = await client.sendMessage(session.id, { content: "prompt", eventId: "event-1" })
      const disconnected = client.stream(session.id)[Symbol.asyncIterator]()
      await disconnected.next()
      await disconnected.return?.()
      await client.postEvent(session.id, {
        data: { content: "final output", turnId },
        type: "runner.output_item.done",
      })
      await client.postEvent(session.id, { data: { turnId }, type: "turn.completed" })

      await expect(waitForTurn(client, session.id, turnId)).resolves.toMatchObject({
        output: expect.objectContaining({ content: "final output", turnId }),
      })
      expect((await client.getItems(session.id)).filter(item => item.role === "assistant")).toHaveLength(1)
    } finally {
      await server.stop()
    }
  })

  test("closes SSE subscribers and releases the port when stopped", async () => {
    const { createSessionApiServer } = await import(serverModulePath) as typeof import("./server.js")
    const server = createSessionApiServer({ runDirectory, token: "test-token" })
    const { baseUrl } = await server.start()

    const createResponse = await postJson(`${baseUrl}/v1/sessions`, "test-token", {
      agent,
      role: "implementer",
      workspace: "/tmp/project",
    })
    const { session } = await createResponse.json() as { session: { id: string } }
    const stream = await fetch(`${baseUrl}/v1/sessions/${session.id}/stream`, {
      headers: { authorization: "Bearer test-token" },
    })
    const reader = stream.body?.getReader()
    if (!reader) throw new Error("Expected an SSE response body")
    await reader.read()

    await server.stop()
    await expect(reader.read()).resolves.toMatchObject({ done: true })
    await expect(fetch(`${baseUrl}/v1/sessions`)).rejects.toThrow()
  })

  test("reconnects the same turn wait after an SSE connection drops", async () => {
    let subscriptions = 0
    let completed = false
    const turnId = "turn-reconnect"
    const session: SessionRecord = {
      agent,
      createdAt: new Date().toISOString(),
      id: "session-reconnect",
      role: "implementer",
      runnerReady: true,
      runnerStatus: "working",
      runDirectory,
      status: "running",
      turns: [{ createdAt: new Date().toISOString(), id: turnId, sessionId: "session-reconnect", status: "running" }],
      workspace: "/tmp/project",
    }
    const output: SessionItem = {
      content: "reconnected output",
      createdAt: new Date().toISOString(),
      id: "item-output",
      role: "assistant",
      turnId,
    }
    const client = {
      get: async () => completed
        ? { ...session, status: "ready", turns: [{ ...session.turns[0], status: "completed" }] }
        : session,
      getItems: async () => completed ? [output] : [],
      stream: async function* (): AsyncIterable<SessionStreamEvent> {
        subscriptions += 1
        yield { sequence: subscriptions, sessionId: session.id, type: "session.heartbeat" }
        if (subscriptions === 1) return
        completed = true
        yield { sequence: subscriptions + 1, sessionId: session.id, turnId, type: "turn.completed" }
      },
    } as unknown as SessionClient

    const waiting = waitForTurn(client, session.id, turnId)
    await expect(waiting).resolves.toMatchObject({
      output,
      turn: { id: turnId, status: "completed" },
    })
    expect(subscriptions).toBe(2)
  })
})
