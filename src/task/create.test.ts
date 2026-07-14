import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { createTask, readTask } from "./index.js"

describe("createTask", () => {
  let tasksDir: string

  beforeEach(async () => {
    tasksDir = await mkdtemp(path.join(tmpdir(), "task-status-"))
  })

  afterEach(async () => {
    await rm(tasksDir, { recursive: true, force: true })
  })

  it("creates a task file with pending state", async () => {
    const { filePath } = await createTask(tasksDir, "0-implementer-r1-abc", "implementer")

    const task = await readTask(filePath)
    expect(task.runId).toBe("0-implementer-r1-abc")
    expect(task.role).toBe("implementer")
    expect(task.state).toBe("pending")
    expect(task.createdAt).toBeTruthy()
    expect(task.updatedAt).toBeTruthy()
    expect(task.status).toBeUndefined()
  })

  it("returns the absolute file path", async () => {
    const { filePath } = await createTask(tasksDir, "test-123", "reviewer")

    expect(filePath).toBe(path.join(tasksDir, "test-123.json"))
  })

  it("creates the tasks directory if it does not exist", async () => {
    const nested = path.join(tasksDir, "nested", "sub")
    const { filePath } = await createTask(nested, "deep-task", "implementer")

    const task = await readTask(filePath)
    expect(task.state).toBe("pending")
  })

  it("retries with unique suffix when target file already exists", async () => {
    const { writeFile } = await import("node:fs/promises")
    const runId = "0-reviewer-r1-resume-test"
    const filePath = path.join(tasksDir, `${runId}.json`)
    const oldContent = JSON.stringify({
      runId, role: "reviewer", state: "completed", status: "REVIEW_PASS",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })
    await writeFile(filePath, oldContent, "utf8")

    const result = await createTask(tasksDir, runId, "reviewer")

    expect(result.filePath).not.toBe(filePath)
    expect(result.runId).toMatch(new RegExp(`^${runId}-`))
    const oldTask = await readTask(filePath)
    expect(oldTask.runId).toBe(runId)
    expect(oldTask.state).toBe("completed")
    const newTask = await readTask(result.filePath)
    expect(newTask.runId).toBe(result.runId)
    expect(newTask.state).toBe("pending")
  })

  it("does not throw when creating task with a different runId in same directory", async () => {
    const { writeFile } = await import("node:fs/promises")
    await writeFile(
      path.join(tasksDir, "old-task.json"),
      JSON.stringify({ runId: "old-task", role: "reviewer", state: "completed", status: "REVIEW_PASS", createdAt: "x", updatedAt: "x" }),
      "utf8",
    )

    const { filePath } = await createTask(tasksDir, "new-task", "implementer")
    const task = await readTask(filePath)
    expect(task.runId).toBe("new-task")
    expect(task.state).toBe("pending")
  })
})
