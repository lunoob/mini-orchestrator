import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"

describe("waitForOutputAfterCompletion — 5s delay before first read", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("does not call readFn before the 5-second delay elapses", async () => {
    const { waitForOutputAfterCompletion } = await import("./dispatch.js")
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
    const { waitForOutputAfterCompletion } = await import("./dispatch.js")
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
    const { waitForOutputAfterCompletion } = await import("./dispatch.js")
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
    const { mapTaskToReviewVerdict } = await import("./dispatch.js")

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
    const { mapTaskToReviewVerdict } = await import("./dispatch.js")

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
    const { mapTaskToReviewVerdict } = await import("./dispatch.js")

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
    const { mapTaskToReviewVerdict } = await import("./dispatch.js")

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
    const { buildRunId } = await import("./dispatch.js")

    const id1 = buildRunId(0, "implementer", 1)
    const id2 = buildRunId(0, "implementer", 1)

    // 同一进程内同样参数也生成不同 ID（随机后缀，非递增计数器）
    expect(id1).not.toBe(id2)
  })

  it("includes issueIndex, role, round in the ID", async () => {
    const { buildRunId } = await import("./dispatch.js")

    const id = buildRunId(2, "reviewer", 3, "controller")
    expect(id).toMatch(/^2-reviewer-r3-controller-/)
  })

  it("produces IDs with full UUID suffix (128-bit entropy)", async () => {
    const { buildRunId } = await import("./dispatch.js")

    // 格式: <issue>-<role>-r<round>-<full UUID>
    const id = buildRunId(0, "implementer", 1)
    expect(id).toMatch(
      /^0-implementer-r1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )

    const ids = Array.from({ length: 5 }, () => buildRunId(0, "implementer", 1))
    expect(new Set(ids).size).toBe(5)
  })
})
