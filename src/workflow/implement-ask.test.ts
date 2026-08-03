import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  handleNeedsInputGate,
  ImplementAskAbortError,
  type ImplementAskDeps,
} from "./implement-ask.js"
import type { AgentSessionHandle } from "../agent/transcript/types.js"

const askOutput = "需要确认\nSTATUS: IMPLEMENT_ASK"

const doneOutput = "完成\nSTATUS: IMPLEMENT_DONE"

const mockSessionHandle: AgentSessionHandle = {
  provider: "claude",
  resumeId: "resume-test-123",
  jsonl: "/tmp/test-session.jsonl",
  offset: 0,
}

// Mock waitForAgentWithMonitor
vi.mock("../agent/index.js", () => ({
  waitForAgentWithMonitor: vi.fn(),
  sendTask: vi.fn(),
}))

import { waitForAgentWithMonitor } from "../agent/index.js"

beforeEach(() => {
  vi.clearAllMocks()
  mockEventBus.requestInteraction.mockResolvedValue({ action: "yes" })
})

const mockEventBus = {
  publish: vi.fn(),
  subscribe: vi.fn(),
  getSnapshot: vi.fn(),
  reset: vi.fn(),
  requestInteraction: vi.fn().mockResolvedValue({ action: "yes" }),
  setInteractionHandler: vi.fn(),
}

const createDeps = (overrides: Partial<ImplementAskDeps> = {}): ImplementAskDeps => ({
  log: vi.fn(),
  eventBus: mockEventBus as any,
  ...overrides,
})

describe("handleNeedsInputGate", () => {
  it("prompts yes/no then returns when quick check finds agent already completed", async () => {
    const log = vi.fn()
    const deps = createDeps({ log })

    // 第一次快速检查即返回 completed
    vi.mocked(waitForAgentWithMonitor).mockResolvedValueOnce({
      finalText: doneOutput,
      status: "completed",
      finalOffset: 100,
    })

    const result = await handleNeedsInputGate(
      "implementer",
      "pane-1",
      "implement",
      mockSessionHandle,
      deps,
      "Which approach?",
    )

    expect(result.finalText).toBe(doneOutput)
    expect(result.status).toBe("completed")
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Which approach?"))
    expect(mockEventBus.requestInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ actions: ["yes", "no"] }),
    )
  })

  it("throws ImplementAskAbortError when user answers no", async () => {
    const deps = createDeps({
      eventBus: { ...mockEventBus, requestInteraction: vi.fn().mockResolvedValue({ action: "no" }) } as any,
    })

    await expect(
      handleNeedsInputGate(
        "implementer",
        "pane-1",
        "revise round 2",
        mockSessionHandle,
        deps,
      ),
    ).rejects.toBeInstanceOf(ImplementAskAbortError)
  })

  it("sends continuation and waits for terminal when quick check finds working", async () => {
    const deps = createDeps()

    // 第一次 quick check 返回 working → 发 continuation
    // 第二次 full wait 返回 completed → 结束
    vi.mocked(waitForAgentWithMonitor)
      .mockResolvedValueOnce({
        finalText: "还在处理",
        status: "working",
        finalOffset: 200,
      })
      .mockResolvedValueOnce({
        finalText: doneOutput,
        status: "completed",
        finalOffset: 300,
      })

    const result = await handleNeedsInputGate(
      "implementer",
      "pane-1",
      "post-check",
      mockSessionHandle,
      deps,
    )

    expect(result.finalText).toBe(doneOutput)
    expect(result.status).toBe("completed")
    expect(waitForAgentWithMonitor).toHaveBeenCalledTimes(2)
    expect(mockEventBus.requestInteraction).toHaveBeenCalledTimes(1)
  })

  it("treats quick check timeout as still working and continues", async () => {
    const deps = createDeps()

    // quick check 超时抛错 → 视为 agent 还在处理，走 continuation
    vi.mocked(waitForAgentWithMonitor)
      .mockRejectedValueOnce(new Error("Monitor timed out"))
      .mockResolvedValueOnce({
        finalText: doneOutput,
        status: "completed",
        finalOffset: 300,
      })

    const result = await handleNeedsInputGate(
      "implementer",
      "pane-1",
      "implement",
      mockSessionHandle,
      deps,
    )

    expect(result.finalText).toBe(doneOutput)
    expect(result.status).toBe("completed")
    expect(waitForAgentWithMonitor).toHaveBeenCalledTimes(2)
  })

  it("returns needs_input status when agent asks again after continuation", async () => {
    const deps = createDeps()

    // quick check 返回 working → 发 continuation；agent 又原生提问 → 返回 needs_input
    vi.mocked(waitForAgentWithMonitor)
      .mockResolvedValueOnce({
        finalText: "还在处理",
        status: "working",
        finalOffset: 200,
      })
      .mockResolvedValueOnce({
        finalText: "再问一次",
        status: "needs_input",
        finalOffset: 300,
        lastEvent: { type: "needs_input", question: "Which?" },
      })

    const result = await handleNeedsInputGate(
      "implementer",
      "pane-1",
      "implement",
      mockSessionHandle,
      deps,
    )

    expect(result.finalText).toBe("再问一次")
    expect(result.status).toBe("needs_input")
  })

  it("throws AgentFailError when agent fails after continuation", async () => {
    const deps = createDeps()

    vi.mocked(waitForAgentWithMonitor)
      .mockResolvedValueOnce({
        finalText: "还在处理",
        status: "working",
        finalOffset: 200,
      })
      .mockResolvedValueOnce({
        finalText: "",
        status: "failed",
        finalOffset: 300,
        lastEvent: { type: "failed", reason: "boom" },
      })

    await expect(
      handleNeedsInputGate("implementer", "pane-1", "implement", mockSessionHandle, deps),
    ).rejects.toThrow("Agent 失败")
  })
})
