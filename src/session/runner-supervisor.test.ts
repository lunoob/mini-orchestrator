import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, test, vi } from "vitest"

import { createSessionApiServer } from "./server.js"
import { createSessionClient } from "./client.js"
import { createRunnerSupervisor } from "./runner-supervisor.js"
import type { PaneBridge } from "./pane-bridge.js"

const agent = { agent: "codex", command: "codex", integrationAgent: "codex", name: "codex" }

describe("RunnerSupervisor", () => {
  test("waits for runner.ready and returns the session/pane mapping", async () => {
    const runDirectory = await mkdtemp(path.join(os.tmpdir(), "mini-orch-supervisor-"))
    const server = createSessionApiServer({ runDirectory, token: "parent-token" })
    const { baseUrl } = await server.start()
    const parent = createSessionClient({ baseUrl, token: "parent-token" })
    const createResponse = await fetch(`${baseUrl}/v1/sessions`, {
      body: JSON.stringify({ agent, role: "implementer", workspace: "/tmp/project" }),
      headers: { authorization: "Bearer parent-token", "content-type": "application/json" },
      method: "POST",
    })
    const created = await createResponse.json() as { runnerToken: string; session: { id: string } }
    let paneClosed: ((error: Error) => void) | undefined
    const paneBridge: PaneBridge = {
      bootstrap: vi.fn(async (_paneId, command) => {
        const configPath = command.split("--config ")[1].replace(/^['"]|['"]$/g, "")
        const config = JSON.parse(await readFile(configPath, "utf8")) as { baseUrl: string; runnerToken: string; sessionId: string }
        await createSessionClient({ baseUrl: config.baseUrl, token: config.runnerToken }).postEvent(config.sessionId, { source: "runner", type: "runner.ready" })
      }),
      close: vi.fn(async () => undefined),
      split: vi.fn(async () => "pane-1"),
      watch: vi.fn((_paneId, onClosed) => {
        paneClosed = onClosed
        return () => undefined
      }),
    }

    try {
      const supervisor = createRunnerSupervisor({
        agent,
        baseUrl,
        paneBridge,
        projectDir: "/tmp/project",
        runDirectory,
        runnerToken: created.runnerToken,
        sessionId: created.session.id,
        sessionClient: parent,
      })
      await expect(supervisor.start()).resolves.toMatchObject({ paneId: "pane-1", sessionId: created.session.id })
      expect(paneBridge.bootstrap).toHaveBeenCalledTimes(1)
      paneClosed?.(new Error("pane closed by user"))
      await expect.poll(async () => (await parent.get(created.session.id)).status, { timeout: 500 }).toBe("failed")
      await supervisor.stop()
    } finally {
      await server.stop()
      await rm(runDirectory, { force: true, recursive: true })
    }
  })

  test("cleans the pane when the runner does not become ready before timeout", async () => {
    const runDirectory = await mkdtemp(path.join(os.tmpdir(), "mini-orch-supervisor-timeout-"))
    const paneBridge: PaneBridge = {
      bootstrap: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      split: vi.fn(async () => "pane-timeout"),
    }

    const supervisor = createRunnerSupervisor({
      agent,
      baseUrl: "http://127.0.0.1:1",
      paneBridge,
      projectDir: "/tmp/project",
      readyTimeoutMs: 5,
      runDirectory,
      runnerToken: "runner-token",
      sessionId: "session-timeout",
      sessionClient: {
        postEvent: vi.fn(async () => undefined),
        stream: async function* () { await new Promise(() => undefined) },
      } as never,
    })

    await expect(supervisor.start()).rejects.toThrow(/ready/i)
    expect(paneBridge.close).toHaveBeenCalledWith("pane-timeout")
    await rm(runDirectory, { force: true, recursive: true })
  })
})
