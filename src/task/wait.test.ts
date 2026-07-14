import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { createTask, reportTask, waitForTaskCompleted } from "./index.js"

describe("waitForTaskCompleted", () => {
  let tasksDir: string

  beforeEach(async () => {
    tasksDir = await mkdtemp(path.join(tmpdir(), "task-status-"))
  })

  afterEach(async () => {
    await rm(tasksDir, { recursive: true, force: true })
  })

  it("resolves when task reaches completed state", async () => {
    const { waitForTaskCompleted } = await import("./wait.js")
    const { filePath } = await createTask(tasksDir, "wait-1", "implementer")

    // 后台模拟 agent：先 started 再 completed
    const doReport = async () => {
      await reportTask(filePath, "started")
      await reportTask(filePath, "completed", "IMPLEMENT_DONE")
    }

    const [result] = await Promise.all([
      waitForTaskCompleted(filePath, { pollIntervalMs: 50, timeoutMs: 5000 }),
      doReport(),
    ])
    expect(result.state).toBe("completed")
    expect(result.status).toBe("IMPLEMENT_DONE")
  })

  it("ignores files with wrong runId in the same directory", async () => {
    const { waitForTaskCompleted } = await import("./wait.js")
    const { filePath } = await createTask(tasksDir, "wait-2", "implementer")
    // 创建另一个无关 task
    await createTask(tasksDir, "wait-other", "reviewer")

    const doReport = async () => {
      await reportTask(filePath, "started")
      await reportTask(filePath, "completed", "IMPLEMENT_DONE")
    }

    const [result] = await Promise.all([
      waitForTaskCompleted(filePath, { pollIntervalMs: 50, timeoutMs: 5000 }),
      doReport(),
    ])
    expect(result.runId).toBe("wait-2")
  })

  it("rejects on timeout with current state info", async () => {
    const { waitForTaskCompleted } = await import("./wait.js")
    const { filePath } = await createTask(tasksDir, "wait-3", "implementer")

    // agent 只回报 started，永远不 completed → 短超时
    await reportTask(filePath, "started")

    await expect(
      waitForTaskCompleted(filePath, { pollIntervalMs: 50, timeoutMs: 200 }),
    ).rejects.toThrow(/did not complete within timeout/)
  })

  it("rejects with file-not-found message when task file does not exist", async () => {
    const { waitForTaskCompleted } = await import("./wait.js")
    const missing = path.join(tasksDir, "nonexistent.json")

    await expect(
      waitForTaskCompleted(missing, { pollIntervalMs: 50, timeoutMs: 200 }),
    ).rejects.toThrow(/File not found/)
  })
})
