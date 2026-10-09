import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { waitForJsonlReady } from "./jsonl-ready.js"

describe("waitForJsonlReady", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "jsonl-ready-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("returns the file size once the jsonl contains a newline", async () => {
    const file = path.join(dir, "session.jsonl")
    await writeFile(file, "first line\n", "utf8")

    await expect(waitForJsonlReady(file, "codex", { attempts: 1, waitMs: 500, pollMs: 20 }))
      .resolves.toBe(11)
  })

  it("keeps waiting on the same file after the first attempt times out", async () => {
    const file = path.join(dir, "late.jsonl")
    const promise = waitForJsonlReady(file, "codex", { attempts: 2, waitMs: 150, pollMs: 20 })

    await new Promise((resolve) => setTimeout(resolve, 250))
    await writeFile(file, "late line\n", "utf8")

    await expect(promise).resolves.toBe(10)
  })

  it("rejects after all attempts time out without creating the file", async () => {
    const file = path.join(dir, "missing.jsonl")

    await expect(waitForJsonlReady(file, "codex", { attempts: 2, waitMs: 100, pollMs: 20 }))
      .rejects.toThrow(/JSONL not ready/)
  })

  it("requires the directory to exist before polling succeeds", async () => {
    const file = path.join(dir, "nested", "session.jsonl")

    const promise = waitForJsonlReady(file, "codex", { attempts: 3, waitMs: 100, pollMs: 20 })
    await new Promise((resolve) => setTimeout(resolve, 250))
    await mkdir(path.dirname(file))
    await writeFile(file, "nested line\n", "utf8")

    await expect(promise).resolves.toBe(12)
  })
})
