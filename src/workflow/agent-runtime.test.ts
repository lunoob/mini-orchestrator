import { describe, expect, it, vi } from "vitest"

import type { SessionClient } from "../session/client.js"
import type { WorkflowAgent } from "../session/workflow-agent.js"
import type { WorkflowRuntime } from "./types.js"
import { startRuntimeAgents, stopRuntimeAgents } from "./agent-runtime.js"

vi.mock("../session/workflow-agent.js", () => ({
  startWorkflowAgent: vi.fn(),
}))

const fakeClient = { get: vi.fn() } as unknown as SessionClient

const makeAgent = (overrides: Partial<WorkflowAgent> = {}): WorkflowAgent =>
  ({
    sessionId: overrides.sessionId ?? "session-test",
    sendTaskAndWait: overrides.sendTaskAndWait ?? vi.fn(),
    stop: overrides.stop ?? vi.fn(),
  }) as WorkflowAgent

const makeRuntime = (overrides: Partial<WorkflowRuntime> = {}): WorkflowRuntime =>
  ({
    args: {},
    baseSha: undefined,
    config: { projectDir: "/tmp", issues: [], maxReviewRounds: 3, implementer: { agent: "codex", command: "codex", name: "impl" }, reviewer: { agent: "codex", command: "codex", name: "rev" } },
    hasGit: false,
    implementerSession: undefined,
    issueIndex: 0,
    needsCheckMode: "interactive",
    prompts: { implement: "", review: "", revise: "", reReview: "", postReviewCheck: "", controllerImplementer: "", controllerReReview: "" },
    reviewerSession: undefined,
    sessionBaseUrl: "http://127.0.0.1:1",
    sessionClient: fakeClient,
    ...overrides,
  }) as WorkflowRuntime

describe("stopRuntimeAgents", () => {
  it("logs warning when implementer stop throws, still stops reviewer and resets references", async () => {
    const logSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const implStop = vi.fn().mockRejectedValue(new Error("impl stop failed"))
    const revStop = vi.fn().mockResolvedValue(undefined)

    const runtime = makeRuntime({
      implementerSession: makeAgent({ sessionId: "impl-session", stop: implStop }),
      reviewerSession: makeAgent({ sessionId: "rev-session", stop: revStop }),
    })

    // 不应抛出
    await expect(stopRuntimeAgents(runtime)).resolves.toBeUndefined()

    // 两个 session 都尝试了 stop
    expect(implStop).toHaveBeenCalledOnce()
    expect(revStop).toHaveBeenCalledOnce()

    // 引用已重置
    expect(runtime.implementerSession).toBeUndefined()
    expect(runtime.reviewerSession).toBeUndefined()

    // 记录了清理失败的警告
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("implementer"))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("cleanup error"))

    logSpy.mockRestore()
  })

  it("logs warnings when both sessions fail to stop, still resets references", async () => {
    const logSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const implStop = vi.fn().mockRejectedValue(new Error("impl fail"))
    const revStop = vi.fn().mockRejectedValue(new Error("rev fail"))

    const runtime = makeRuntime({
      implementerSession: makeAgent({ sessionId: "impl", stop: implStop }),
      reviewerSession: makeAgent({ sessionId: "rev", stop: revStop }),
    })

    await stopRuntimeAgents(runtime)
    expect(runtime.implementerSession).toBeUndefined()
    expect(runtime.reviewerSession).toBeUndefined()
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("implementer"))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("reviewer"))

    logSpy.mockRestore()
  })

  it("handles undefined sessions cleanly", async () => {
    const runtime = makeRuntime({
      implementerSession: undefined,
      reviewerSession: undefined,
    })

    await expect(stopRuntimeAgents(runtime)).resolves.toBeUndefined()
    expect(runtime.implementerSession).toBeUndefined()
    expect(runtime.reviewerSession).toBeUndefined()
  })
})

describe("startRuntimeAgents sequential startup", () => {
  it("stops the already-started implementer when reviewer creation fails", async () => {
    const { startWorkflowAgent } = await import("../session/workflow-agent.js")
    const client = { get: vi.fn().mockRejectedValue(new Error("not found")) } as unknown as SessionClient

    const implStop = vi.fn().mockResolvedValue(undefined)
    const implAgent: WorkflowAgent = {
      sessionId: "impl-ok",
      sendTaskAndWait: vi.fn(),
      stop: implStop,
    }

    vi.mocked(startWorkflowAgent)
      .mockResolvedValueOnce(implAgent)                                   // implementer 成功
      .mockRejectedValueOnce(new Error("reviewer creation failed"))       // reviewer 失败

    const runtime = makeRuntime({ sessionClient: client })

    await expect(
      startRuntimeAgents(runtime, "/tmp/run"),
    ).rejects.toThrow("reviewer creation failed")

    // implementer 已被停止
    expect(implStop).toHaveBeenCalledOnce()
    // runtime 引用已重置
    expect(runtime.implementerSession).toBeUndefined()
    expect(runtime.reviewerSession).toBeUndefined()
  })
})
