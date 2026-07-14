import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { TaskRole } from "../types.js"
import { createTask, readTask, reportTask } from "./index.js"

describe("reportTask state transitions", () => {
  let tasksDir: string

  const setupTask = async (runId: string, role: TaskRole) => {
    const { filePath } = await createTask(tasksDir, runId, role)
    return filePath
  }

  beforeEach(async () => {
    tasksDir = await mkdtemp(path.join(tmpdir(), "task-status-"))
  })

  afterEach(async () => {
    await rm(tasksDir, { recursive: true, force: true })
  })

  // 合法转换

  it("pending → started is valid", async () => {
    const filePath = await setupTask("t1", "implementer")
    const updated = await reportTask(filePath, "started")

    expect(updated.state).toBe("started")
    expect(updated.status).toBeUndefined()
  })

  it("started → completed with IMPLEMENT_DONE is valid", async () => {
    const filePath = await setupTask("t2", "implementer")
    await reportTask(filePath, "started")
    const updated = await reportTask(filePath, "completed", "IMPLEMENT_DONE")

    expect(updated.state).toBe("completed")
    expect(updated.status).toBe("IMPLEMENT_DONE")
  })

  it("started → completed with IMPLEMENT_ASK is valid", async () => {
    const filePath = await setupTask("t3", "implementer")
    await reportTask(filePath, "started")
    const updated = await reportTask(filePath, "completed", "IMPLEMENT_ASK")

    expect(updated.status).toBe("IMPLEMENT_ASK")
  })

  it("started → completed with REVIEW_PASS is valid", async () => {
    const filePath = await setupTask("t4", "reviewer")
    await reportTask(filePath, "started")
    const updated = await reportTask(filePath, "completed", "REVIEW_PASS")

    expect(updated.status).toBe("REVIEW_PASS")
  })

  it("started → completed with REVIEW_FAIL is valid", async () => {
    const filePath = await setupTask("t5", "reviewer")
    await reportTask(filePath, "started")
    const updated = await reportTask(filePath, "completed", "REVIEW_FAIL")

    expect(updated.status).toBe("REVIEW_FAIL")
  })

  it("started → completed with REVIEW_NEEDS_CHECK is valid", async () => {
    const filePath = await setupTask("t6", "reviewer")
    await reportTask(filePath, "started")
    const updated = await reportTask(filePath, "completed", "REVIEW_NEEDS_CHECK")

    expect(updated.status).toBe("REVIEW_NEEDS_CHECK")
  })

  // 非法转换

  it("rejects completed → started (backwards transition)", async () => {
    const filePath = await setupTask("t7", "implementer")
    await reportTask(filePath, "started")
    await reportTask(filePath, "completed", "IMPLEMENT_DONE")

    await expect(reportTask(filePath, "started")).rejects.toThrow("Invalid transition")
  })

  it("rejects started → started (duplicate transition)", async () => {
    const filePath = await setupTask("t8", "implementer")
    await reportTask(filePath, "started")

    await expect(reportTask(filePath, "started")).rejects.toThrow("Invalid transition")
  })

  it("rejects completed → completed (re-completion)", async () => {
    const filePath = await setupTask("t9", "implementer")
    await reportTask(filePath, "started")
    await reportTask(filePath, "completed", "IMPLEMENT_DONE")

    await expect(reportTask(filePath, "completed", "IMPLEMENT_DONE")).rejects.toThrow("Invalid transition")
  })

  it("rejects pending → completed (skip started)", async () => {
    const filePath = await setupTask("t10", "implementer")

    await expect(reportTask(filePath, "completed", "IMPLEMENT_DONE")).rejects.toThrow("Invalid transition")
  })

  it("rejects pending → pending (no-op transition)", async () => {
    const filePath = await setupTask("t11", "implementer")

    await expect(reportTask(filePath, "pending")).rejects.toThrow("Invalid transition")
  })

  // 角色/状态不匹配

  it("rejects REVIEW_PASS for implementer role", async () => {
    const filePath = await setupTask("t12", "implementer")
    await reportTask(filePath, "started")

    await expect(reportTask(filePath, "completed", "REVIEW_PASS" as any)).rejects.toThrow("Invalid status")
  })

  it("rejects IMPLEMENT_DONE for reviewer role", async () => {
    const filePath = await setupTask("t13", "reviewer")
    await reportTask(filePath, "started")

    await expect(reportTask(filePath, "completed", "IMPLEMENT_DONE" as any)).rejects.toThrow("Invalid status")
  })

  // 缺少 status

  it("rejects completed without status", async () => {
    const filePath = await setupTask("t14", "implementer")
    await reportTask(filePath, "started")

    await expect(reportTask(filePath, "completed" as any)).rejects.toThrow("Status is required")
  })

  it("rejects when file runId does not match filename", async () => {
    const { writeFile } = await import("node:fs/promises")
    // 文件名是 "t-mismatch.json"，但内容 runId 是 "different-id"
    const filePath = path.join(tasksDir, "t-mismatch.json")
    await writeFile(filePath, JSON.stringify({
      runId: "different-id", role: "implementer", state: "pending",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }), "utf8")

    await expect(reportTask(filePath, "started")).rejects.toThrow(/RunId mismatch/)
  })
})

describe("reportTask atomic write", () => {
  let tasksDir: string

  beforeEach(async () => {
    tasksDir = await mkdtemp(path.join(tmpdir(), "task-status-"))
  })

  afterEach(async () => {
    await rm(tasksDir, { recursive: true, force: true })
  })

  it("does not leave .tmp files after write", async () => {
    const { filePath } = await createTask(tasksDir, "atomic-1", "reviewer")
    await reportTask(filePath, "started")

    const files = await readdir(tasksDir)
    const tmpFiles = files.filter(f => f.endsWith(".tmp"))
    expect(tmpFiles).toHaveLength(0)
  })

  it("persists the updated state to disk", async () => {
    const { filePath } = await createTask(tasksDir, "atomic-2", "implementer")
    await reportTask(filePath, "started")

    // Re-read from disk to confirm persistence
    const onDisk = await readTask(filePath)
    expect(onDisk.state).toBe("started")
    expect(onDisk.updatedAt).toBeTruthy()
  })
})
