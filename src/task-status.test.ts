import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { TaskRole } from "./types.js"
import { createTask, readTask, reportTask, TASK_STATUSES_BY_ROLE } from "./task-status.js"

describe("TASK_STATUSES_BY_ROLE", () => {
  it("implementer only allows IMPLEMENT_DONE and IMPLEMENT_ASK", () => {
    expect(TASK_STATUSES_BY_ROLE.implementer).toEqual(["IMPLEMENT_DONE", "IMPLEMENT_ASK"])
  })

  it("reviewer only allows REVIEW_PASS, REVIEW_FAIL, REVIEW_NEEDS_CHECK", () => {
    expect(TASK_STATUSES_BY_ROLE.reviewer).toEqual(["REVIEW_PASS", "REVIEW_FAIL", "REVIEW_NEEDS_CHECK"])
  })
})

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
    // 手动创建文件模拟上一次运行的残留任务
    const { writeFile } = await import("node:fs/promises")
    const runId = "0-reviewer-r1-resume-test"
    const filePath = path.join(tasksDir, `${runId}.json`)
    const oldContent = JSON.stringify({
      runId, role: "reviewer", state: "completed", status: "REVIEW_PASS",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })
    await writeFile(filePath, oldContent, "utf8")

    // createTask 应自动重试并生成新的唯一文件，不覆盖旧文件
    const result = await createTask(tasksDir, runId, "reviewer")

    // 新文件路径应不同于被占用的旧路径
    expect(result.filePath).not.toBe(filePath)
    // 新 runId 以原 runId 为前缀并追加 UUID
    expect(result.runId).toMatch(new RegExp(`^${runId}-`))
    // 旧文件内容未被覆盖
    const oldTask = await readTask(filePath)
    expect(oldTask.runId).toBe(runId)
    expect(oldTask.state).toBe("completed")
    // 新文件为 pending 状态且 runId 匹配
    const newTask = await readTask(result.filePath)
    expect(newTask.runId).toBe(result.runId)
    expect(newTask.state).toBe("pending")
  })

  it("does not throw when creating task with a different runId in same directory", async () => {
    // 目录中有其他文件不应影响新任务创建
    const { writeFile } = await import("node:fs/promises")
    await writeFile(
      path.join(tasksDir, "old-task.json"),
      JSON.stringify({ runId: "old-task", role: "reviewer", state: "completed", status: "REVIEW_PASS", createdAt: "x", updatedAt: "x" }),
      "utf8",
    )

    // 创建不同 runId 的任务应成功
    const { filePath } = await createTask(tasksDir, "new-task", "implementer")
    const task = await readTask(filePath)
    expect(task.runId).toBe("new-task")
    expect(task.state).toBe("pending")
  })
})

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

describe("waitForTaskCompleted", () => {
  let tasksDir: string

  beforeEach(async () => {
    tasksDir = await mkdtemp(path.join(tmpdir(), "task-status-"))
  })

  afterEach(async () => {
    await rm(tasksDir, { recursive: true, force: true })
  })

  it("resolves when task reaches completed state", async () => {
    const { waitForTaskCompleted } = await import("./task-status.js")
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
    const { waitForTaskCompleted } = await import("./task-status.js")
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
    const { waitForTaskCompleted } = await import("./task-status.js")
    const { filePath } = await createTask(tasksDir, "wait-3", "implementer")

    // agent 只回报 started，永远不 completed → 短超时
    await reportTask(filePath, "started")

    await expect(
      waitForTaskCompleted(filePath, { pollIntervalMs: 50, timeoutMs: 200 }),
    ).rejects.toThrow(/did not complete within timeout/)
  })

  it("rejects with file-not-found message when task file does not exist", async () => {
    const { waitForTaskCompleted } = await import("./task-status.js")
    const missing = path.join(tasksDir, "nonexistent.json")

    await expect(
      waitForTaskCompleted(missing, { pollIntervalMs: 50, timeoutMs: 200 }),
    ).rejects.toThrow(/File not found/)
  })
})

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
    const { handleReportTaskCli } = await import("./task-status.js")
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

