import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  handleImplementAskIfNeeded,
  ImplementAskAbortError,
  type ImplementAskDeps,
} from "./implement-ask.js"
import type { AgentSessionHandle } from "../agent/transcript/types.js"

const askOutput = '{"outcome":"needs_input","summary":"需要确认","request":{"question":"Which approach?","allowFreeform":true}}'

const doneOutput = '{"outcome":"completed","summary":"Done."}'

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
  mockEventBus.requestInteraction.mockResolvedValue({ action: "continue" })
})

const mockEventBus = {
  publish: vi.fn(),
  subscribe: vi.fn(),
  getSnapshot: vi.fn(),
  reset: vi.fn(),
  requestInteraction: vi.fn().mockResolvedValue({ action: "continue" }),
  setInteractionHandler: vi.fn(),
}

const createDeps = (overrides: Partial<ImplementAskDeps> = {}): ImplementAskDeps => ({
  log: vi.fn(),
  promptContinue: vi.fn(),
  eventBus: mockEventBus as any,
  ...overrides,
})

describe("handleImplementAskIfNeeded", () => {
  it("returns original output when status is already done", async () => {
    const deps = createDeps()
    const result = await handleImplementAskIfNeeded(
      "pane-1",
      doneOutput,
      "implement",
      mockSessionHandle,
      deps,
    )

    expect(result).toBe(doneOutput)
    expect(deps.promptContinue).not.toHaveBeenCalled()
  })

  it("prompts user then returns when quick check finds agent already completed", async () => {
    const log = vi.fn()
    const deps = createDeps({
      log,
      promptContinue: vi.fn().mockResolvedValue(true),
    })

    // 第一次快速检查即返回 completed
    vi.mocked(waitForAgentWithMonitor).mockResolvedValueOnce({
      finalText: doneOutput,
      status: "completed",
      finalOffset: 100,
    })

    const result = await handleImplementAskIfNeeded(
      "pane-1",
      askOutput,
      "implement",
      mockSessionHandle,
      deps,
    )

    expect(result).toBe(doneOutput)
    expect(log).toHaveBeenCalledWith(expect.stringContaining("需要确认"))
    expect(mockEventBus.requestInteraction).toHaveBeenCalled()
  })

  it("throws ImplementAskAbortError when user answers no", async () => {
    const deps = createDeps({
      promptContinue: vi.fn().mockResolvedValue(false),
      eventBus: { ...mockEventBus, requestInteraction: vi.fn().mockResolvedValue({ action: "abort" }) } as any,
    })

    await expect(
      handleImplementAskIfNeeded(
        "pane-1",
        askOutput,
        "revise round 2",
        mockSessionHandle,
        deps,
      ),
    ).rejects.toBeInstanceOf(ImplementAskAbortError)
  })

  it("re-prompts when quick check finds needs_input, then full wait finds completed", async () => {
    const deps = createDeps({
      promptContinue: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true),
    })

    // 第一次 quick check 返回 needs_input → 循环再次 prompt
    // 第二次 quick check 返回 completed → 结束
    vi.mocked(waitForAgentWithMonitor)
      .mockResolvedValueOnce({
        finalText: '{"outcome":"needs_input","summary":"q","request":{"question":"still asking","allowFreeform":true}}',
        status: "needs_input",
        finalOffset: 200,
      })
      .mockResolvedValueOnce({
        finalText: doneOutput,
        status: "completed",
        finalOffset: 300,
      })

    const result = await handleImplementAskIfNeeded(
      "pane-1",
      askOutput,
      "post-check",
      mockSessionHandle,
      deps,
    )

    expect(result).toBe(doneOutput)
    expect(mockEventBus.requestInteraction).toHaveBeenCalledTimes(2)
  })
})
