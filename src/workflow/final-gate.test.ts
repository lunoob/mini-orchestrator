import { beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import type { AgentSessionHandle } from "../agent/transcript/types.js"
import { bootstrapSession, sendTaskAndMonitor, startAgentResumed, stopAgent, waitForAgentWithMonitor } from "../agent/index.js"
import { buildDiffFileSection, prepareReviewContext } from "./review-context.js"
import { runFinalGate } from "./final-gate.js"
import type { WorkflowRuntime } from "./types.js"
import type { WorkflowEventBus } from "./events.js"

const REVIEW_FAIL_OUTPUT = "Final review 发现的问题清单：\n- 问题一：未通过\nSTATUS: REVIEW_FAIL"
const FIX_DONE_OUTPUT = "已修复全部问题\nSTATUS: IMPLEMENT_DONE"
const REVIEW_PASS_OUTPUT = "全部通过\nSTATUS: REVIEW_PASS"
const NEEDS_CHECK_OUTPUT = "存在无法验证项\nSTATUS: REVIEW_NEEDS_CHECK"

const mockSession = (resumeId: string): AgentSessionHandle => ({
  provider: "codex",
  resumeId,
  jsonl: `/tmp/${resumeId}.jsonl`,
  offset: 0,
})

vi.mock("../agent/index.js", () => ({
  bootstrapSession: vi.fn(async (_dir: string, agent: { name: string }) => mockSession(`resume-${agent.name}`)),
  sendTask: vi.fn(async () => {}),
  sendTaskAndMonitor: vi.fn(),
  startAgentResumed: vi.fn(async (_dir: string, agent: { name: string }) => `pane-${agent.name}`),
  stopAgent: vi.fn(async () => {}),
  waitForAgentWithMonitor: vi.fn(),
}))

vi.mock("../notify/index.js", () => ({
  notifyNeedsInput: vi.fn(),
  resetNotifyDedup: vi.fn(),
}))

vi.mock("./review-context.js", () => ({
  buildDiffFileSection: vi.fn(() => "diff-section"),
  prepareReviewContext: vi.fn(async (_dir: string, _projectDir: string, baseSha?: string) => ({
    baseSha: baseSha ?? "N/A",
    diffFile: "/tmp/final-diff.md",
    headSha: "head1",
  })),
}))

const AGENT_CONFIG = (name: string) => ({
  name,
  agent: "codex",
  command: "codex",
  integrationAgent: "codex",
})

type MockEventBus = WorkflowEventBus & { publish: Mock }

const createMockEventBus = (): MockEventBus => {
  const publish = vi.fn()
  return {
    publish,
    subscribe: vi.fn(),
    getSnapshot: vi.fn(),
    reset: vi.fn(),
    requestInteraction: vi.fn().mockResolvedValue({ action: "yes" }),
    setInteractionHandler: vi.fn(),
  } as unknown as MockEventBus
}

const buildRuntime = (overrides: Partial<WorkflowRuntime> = {}): WorkflowRuntime => {
  const eventBus = createMockEventBus()
  return {
    args: {},
    baseSha: "base-after-last-issue",
    config: {
      agents: {
        implementer: AGENT_CONFIG("impl"),
        reviewer: AGENT_CONFIG("rev"),
        gateReviewer: AGENT_CONFIG("final-rev"),
        gateFixer: AGENT_CONFIG("final-fix"),
      },
      enableFinalGate: true,
      maxRounds: { workflow: 8, finalGate: 3 },
      projectDir: "/tmp/project",
      prompts: {
        implement: "", review: "", revise: "", reReview: "",
        controllerImplementer: "", controllerReReview: "", postReviewCheck: "",
      },
      issues: [
        { title: "Issue One", specPath: "/tmp/spec1.md" },
        { title: "Issue Two", specPath: "/tmp/spec2.md" },
      ],
    },
    configPath: "/tmp/workflow.json",
    eventBus,
    finalFixerPane: "",
    finalReviewerPane: "",
    hasGit: true,
    implementerPane: "",
    issueIndex: 0,
    prompts: {
      implement: "", review: "", revise: "", reReview: "",
      controllerImplementer: "", controllerReReview: "", postReviewCheck: "",
      finalReview: "Final Review {{round}} {{specs}} {{diffFileSection}} {{baseSha}} {{headSha}} {{lastReviewSection}}",
      finalFix: "Final Fix {{round}} {{specPaths}} {{reviewOutput}}",
    },
    reviewerPane: "",
    startBaseSha: "base0",
    ...overrides,
  }
}

const monitorResult = (finalText: string) => ({ finalText, status: "completed" as const, finalOffset: 10 })

const publishOf = (bus: WorkflowEventBus) => (bus as MockEventBus).publish

const phaseEvents = (bus: WorkflowEventBus) =>
  publishOf(bus).mock.calls
    .map(([event]) => event.type === "phase_change" ? event.phase : undefined)
    .filter((phase): phase is string => phase !== undefined)

const failEvents = (bus: WorkflowEventBus) =>
  publishOf(bus).mock.calls
    .filter(([event]) => event.type === "fail")
    .map(([event]) => event.reason)

const completeEvents = (bus: WorkflowEventBus) =>
  publishOf(bus).mock.calls.filter(([event]) => event.type === "complete")

beforeEach(() => {
  vi.clearAllMocks()
})

describe("runFinalGate", () => {
  it("runs review FAIL → final fixer DONE → next review PASS, without complete/fail events", async () => {
    vi.mocked(sendTaskAndMonitor)
      .mockResolvedValueOnce(monitorResult(REVIEW_FAIL_OUTPUT))
      .mockResolvedValueOnce(monitorResult(FIX_DONE_OUTPUT))
      .mockResolvedValueOnce(monitorResult(REVIEW_PASS_OUTPUT))

    const runtime = buildRuntime()
    await runFinalGate(runtime, "/tmp/final-session")

    // 全量 diff 从 workflow 起始 baseline 开始
    expect(prepareReviewContext).toHaveBeenNthCalledWith(1, "/tmp/final-session", "/tmp/project", "base0", 1)
    expect(prepareReviewContext).toHaveBeenNthCalledWith(2, "/tmp/final-session", "/tmp/project", "base0", 2)

    // reviewer 输入包含全部 issue 标题与 specPath、diff、round；第 2 轮起包含上一轮 review 正文
    const prompts = vi.mocked(sendTaskAndMonitor).mock.calls.map(([, prompt]) => prompt)
    expect(prompts).toHaveLength(3)
    expect(prompts[0]).toContain("Final Review 1")
    expect(prompts[0]).toContain("Issue One")
    expect(prompts[0]).toContain("/tmp/spec1.md")
    expect(prompts[0]).toContain("Issue Two")
    expect(prompts[0]).toContain("diff-section")
    expect(prompts[0]).toContain("base0")
    expect(prompts[0]).not.toContain("上一轮")

    // fixer 输入包含去 STATUS 行的问题清单、round、spec 路径列表
    expect(prompts[1]).toContain("Final Fix 1")
    expect(prompts[1]).toContain("问题一：未通过")
    expect(prompts[1]).toContain("/tmp/spec1.md")
    expect(prompts[1]).not.toContain("STATUS: REVIEW_FAIL")

    expect(prompts[2]).toContain("Final Review 2")
    expect(prompts[2]).toContain("上一轮")
    expect(prompts[2]).toContain("问题一：未通过")

    // 终端依次显示 final-review → final-fix → final-review
    expect(phaseEvents(runtime.eventBus)).toEqual(["final-review", "final-fix", "final-review"])

    expect(failEvents(runtime.eventBus)).toEqual([])
    expect(completeEvents(runtime.eventBus)).toEqual([])

    // 启动的 final panes 全部关闭
    expect(stopAgent).toHaveBeenCalledWith("pane-final-rev")
    expect(stopAgent).toHaveBeenCalledWith("pane-final-fix")
  })

  it("returns success on first round REVIEW_PASS without starting the final fixer", async () => {
    vi.mocked(sendTaskAndMonitor).mockResolvedValueOnce(monitorResult(REVIEW_PASS_OUTPUT))

    const runtime = buildRuntime()
    await runFinalGate(runtime, "/tmp/final-session")

    expect(startAgentResumed).toHaveBeenCalledTimes(1)
    expect(startAgentResumed).toHaveBeenCalledWith(
      "/tmp/project",
      expect.objectContaining({ name: "final-rev" }),
      expect.objectContaining({ resumeId: "resume-final-rev", jsonl: "/tmp/resume-final-rev.jsonl" }),
      expect.any(Object),
    )
    expect(stopAgent).toHaveBeenCalledWith("pane-final-rev")
    expect(stopAgent).not.toHaveBeenCalledWith("pane-final-fix")
    expect(failEvents(runtime.eventBus)).toEqual([])
  })

  it("publishes fail and throws when final review fails on the last round", async () => {
    const runtime = buildRuntime({
      config: { ...buildRuntime().config, maxRounds: { workflow: 8, finalGate: 1 } },
    })
    vi.mocked(sendTaskAndMonitor).mockResolvedValueOnce(monitorResult(REVIEW_FAIL_OUTPUT))

    await expect(runFinalGate(runtime, "/tmp/final-session")).rejects.toThrow(
      "Final review failed after 1 rounds",
    )

    expect(failEvents(runtime.eventBus)).toContain("Final review failed after 1 rounds")
    expect(completeEvents(runtime.eventBus)).toEqual([])
    // fixer 从未启动，只关闭 reviewer pane
    expect(stopAgent).toHaveBeenCalledWith("pane-final-rev")
    expect(stopAgent).not.toHaveBeenCalledWith("pane-final-fix")
  })

  it("publishes fail and throws when review still fails after a fixer round", async () => {
    const runtime = buildRuntime({
      config: { ...buildRuntime().config, maxRounds: { workflow: 8, finalGate: 2 } },
    })
    vi.mocked(sendTaskAndMonitor)
      .mockResolvedValueOnce(monitorResult(REVIEW_FAIL_OUTPUT))
      .mockResolvedValueOnce(monitorResult(FIX_DONE_OUTPUT))
      .mockResolvedValueOnce(monitorResult(REVIEW_FAIL_OUTPUT))

    await expect(runFinalGate(runtime, "/tmp/final-session")).rejects.toThrow(
      "Final review failed after 2 rounds",
    )

    expect(failEvents(runtime.eventBus)).toContain("Final review failed after 2 rounds")
    expect(completeEvents(runtime.eventBus)).toEqual([])
    expect(stopAgent).toHaveBeenCalledWith("pane-final-rev")
    expect(stopAgent).toHaveBeenCalledWith("pane-final-fix")
  })

  it("publishes fail and throws when REVIEW_NEEDS_CHECK retries exceed maxRounds", async () => {
    const runtime = buildRuntime({
      config: { ...buildRuntime().config, maxRounds: { workflow: 8, finalGate: 1 } },
    })
    vi.mocked(sendTaskAndMonitor).mockResolvedValueOnce(monitorResult(NEEDS_CHECK_OUTPUT))
    // 人工核查后 reviewer 重审仍 NEEDS_CHECK → 超过上限
    vi.mocked(waitForAgentWithMonitor).mockResolvedValue(monitorResult(NEEDS_CHECK_OUTPUT))

    await expect(runFinalGate(runtime, "/tmp/final-session")).rejects.toThrow(
      "Final review needs_check exceeded 1 rounds",
    )

    expect(failEvents(runtime.eventBus)).toContain("Final review needs_check exceeded 1 rounds")
    expect(completeEvents(runtime.eventBus)).toEqual([])
    expect(stopAgent).toHaveBeenCalledWith("pane-final-rev")
  })

  it("returns success when REVIEW_NEEDS_CHECK is resolved to PASS after human check", async () => {
    vi.mocked(sendTaskAndMonitor).mockResolvedValueOnce(monitorResult(NEEDS_CHECK_OUTPUT))
    vi.mocked(waitForAgentWithMonitor).mockResolvedValue(monitorResult(REVIEW_PASS_OUTPUT))

    const runtime = buildRuntime()
    await runFinalGate(runtime, "/tmp/final-session")

    expect(failEvents(runtime.eventBus)).toEqual([])
    expect(completeEvents(runtime.eventBus)).toEqual([])
    expect(startAgentResumed).toHaveBeenCalledTimes(1)
    expect(stopAgent).toHaveBeenCalledWith("pane-final-rev")
  })

  it("propagates IMPLEMENT_FAILED from the final fixer and closes panes", async () => {
    vi.mocked(sendTaskAndMonitor)
      .mockResolvedValueOnce(monitorResult(REVIEW_FAIL_OUTPUT))
      .mockResolvedValueOnce(monitorResult("无法继续\nSTATUS: IMPLEMENT_FAILED"))

    const runtime = buildRuntime()
    await expect(runFinalGate(runtime, "/tmp/final-session")).rejects.toThrow(
      /IMPLEMENT_FAILED in final fix round 1/,
    )

    expect(failEvents(runtime.eventBus)).toContain("implementer reported IMPLEMENT_FAILED in final fix round 1")
    expect(completeEvents(runtime.eventBus)).toEqual([])
    expect(stopAgent).toHaveBeenCalledWith("pane-final-rev")
    expect(stopAgent).toHaveBeenCalledWith("pane-final-fix")
  })

  it("is a no-op when final gate is disabled", async () => {
    const runtime = buildRuntime({ config: { ...buildRuntime().config, enableFinalGate: false } })

    await runFinalGate(runtime, "/tmp/final-session")

    expect(bootstrapSession).not.toHaveBeenCalled()
    expect(startAgentResumed).not.toHaveBeenCalled()
  })
})
