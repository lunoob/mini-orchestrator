import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { readTask } from "./index.js"

describe("readTask", () => {
  let tasksDir: string

  beforeEach(async () => {
    tasksDir = await mkdtemp(path.join(tmpdir(), "task-status-"))
  })

  afterEach(async () => {
    await rm(tasksDir, { recursive: true, force: true })
  })

  it("throws on missing file", async () => {
    const missing = path.join(tasksDir, "nonexistent.json")
    await expect(readTask(missing)).rejects.toThrow()
  })

  it("throws on corrupted JSON", async () => {
    const { writeFile } = await import("node:fs/promises")
    const filePath = path.join(tasksDir, "corrupt.json")
    await writeFile(filePath, "not json", "utf8")

    await expect(readTask(filePath)).rejects.toThrow()
  })

  it("throws on file missing required fields", async () => {
    const { writeFile } = await import("node:fs/promises")
    const filePath = path.join(tasksDir, "incomplete.json")
    await writeFile(filePath, JSON.stringify({ runId: "x" }), "utf8")

    await expect(readTask(filePath)).rejects.toThrow(/invalid.*missing.*role/i)
  })

  it("throws on invalid role value", async () => {
    const { writeFile } = await import("node:fs/promises")
    const filePath = path.join(tasksDir, "bad-role.json")
    await writeFile(filePath, JSON.stringify({
      runId: "x", role: "supervisor", state: "pending", createdAt: "2024-01-01", updatedAt: "2024-01-01",
    }), "utf8")

    await expect(readTask(filePath)).rejects.toThrow(/invalid.*role/i)
  })

  it("throws on invalid state value", async () => {
    const { writeFile } = await import("node:fs/promises")
    const filePath = path.join(tasksDir, "bad-state.json")
    await writeFile(filePath, JSON.stringify({
      runId: "x", role: "implementer", state: "finished", createdAt: "2024-01-01", updatedAt: "2024-01-01",
    }), "utf8")

    await expect(readTask(filePath)).rejects.toThrow(/invalid.*state/i)
  })

  it("throws on missing updatedAt", async () => {
    const { writeFile } = await import("node:fs/promises")
    const filePath = path.join(tasksDir, "no-updated.json")
    await writeFile(filePath, JSON.stringify({
      runId: "x", role: "reviewer", state: "pending", createdAt: "2024-01-01",
    }), "utf8")

    await expect(readTask(filePath)).rejects.toThrow(/required field.*updatedAt/i)
  })

  it("throws on completed state without status", async () => {
    const { writeFile } = await import("node:fs/promises")
    const filePath = path.join(tasksDir, "completed-no-status.json")
    await writeFile(filePath, JSON.stringify({
      runId: "x", role: "implementer", state: "completed", createdAt: "2024-01-01", updatedAt: "2024-01-01",
    }), "utf8")

    await expect(readTask(filePath)).rejects.toThrow(/completed.*status/i)
  })

  it("throws on completed state with mismatched status for role", async () => {
    const { writeFile } = await import("node:fs/promises")
    const filePath = path.join(tasksDir, "bad-status.json")
    // REVIEW_PASS is for reviewer, not implementer
    await writeFile(filePath, JSON.stringify({
      runId: "x", role: "implementer", state: "completed", status: "REVIEW_PASS",
      createdAt: "2024-01-01", updatedAt: "2024-01-01",
    }), "utf8")

    await expect(readTask(filePath)).rejects.toThrow(/status.*role/i)
  })

  it("accepts a valid completed task with matching status", async () => {
    const { writeFile } = await import("node:fs/promises")
    const filePath = path.join(tasksDir, "valid-completed.json")
    await writeFile(filePath, JSON.stringify({
      runId: "x", role: "reviewer", state: "completed", status: "REVIEW_PASS",
      createdAt: "2024-01-01", updatedAt: "2024-01-01",
    }), "utf8")

    const task = await readTask(filePath)
    expect(task.state).toBe("completed")
    expect(task.status).toBe("REVIEW_PASS")
  })
})
