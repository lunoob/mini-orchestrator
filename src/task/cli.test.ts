import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { createTask, readTask, reportTask } from "./index.js"

describe("handleReportTaskCli", () => {
  let tasksDir: string

  beforeEach(async () => {
    tasksDir = await mkdtemp(path.join(tmpdir(), "task-status-"))
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(async () => {
    await rm(tasksDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const runHandler = async (args: string[]) => {
    const { handleReportTaskCli } = await import("./cli.js")
    return handleReportTaskCli(args)
  }

  it("reports started state for a valid task file", async () => {
    const { filePath } = await createTask(tasksDir, "cli-1", "implementer")

    await runHandler(["report-task", "--task", filePath, "--state", "started"])

    const task = await readTask(filePath)
    expect(task.state).toBe("started")
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("started"))
  })

  it("reports completed state with status for a valid task file", async () => {
    const { filePath } = await createTask(tasksDir, "cli-2", "reviewer")
    await reportTask(filePath, "started")

    await runHandler([
      "report-task", "--task", filePath, "--state", "completed", "--status", "REVIEW_PASS",
    ])

    const task = await readTask(filePath)
    expect(task.state).toBe("completed")
    expect(task.status).toBe("REVIEW_PASS")
  })

  it("throws on missing --task argument", async () => {
    await expect(
      runHandler(["report-task", "--state", "started"]),
    ).rejects.toThrow(/Missing required argument --task/)
  })

  it("throws on missing --state argument", async () => {
    const { filePath } = await createTask(tasksDir, "cli-3", "implementer")

    await expect(
      runHandler(["report-task", "--task", filePath]),
    ).rejects.toThrow(/Missing required argument --state/)
  })

  it("throws on invalid state value", async () => {
    const { filePath } = await createTask(tasksDir, "cli-4", "implementer")

    await expect(
      runHandler(["report-task", "--task", filePath, "--state", "invalid"]),
    ).rejects.toThrow(/Invalid state/)
  })

  it("throws on completed without --status", async () => {
    const { filePath } = await createTask(tasksDir, "cli-5", "implementer")
    await reportTask(filePath, "started")

    await expect(
      runHandler(["report-task", "--task", filePath, "--state", "completed"]),
    ).rejects.toThrow(/Missing required argument --status/)
  })

  it("prints success message on completion", async () => {
    const { filePath } = await createTask(tasksDir, "cli-6", "implementer")
    await reportTask(filePath, "started")

    await runHandler([
      "report-task", "--task", filePath, "--state", "completed", "--status", "IMPLEMENT_DONE",
    ])

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Task cli-6: started → completed (IMPLEMENT_DONE)"),
    )
  })
})
