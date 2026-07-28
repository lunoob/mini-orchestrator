import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, test } from "vitest"

import { createSessionStore } from "./store.js"

const persistModulePath = "./persist.js"
const agent = {
  agent: "codex",
  command: "codex",
  integrationAgent: "codex",
  name: "codex",
}

describe("session persistence", () => {
  test("writes and reads a durable store snapshot below the workflow run directory", async () => {
    const { readSessionSnapshot, writeSessionSnapshot } =
      await import(persistModulePath) as typeof import("./persist.js")
    const directory = await mkdtemp(path.join(os.tmpdir(), "mini-orch-session-"))
    const store = createSessionStore({ createId: () => "turn-1" })
    store.create({
      agent,
      id: "session-1",
      role: "implementer",
      runDirectory: directory,
      workspace: "/tmp/project",
    })

    try {
      const filePath = await writeSessionSnapshot(directory, store.snapshot())
      const snapshot = await readSessionSnapshot(directory)

      expect(filePath).toBe(path.join(directory, "sessions.json"))
      expect(snapshot).toMatchObject({
        sessions: [expect.objectContaining({ id: "session-1" })],
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
