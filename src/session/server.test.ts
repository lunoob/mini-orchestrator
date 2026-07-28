import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, test } from "vitest"

const serverModulePath = "./server.js"
const runDirectory = "/tmp/mini-orch-session-api-tests"
const agent = {
  agent: "codex",
  command: "codex",
  integrationAgent: "codex",
  name: "codex",
}

const postJson = async (url: string, token: string, body: unknown) =>
  fetch(url, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  })

const readUntilTurnComplete = async (response: Response) => {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Expected an SSE response body")

  const decoder = new TextDecoder()
  const events: Array<{ type: string }> = []
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) throw new Error("SSE stream closed before turn completion")
    buffer += decoder.decode(value, { stream: true })

    const frames = buffer.split("\n\n")
    buffer = frames.pop() ?? ""
    for (const frame of frames) {
      const payload = frame.split("\n").find(line => line.startsWith("data: "))
      if (!payload) continue
      const event = JSON.parse(payload.slice(6)) as { type: string }
      events.push(event)
      if (event.type === "turn.completed") {
        await reader.cancel()
        return events
      }
    }
  }
}

describe("Session API server", () => {
  test("creates, drives and reads a session through authenticated events", async () => {
    const { createSessionApiServer } = await import(serverModulePath) as typeof import("./server.js")
    const server = createSessionApiServer({ runDirectory, token: "test-token" })
    const { baseUrl } = await server.start()

    try {
      const createResponse = await postJson(`${baseUrl}/v1/sessions`, "test-token", {
        agent,
        role: "implementer",
        workspace: "/tmp/project",
      })
      expect(createResponse.status).toBe(201)
      const { runnerToken, session } = await createResponse.json() as {
        runnerToken: string
        session: { agent: typeof agent; id: string; runDirectory: string; status: string }
      }
      expect(session).toMatchObject({ agent, runDirectory, status: "starting" })

      const readyResponse = await postJson(
        `${baseUrl}/v1/sessions/${session.id}/events`,
        runnerToken,
        { type: "runner.ready" },
      )
      expect(readyResponse.status).toBe(202)

      const message = {
        data: { content: "Implement the feature" },
        eventId: "event-1",
        type: "message",
      }
      const firstMessageResponse = await postJson(
        `${baseUrl}/v1/sessions/${session.id}/events`,
        "test-token",
        message,
      )
      const firstMessage = await firstMessageResponse.json() as { turnId: string }
      const replayResponse = await postJson(
        `${baseUrl}/v1/sessions/${session.id}/events`,
        "test-token",
        message,
      )
      expect(await replayResponse.json()).toEqual(firstMessage)

      const completeResponse = await postJson(
        `${baseUrl}/v1/sessions/${session.id}/events`,
        runnerToken,
        {
          data: { content: "Feature implemented", turnId: firstMessage.turnId },
          type: "runner.turn.completed",
        },
      )
      expect(completeResponse.status).toBe(202)

      const snapshotResponse = await fetch(`${baseUrl}/v1/sessions/${session.id}`, {
        headers: { authorization: "Bearer test-token" },
      })
      expect(await snapshotResponse.json()).toMatchObject({
        session: { id: session.id, status: "ready" },
      })

      const itemsResponse = await fetch(`${baseUrl}/v1/sessions/${session.id}/items`, {
        headers: { authorization: "Bearer test-token" },
      })
      expect(await itemsResponse.json()).toMatchObject({
        items: [
          { content: "Implement the feature", role: "user" },
          { content: "Feature implemented", role: "assistant" },
        ],
      })
    } finally {
      await server.stop()
    }
  })

  test("rejects requests without the session capability token", async () => {
    const { createSessionApiServer } = await import(serverModulePath) as typeof import("./server.js")
    const server = createSessionApiServer({ runDirectory, token: "test-token" })
    const { baseUrl } = await server.start()

    try {
      const response = await fetch(`${baseUrl}/v1/sessions`)
      expect(response.status).toBe(401)
    } finally {
      await server.stop()
    }
  })

  test("streams the live turn lifecycle after a subscriber connects", async () => {
    const { createSessionApiServer } = await import(serverModulePath) as typeof import("./server.js")
    const server = createSessionApiServer({ runDirectory, token: "test-token" })
    const { baseUrl } = await server.start()

    try {
      const createResponse = await postJson(`${baseUrl}/v1/sessions`, "test-token", {
        agent,
        role: "implementer",
        workspace: "/tmp/project",
      })
      const { runnerToken, session } = await createResponse.json() as { runnerToken: string; session: { id: string } }

      const streamResponse = await fetch(`${baseUrl}/v1/sessions/${session.id}/stream`, {
        headers: { authorization: "Bearer test-token" },
      })
      expect(streamResponse.headers.get("content-type")).toContain("text/event-stream")
      const streamedEvents = readUntilTurnComplete(streamResponse)

      const messageResponse = await postJson(
        `${baseUrl}/v1/sessions/${session.id}/events`,
        "test-token",
        {
          data: { content: "Implement the feature" },
          eventId: "event-1",
          type: "message",
        },
      )
      const { turnId } = await messageResponse.json() as { turnId: string }
      await postJson(`${baseUrl}/v1/sessions/${session.id}/events`, runnerToken, {
        data: { content: "Feature implemented", turnId },
        type: "runner.turn.completed",
      })

      expect((await streamedEvents)
        .filter(event => event.type !== "session.heartbeat")
        .map(event => event.type)).toEqual([
        "session.status",
        "turn.started",
        "response.output_item.done",
        "turn.completed",
      ])
    } finally {
      await server.stop()
    }
  })

  test("restores sessions from the workflow run directory after a server restart", async () => {
    const { createSessionApiServer } = await import(serverModulePath) as typeof import("./server.js")
    const runDirectory = await mkdtemp(path.join(os.tmpdir(), "mini-orch-run-"))
    const firstServer = createSessionApiServer({ runDirectory, token: "test-token" })
    const { baseUrl: firstBaseUrl } = await firstServer.start()

    try {
      const createResponse = await postJson(`${firstBaseUrl}/v1/sessions`, "test-token", {
        agent,
        role: "implementer",
        workspace: "/tmp/project",
      })
      const { session } = await createResponse.json() as { session: { id: string } }
      await firstServer.stop()

      const secondServer = createSessionApiServer({ runDirectory, token: "test-token" })
      const { baseUrl: secondBaseUrl } = await secondServer.start()
      try {
        const restored = await fetch(`${secondBaseUrl}/v1/sessions/${session.id}`, {
          headers: { authorization: "Bearer test-token" },
        })
        expect(await restored.json()).toMatchObject({ session: { id: session.id } })
      } finally {
        await secondServer.stop()
      }
    } finally {
      await firstServer.stop()
      await rm(runDirectory, { force: true, recursive: true })
    }
  })

  test("rejects forged runner events and accepts a registered runner token", async () => {
    const { createSessionApiServer } = await import(serverModulePath) as typeof import("./server.js")
    const server = createSessionApiServer({ runDirectory, token: "parent-token" })
    const { baseUrl } = await server.start()

    try {
      const createResponse = await postJson(`${baseUrl}/v1/sessions`, "parent-token", {
        agent,
        role: "implementer",
        workspace: "/tmp/project",
      })
      const created = await createResponse.json() as { session: { id: string }; runnerToken: string }

      const forged = await postJson(`${baseUrl}/v1/sessions/${created.session.id}/events`, "parent-token", {
        data: { reason: "fake", turnId: "missing" },
        source: "runner",
        type: "turn.failed",
      })
      expect(forged.status).toBe(403)

      const ready = await postJson(`${baseUrl}/v1/sessions/${created.session.id}/events`, created.runnerToken, {
        source: "runner",
        type: "runner.ready",
      })
      expect(ready.status).toBe(202)
    } finally {
      await server.stop()
    }
  })

  test("requires the runner token for every runner-specific event type", async () => {
    const { createSessionApiServer } = await import(serverModulePath) as typeof import("./server.js")
    const server = createSessionApiServer({ runDirectory, token: "parent-token" })
    const { baseUrl } = await server.start()

    try {
      const createResponse = await postJson(`${baseUrl}/v1/sessions`, "parent-token", {
        agent,
        role: "implementer",
        workspace: "/tmp/project",
      })
      const { session } = await createResponse.json() as { session: { id: string } }
      const response = await postJson(`${baseUrl}/v1/sessions/${session.id}/events`, "parent-token", {
        data: { content: "forged", turnId: "turn-1" },
        type: "turn.completed",
      })
      const statusResponse = await postJson(`${baseUrl}/v1/sessions/${session.id}/events`, "parent-token", {
        data: { status: "working" },
        type: "status",
      })

      expect(response.status).toBe(403)
      expect(statusResponse.status).toBe(403)
    } finally {
      await server.stop()
    }
  })

  test("requires a parsed AgentConfig on creation", async () => {
    const { createSessionApiServer } = await import(serverModulePath) as typeof import("./server.js")
    const server = createSessionApiServer({ runDirectory, token: "parent-token" })
    const { baseUrl } = await server.start()

    try {
      const response = await postJson(`${baseUrl}/v1/sessions`, "parent-token", {
        agent: "codex",
        role: "implementer",
        workspace: "/tmp/project",
      })
      expect(response.status).toBe(400)
    } finally {
      await server.stop()
    }
  })

  test("preserves delta and output item events for a turn", async () => {
    const { createSessionApiServer } = await import(serverModulePath) as typeof import("./server.js")
    const server = createSessionApiServer({ runDirectory, token: "parent-token" })
    const { baseUrl } = await server.start()

    try {
      const createResponse = await postJson(`${baseUrl}/v1/sessions`, "parent-token", {
        agent,
        role: "implementer",
        workspace: "/tmp/project",
      })
      const created = await createResponse.json() as { session: { id: string }; runnerToken: string }
      const message = await postJson(`${baseUrl}/v1/sessions/${created.session.id}/events`, "parent-token", {
        data: { content: "prompt" },
        eventId: "event-1",
        type: "message",
      })
      const { turnId } = await message.json() as { turnId: string }

      await postJson(`${baseUrl}/v1/sessions/${created.session.id}/events`, created.runnerToken, {
        data: { delta: "hello", turnId },
        source: "runner",
        type: "output_text.delta",
      })
      await postJson(`${baseUrl}/v1/sessions/${created.session.id}/events`, created.runnerToken, {
        data: { content: "hello world", turnId },
        source: "runner",
        type: "output_item.done",
      })
      await postJson(`${baseUrl}/v1/sessions/${created.session.id}/events`, created.runnerToken, {
        data: { turnId },
        source: "runner",
        type: "turn.completed",
      })

      const items = await fetch(`${baseUrl}/v1/sessions/${created.session.id}/items`, {
        headers: { authorization: "Bearer parent-token" },
      })
      expect(await items.json()).toMatchObject({
        items: [
          expect.objectContaining({ content: "prompt", role: "user" }),
          expect.objectContaining({ content: "hello world", role: "assistant", turnId }),
        ],
      })
    } finally {
      await server.stop()
    }
  })
})