describe("readAgentOutputWithRetry", () => {
  // 使用真计时器 + 极短间隔避免测试耗时，同时避开 fake timers 与 async readFn 的交互问题

  const makeReadFn = (responses: string[]) => {
    let callCount = 0
    return () => {
      const res = responses[callCount] ?? responses[responses.length - 1]
      callCount++
      return Promise.resolve(res)
    }
  }

  it("returns output immediately if valid on first attempt", async () => {
    const { readAgentOutputWithRetry } = await import("./herdr.js")
    const readFn = makeReadFn(["---IMPLEMENT_RESULT_START---\nDONE\n---IMPLEMENT_RESULT_END---"])

    const result = await readAgentOutputWithRetry(
      "p1", 280,
      (o) => o.includes("IMPLEMENT_RESULT_START"),
      3, 1,
      readFn as any,
    )

    expect(result).toContain("DONE")
  })

  it("retries when output does not pass validation", async () => {
    const { readAgentOutputWithRetry } = await import("./herdr.js")
    const readFn = makeReadFn([
      "",                                          // 空 — 无效
      "some logs but no delimiters",               // 无分隔符 — 无效
      "---IMPLEMENT_RESULT_START---\nOK\n---IMPLEMENT_RESULT_END---", // 有效
    ])

    const isValid = (o: string) => {
      const s = o.lastIndexOf("---IMPLEMENT_RESULT_START---")
      if (s === -1) return false
      const e = o.lastIndexOf("---IMPLEMENT_RESULT_END---")
      if (e <= s + "---IMPLEMENT_RESULT_START---".length) return false
      return o.slice(s + "---IMPLEMENT_RESULT_START---".length, e).trim().length > 0
    }

    const result = await readAgentOutputWithRetry("p2", 280, isValid, 3, 1, readFn as any)

    expect(result).toContain("OK")
  })

  it("throws after max retries with sync error message", async () => {
    const { readAgentOutputWithRetry } = await import("./herdr.js")
    const readFn = makeReadFn(["", "", ""]) // 全部无效

    await expect(
      readAgentOutputWithRetry("p3", 280, (o) => o.trim().length > 0, 3, 1, readFn as any),
    ).rejects.toThrow(/output not synced/)
  })

  it("does not retry if validation passes on second attempt", async () => {
    const { readAgentOutputWithRetry } = await import("./herdr.js")
    const readFn = makeReadFn([
      "---IMPLEMENT_RESULT_START---\n---IMPLEMENT_RESULT_END---", // 分隔符之间为空 — 无效
      "---IMPLEMENT_RESULT_START---\nFINAL\n---IMPLEMENT_RESULT_END---", // 有效
    ])

    const isValid = (o: string) => {
      const s = o.lastIndexOf("---IMPLEMENT_RESULT_START---")
      if (s === -1) return false
      const e = o.lastIndexOf("---IMPLEMENT_RESULT_END---")
      if (e <= s + "---IMPLEMENT_RESULT_START---".length) return false
      return o.slice(s + "---IMPLEMENT_RESULT_START---".length, e).trim().length > 0
    }

    const result = await readAgentOutputWithRetry("p4", 280, isValid, 3, 1, readFn as any)

    expect(result).toContain("FINAL")
  })
})

describe("waitForOutputAfterCompletion — 5s delay before first read", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("does not call readFn before the 5-second delay elapses", async () => {
    const { waitForOutputAfterCompletion } = await import("./workflow.js")
    const readFn = vi.fn().mockResolvedValue("---REVIEW_RESULT_START---\nOK\n---REVIEW_RESULT_END---")

    const promise = waitForOutputAfterCompletion("p1", "reviewer", 5000, readFn)

    // 推进 4 秒 — readFn 应尚未被调用
    await vi.advanceTimersByTimeAsync(4000)
    expect(readFn).not.toHaveBeenCalled()

    // 推进到 5 秒 — readFn 应被调用
    await vi.advanceTimersByTimeAsync(1000)
    const result = await promise
    expect(readFn).toHaveBeenCalledTimes(1)
    expect(result).toContain("OK")
  })

  it("passes the correct delimiter-aware isValid to readFn", async () => {
    const { waitForOutputAfterCompletion } = await import("./workflow.js")
    // readFn 替换的是 readAgentOutputWithRetry，接收 (paneId, lines, isValid, ...)
    // 在此验证传入的 isValid 能否正确识别分隔符与正文
    const readFn = vi.fn((_paneId: string, _lines: number, isValid: (o: string) => boolean) => {
      // 无分隔符 → 无效
      expect(isValid("no delimiters")).toBe(false)
      // 分隔符间为空 → 无效
      expect(isValid("---IMPLEMENT_RESULT_START---\n\n---IMPLEMENT_RESULT_END---")).toBe(false)
      // 分隔符完整且正文非空 → 有效
      expect(isValid("---IMPLEMENT_RESULT_START---\nWORK\n---IMPLEMENT_RESULT_END---")).toBe(true)
      return Promise.resolve("---IMPLEMENT_RESULT_START---\nWORK\n---IMPLEMENT_RESULT_END---")
    })

    const promise = waitForOutputAfterCompletion("p2", "implementer", 10, readFn as any)

    await vi.advanceTimersByTimeAsync(500)
    const result = await promise
    expect(result).toContain("WORK")
    expect(readFn).toHaveBeenCalledTimes(1)
  })

  it("uses the injected delayMs instead of default 5000", async () => {
    const { waitForOutputAfterCompletion } = await import("./workflow.js")
    const readFn = vi.fn().mockResolvedValue("---REVIEW_RESULT_START---\nFAST\n---REVIEW_RESULT_END---")

    const promise = waitForOutputAfterCompletion("p3", "reviewer", 100, readFn)

    // 推进 99ms — 尚未调用
    await vi.advanceTimersByTimeAsync(99)
    expect(readFn).not.toHaveBeenCalled()

    // 推进到 100ms — 应调用
    await vi.advanceTimersByTimeAsync(1)
    const result = await promise
    expect(readFn).toHaveBeenCalledTimes(1)
    expect(result).toContain("FAST")
  })
})

