import { EventEmitter } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

import { spawn } from "node:child_process"
import type { AgentConfig } from "../types.js"
import { bootstrapSession } from "./index.js"

const makeAgent = (): AgentConfig => ({
  agent: "codex",
  name: "codex-implementer",
  command: "codex exec",
  integrationAgent: "codex",
})

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }

const queueHeadlessOutput = (output: string, code: number) => {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.stdout.emit("data", output)
      child.emit("close", code)
    })
    return child
  })
}

const settle = async <T>(promise: Promise<T>, stepMs: number, maxSteps: number) => {
  let done = false
  promise.then(
    () => { done = true },
    () => { done = true },
  )
  for (let i = 0; i < maxSteps && !done; i += 1) {
    await vi.advanceTimersByTimeAsync(stepMs)
  }
  await promise.catch(() => {})
}

describe("bootstrapSession retry", () => {
  let dir: string
  let jsonlFile: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "bootstrap-"))
    jsonlFile = path.join(dir, "session.jsonl")
    await writeFile(jsonlFile, "message line\n", "utf8")
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(dir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it("retries the whole bootstrap when the agent output is not parseable, then succeeds", async () => {
    queueHeadlessOutput("some chatty text without json", 0)
    queueHeadlessOutput(`{"resumeId":"resume-1","jsonl":"${jsonlFile}"}`, 0)

    const promise = bootstrapSession(dir, makeAgent(), undefined, { retryDelayMs: 10 })
    await settle(promise, 100, 100)

    await expect(promise).resolves.toMatchObject({ resumeId: "resume-1", jsonl: jsonlFile })
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it("gives up after three unsuccessful attempts", async () => {
    queueHeadlessOutput("not json", 0)
    queueHeadlessOutput("still not json", 0)
    queueHeadlessOutput("nope", 0)

    const promise = bootstrapSession(dir, makeAgent(), undefined, { retryDelayMs: 10 })
    await settle(promise, 100, 100)

    await expect(promise).rejects.toThrow(/could not parse/)
    expect(spawn).toHaveBeenCalledTimes(3)
  })

  it("does not retry on non-zero exit code beyond the attempt budget", async () => {
    queueHeadlessOutput("", 1)
    queueHeadlessOutput("", 1)
    queueHeadlessOutput("", 1)

    const promise = bootstrapSession(dir, makeAgent(), undefined, { retryDelayMs: 10 })
    await settle(promise, 100, 100)

    await expect(promise).rejects.toThrow(/exit 1/)
    expect(spawn).toHaveBeenCalledTimes(3)
  })

  it("throws when the jsonl file never appears, without re-bootstrapping", async () => {
    const missingFile = path.join(dir, "never.jsonl")
    queueHeadlessOutput(`{"resumeId":"resume-1","jsonl":"${missingFile}"}`, 0)

    const promise = bootstrapSession(dir, makeAgent(), undefined, { retryDelayMs: 10 })
    // 默认 jsonl 等待预算为 15s x 3，需推进足够模拟时长
    await settle(promise, 100, 600)

    await expect(promise).rejects.toThrow(/JSONL not ready/)
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