describe("mapTaskToReviewVerdict — file status priority over output STATUS lines", () => {
  it("returns fail when task file says REVIEW_FAIL, even if output says REVIEW_PASS", async () => {
    // 从 workflow.ts 动态导入（避免顶层模块初始化）
    const { mapTaskToReviewVerdict } = await import("./workflow.js")

    const task = {
      runId: "test",
      role: "reviewer" as const,
      state: "completed" as const,
      status: "REVIEW_FAIL" as const,
      createdAt: "now",
      updatedAt: "now",
    }

    // 输出中包含 STATUS: REVIEW_PASS，但任务文件是 REVIEW_FAIL
    const output = [
      "---REVIEW_RESULT_START---",
      "STATUS: REVIEW_PASS",
      "All good!",
      "---REVIEW_RESULT_END---",
    ].join("\n")

    const verdict = mapTaskToReviewVerdict(task, output)

    expect(verdict.kind).toBe("fail")
    expect(verdict.passed).toBe(false)
  })

  it("returns pass when task file says REVIEW_PASS, even if output lacks explicit STATUS", async () => {
    const { mapTaskToReviewVerdict } = await import("./workflow.js")

    const task = {
      runId: "test",
      role: "reviewer" as const,
      state: "completed" as const,
      status: "REVIEW_PASS" as const,
      createdAt: "now",
      updatedAt: "now",
    }

    // 输出中没有明确的 STATUS 行（模拟边界情况）
    const output = [
      "---REVIEW_RESULT_START---",
      "Everything looks good, no issues found.",
      "---REVIEW_RESULT_END---",
    ].join("\n")

    const verdict = mapTaskToReviewVerdict(task, output)

    expect(verdict.kind).toBe("pass")
    expect(verdict.passed).toBe(true)
  })

  it("returns needs_check when task file says REVIEW_NEEDS_CHECK", async () => {
    const { mapTaskToReviewVerdict } = await import("./workflow.js")

    const task = {
      runId: "test",
      role: "reviewer" as const,
      state: "completed" as const,
      status: "REVIEW_NEEDS_CHECK" as const,
      createdAt: "now",
      updatedAt: "now",
    }

    const output = [
      "---REVIEW_RESULT_START---",
      "STATUS: REVIEW_NEEDS_CHECK",
      "⚠️ Cannot verify from diff: E2E behavior",
      "---REVIEW_RESULT_END---",
    ].join("\n")

    const verdict = mapTaskToReviewVerdict(task, output)

    expect(verdict.kind).toBe("needs_check")
    expect(verdict.passed).toBe(false)
    // cannotVerifySummary 仍从 output 提取
    expect(verdict.hasCannotVerify).toBe(true)
    expect(verdict.cannotVerifySummary).toContain("E2E behavior")
  })

  it("cannotVerifySummary is extracted from output even when file says pass", async () => {
    const { mapTaskToReviewVerdict } = await import("./workflow.js")

    const task = {
      runId: "test",
      role: "reviewer" as const,
      state: "completed" as const,
      status: "REVIEW_PASS" as const,
      createdAt: "now",
      updatedAt: "now",
    }

    // 输出包含 Cannot verify 段落但 task 说 pass
    const output = [
      "---REVIEW_RESULT_START---",
      "STATUS: REVIEW_PASS",
      "⚠️ Cannot verify from diff: integration test coverage",
      "---REVIEW_RESULT_END---",
    ].join("\n")

    const verdict = mapTaskToReviewVerdict(task, output)

    // 文件为准 → pass
    expect(verdict.kind).toBe("pass")
    // cannotVerifySummary 仍从 output 提取
    expect(verdict.hasCannotVerify).toBe(true)
    expect(verdict.cannotVerifySummary).toContain("integration test coverage")
  })
})

describe("buildRunId — unique across processes (no shared counter)", () => {
  it("produces different IDs for same parameters on successive calls", async () => {
    const { buildRunId } = await import("./workflow.js")

    const id1 = buildRunId(0, "implementer", 1)
    const id2 = buildRunId(0, "implementer", 1)

    // 同一进程内同样参数也生成不同 ID（随机后缀，非递增计数器）
    expect(id1).not.toBe(id2)
  })

  it("includes issueIndex, role, round in the ID", async () => {
    const { buildRunId } = await import("./workflow.js")

    const id = buildRunId(2, "reviewer", 3, "controller")
    expect(id).toMatch(/^2-reviewer-r3-controller-/)
  })

  it("produces IDs with full UUID suffix (128-bit entropy)", async () => {
    const { buildRunId } = await import("./workflow.js")

    // 格式: <issue>-<role>-r<round>-<full UUID>
    const id = buildRunId(0, "implementer", 1)
    expect(id).toMatch(
      /^0-implementer-r1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )

    const ids = Array.from({ length: 5 }, () => buildRunId(0, "implementer", 1))
    expect(new Set(ids).size).toBe(5)
  })
})
