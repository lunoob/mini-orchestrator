/**
 * 端到端 workflow Session 集成测试。
 * 通过 Session client fake 驱动完整的 implement → review → pass / revise 流程，
 * 断言每阶段消息发送至对应 session、携带唯一 turnId。
 */
import { describe, expect, it, vi, beforeEach } from "vitest"

import type { SessionClient } from "@src/session/client"
import type { SessionItem, SessionRecord } from "@src/session/types"
import type { WorkflowRuntime } from "@src/workflow/types"
import { formatAgentOutcome } from "@src/workflow/agent-outcome"

// ---- Fake Session Client ----

let sessionCounter = 0
let turnCounter = 0

type FakeExtras = {
  _log: Array<{ content: string; sessionId: string; turnId: string }>
  _sessions: Map<string, SessionRecord>
}

const makeFakeClient = (): SessionClient & FakeExtras => {
  const sessions = new Map<string, SessionRecord>()
  const sessionItems = new Map<string, SessionItem[]>()
  const messageLog: Array<{ content: string; sessionId: string; turnId: string }> = []

  const nextTurnId = () => `turn-${++turnCounter}`

  return {
    _log: messageLog,
    _sessions: sessions,

    create: async (input) => {
      const id = `session-${++sessionCounter}`
      sessions.set(id, {
        activeTurnId: undefined,
        agent: input.agent,
        createdAt: new Date().toISOString(),
        id,
        role: input.role,
        runnerReady: true,
        runnerStatus: "idle",
        runDirectory: input.runDirectory,
        status: "ready",
        turns: [],
        workspace: input.workspace,
      })
      sessionItems.set(id, [])
      return sessions.get(id)!
    },

    get: async (sessionId) => {
      const s = sessions.get(sessionId)
      if (!s) throw new Error(`[Session] not found: ${sessionId}`)
      return { ...s }
    },

    getInteractions: async () => [],

    getItems: async (sessionId) => [...(sessionItems.get(sessionId) ?? [])],

    getRunnerToken: () => "fake-runner-token",

    postEvent: vi.fn(async () => ({ queued: true })),

    sendMessage: async (sessionId, input) => {
      const turnId = nextTurnId()
      messageLog.push({ sessionId, content: input.content, turnId })
      const session = sessions.get(sessionId)
      if (session) {
        session.turns.push({ createdAt: new Date().toISOString(), id: turnId, sessionId, status: "running" })
        session.activeTurnId = turnId
        session.status = "running"
        session.runnerStatus = "working"
      }
      return { queued: true as const, turnId }
    },

    stream: async function* () { yield { sequence: 1, sessionId: "hb", type: "session.heartbeat" as const } },

    waitForTurn: async (sessionId, turnId) => {
      const session = sessions.get(sessionId)
      const turn = session?.turns.find(t => t.id === turnId)
      if (!turn) throw new Error(`[Session] Unknown turn: ${turnId}`)
      turn.status = "completed"
      turn.completedAt = new Date().toISOString()
      session!.activeTurnId = undefined
      session!.status = "ready"
      session!.runnerStatus = "idle"
      return { content: "output", createdAt: new Date().toISOString(), id: `item-${turnId}`, role: "assistant" as const, turnId }
    },
  }
}

// ---- Shared test outputs (JSON outcome 格式) ----

const IMPLEMENT_DONE = formatAgentOutcome({
  outcome: "completed",
  summary: "实现完成",
})

const REVIEW_PASS = formatAgentOutcome({
  outcome: "completed",
  summary: "审查通过",
  review: { verdict: "pass" },
})

const REVIEW_FAIL = formatAgentOutcome({
  outcome: "completed",
  summary: "需修改",
  review: { verdict: "fail" },
})

const REVISE_OUTPUT = formatAgentOutcome({
  outcome: "completed",
  summary: "修复完成",
})

// ---- Mock all filesystem & git dependencies ----

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => "fake file content"),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}))

vi.mock("@src/config/persist", () => ({
  markIssueInReview: vi.fn(async () => undefined),
  markIssueFinished: vi.fn(async () => undefined),
}))

vi.mock("@src/workflow/review-context", () => ({
  prepareReviewContext: vi.fn(async () => ({ baseSha: "N/A", diffFile: undefined, headSha: "N/A" })),
  buildDiffFileSection: vi.fn(() => ""),
  advanceBaseline: vi.fn(async () => undefined),
  formatBaselineLabel: vi.fn(() => "N/A"),
}))

vi.mock("@src/review/needs-check", () => ({
  resolveNeedsCheckDecision: vi.fn(async () => ({ action: "approve" as const, notes: "" })),
  parseNeedsCheckMode: vi.fn(() => "interactive" as const),
  parseNeedsCheckAction: vi.fn(() => "approve" as const),
  NeedsCheckPauseError: class extends Error {},
  buildNeedsCheckMessage: vi.fn(() => ""),
  printNeedsCheckSummary: vi.fn(() => undefined),
}))

vi.mock("@src/workflow/implement-ask", () => ({
  handleSessionImplementOutcome: vi.fn(async (output: string) => {
    // 解析 JSON outcome 并返回
    const outcome = JSON.parse(output)
    if (outcome.outcome === "failed") {
      throw new Error(`[Implement] agent 报告失败: ${outcome.failure?.message ?? outcome.summary}`)
    }
    return outcome
  }),
  ImplementAskAbortError: class extends Error {},
  defaultImplementAskDeps: vi.fn(() => ({ log: vi.fn() })),
}))

vi.mock("@src/workflow/run-context", () => ({
  createWorkflowRunContext: vi.fn(async () => ({ runDirectory: "/tmp/.orchestrator/run-001", runId: "run-001" })),
}))

vi.mock("@src/git/index", () => ({
  isGitRepo: vi.fn(async () => false),
  getReviewBaselineSha: vi.fn(async () => undefined),
  getHeadShaSafe: vi.fn(async () => "N/A"),
}))

// agent-runtime 通过 startWorkflowAgent 创建 session/runner，
// 端到端测试注入 fake agent 即可，mock 掉真实 Herdr pane 创建。
vi.mock("@src/session/workflow-agent", () => ({
  startWorkflowAgent: vi.fn(),
}))

// ============================================================

describe("end-to-end implement → review → pass", () => {
  beforeEach(() => {
    sessionCounter = 0
    turnCounter = 0
    vi.clearAllMocks()
  })

  const makeRuntime = (client: SessionClient & FakeExtras): WorkflowRuntime =>
    ({
      args: {},
      baseSha: undefined,
      config: {
        implementer: { agent: "codex", command: "codex", name: "impl" },
        maxReviewRounds: 3,
        projectDir: "/tmp/project",
        prompts: {
          implement: "Implement {{specPath}} (max {{maxReviewRounds}} rounds)",
          review: "Review base={{baseSha}} head={{headSha}} spec={{specPath}} round={{round}}{{diffFileSection}}",
          revise: "Revise {{reviewOutput}} round={{round}}",
          reReview: "Re-review base={{baseSha}} head={{headSha}} spec={{specPath}} round={{round}}{{diffFileSection}}",
          postReviewCheck: "Post-check {{reviewStatus}} round={{round}}",
          controllerImplementer: "Controller {{controllerNotes}} (round {{round}})",
          controllerReReview: "Re-review {{controllerNotes}} base={{baseSha}} head={{headSha}} spec={{specPath}} round={{round}}",
        },
        reviewer: { agent: "codex", command: "codex", name: "rev" },
        issues: [{ title: "Add login", specPath: "/tmp/spec.md" }],
      },
      hasGit: false,
      implementerSession: undefined,
      issueIndex: 0,
      needsCheckMode: "interactive",
      prompts: {
        implement: "Implement {{specPath}} (max {{maxReviewRounds}} rounds)",
        review: "Review base={{baseSha}} head={{headSha}} spec={{specPath}} round={{round}}{{diffFileSection}}",
        revise: "Revise {{reviewOutput}} round={{round}}",
        reReview: "Re-review base={{baseSha}} head={{headSha}} spec={{specPath}} round={{round}}{{diffFileSection}}",
        postReviewCheck: "Post-check {{reviewStatus}} round={{round}}",
        controllerImplementer: "Controller {{controllerNotes}} (round {{round}})",
        controllerReReview: "Re-review {{controllerNotes}} base={{baseSha}} head={{headSha}} spec={{specPath}} round={{round}}",
      },
      reviewerSession: undefined,
      sessionBaseUrl: "http://127.0.0.1:1",
      sessionClient: client,
    }) as WorkflowRuntime

  it("completes implement → review → pass, sending each prompt to the correct session with unique turnIds", async () => {
    const client = makeFakeClient()
    const runtime = makeRuntime(client)

    // Fake agents 使用真实 client.sendMessage，确保每个 turnId 被记录
    const { startWorkflowAgent } = await import("@src/session/workflow-agent")
    vi.mocked(startWorkflowAgent)
      .mockResolvedValueOnce({
        sessionId: "impl-sess",
        sendTaskAndWait: async (prompt: string) => {
          await client.sendMessage("impl-sess", { content: prompt, eventId: "evt" })
          return IMPLEMENT_DONE
        },
        lastTurnId: () => undefined,
        stop: vi.fn(),
      })
      .mockResolvedValueOnce({
        sessionId: "rev-sess",
        sendTaskAndWait: async (prompt: string) => {
          await client.sendMessage("rev-sess", { content: prompt, eventId: "evt" })
          return REVIEW_PASS
        },
        lastTurnId: () => undefined,
        stop: vi.fn(),
      })

    const { runIssueQueueFromIndex } = await import("@src/workflow/issues")

    await runIssueQueueFromIndex(runtime, "/tmp/config.json", 0, [
      { title: "Add login", specPath: "/tmp/spec.md" },
    ])

    const log = (client as unknown as FakeExtras)._log

    // --- implement 阶段 ---
    const implMessages = log.filter(m => m.sessionId === "impl-sess")
    expect(implMessages.length, "implementer should receive at least 1 message").toBeGreaterThanOrEqual(1)

    const implementCall = implMessages[0]
    expect(implementCall.content).toContain("Implement")
    expect(implementCall.content).toContain("/tmp/spec.md")
    expect(implementCall.turnId).toMatch(/^turn-\d+$/)

    // --- review 阶段 ---
    const revMessages = log.filter(m => m.sessionId === "rev-sess")
    expect(revMessages.length, "reviewer should receive at least 1 message").toBeGreaterThanOrEqual(1)

    const reviewCall = revMessages[0]
    expect(reviewCall.content).toContain("Review")
    expect(reviewCall.content).toContain("round=1")
    expect(reviewCall.turnId).toMatch(/^turn-\d+$/)

    // --- post-check 阶段 ---
    const postCheckMessages = implMessages.filter(m => m.content.includes("Post-check"))
    expect(postCheckMessages.length, "implementer should receive post-check prompt").toBeGreaterThanOrEqual(1)
    expect(postCheckMessages[0].content).toContain("REVIEW_PASS")

    // --- turnId 唯一性 ---
    const allTurnIds = log.map(m => m.turnId)
    expect(new Set(allTurnIds).size).toBe(allTurnIds.length)

    // --- 不同 session 的 turnId 不共享 ---
    const implTurnIds = implMessages.map(m => m.turnId)
    const revTurnIds = revMessages.map(m => m.turnId)
    for (const it of implTurnIds) {
      expect(revTurnIds).not.toContain(it)
    }
  })

  it("completes full revise cycle: fail → revise → re-review → pass with correct session routing", async () => {
    const client = makeFakeClient()
    const runtime = makeRuntime(client)

    let implementerCalls = 0
    let reviewerCalls = 0

    const { startWorkflowAgent } = await import("@src/session/workflow-agent")
    vi.mocked(startWorkflowAgent)
      .mockResolvedValueOnce({
        sessionId: "impl-sess",
        sendTaskAndWait: async (prompt: string) => {
          await client.sendMessage("impl-sess", { content: prompt, eventId: "evt" })
          implementerCalls += 1
          return implementerCalls <= 1 ? IMPLEMENT_DONE : REVISE_OUTPUT
        },
        lastTurnId: () => undefined,
        stop: vi.fn(),
      })
      .mockResolvedValueOnce({
        sessionId: "rev-sess",
        sendTaskAndWait: async (prompt: string) => {
          await client.sendMessage("rev-sess", { content: prompt, eventId: "evt" })
          reviewerCalls += 1
          return reviewerCalls <= 1 ? REVIEW_FAIL : REVIEW_PASS
        },
        lastTurnId: () => undefined,
        stop: vi.fn(),
      })

    const { runIssueQueueFromIndex } = await import("@src/workflow/issues")

    await runIssueQueueFromIndex(runtime, "/tmp/config.json", 0, [
      { title: "Add login", specPath: "/tmp/spec.md" },
    ])

    const log = (client as unknown as FakeExtras)._log
    const implMessages = log.filter(m => m.sessionId === "impl-sess")
    const revMessages = log.filter(m => m.sessionId === "rev-sess")

    // 消息按阶段归类
    const phases = {
      implement: implMessages.find(m => m.content.includes("Implement")),
      review: revMessages.find(m => m.content.includes("Review") && !m.content.includes("Re-review")),
      revise: implMessages.find(m => m.content.includes("Revise")),
      reReview: revMessages.find(m => m.content.includes("Re-review")),
      postCheck: implMessages.find(m => m.content.includes("Post-check")),
    }

    // 所有阶段都存在
    expect(phases.implement, "missing implement prompt").toBeDefined()
    expect(phases.review, "missing review prompt").toBeDefined()
    expect(phases.revise, "missing revise prompt").toBeDefined()
    expect(phases.reReview, "missing re-review prompt").toBeDefined()
    expect(phases.postCheck, "missing post-check prompt").toBeDefined()

    // 每阶段有唯一 turnId
    expect(phases.implement!.turnId).toMatch(/^turn-\d+$/)
    expect(phases.review!.turnId).toMatch(/^turn-\d+$/)
    expect(phases.revise!.turnId).toMatch(/^turn-\d+$/)
    expect(phases.reReview!.turnId).toMatch(/^turn-\d+$/)
    expect(phases.postCheck!.turnId).toMatch(/^turn-\d+$/)

    // 所有 turnId 唯一
    const phaseTurnIds = [phases.implement, phases.review, phases.revise, phases.reReview, phases.postCheck]
      .map(p => p!.turnId)
    expect(new Set(phaseTurnIds).size).toBe(phaseTurnIds.length)

    // implement 阶段发送到 implementer session
    expect(phases.implement!.sessionId).toBe("impl-sess")
    // review 阶段发送到 reviewer session
    expect(phases.review!.sessionId).toBe("rev-sess")
    // revise 阶段发送到 implementer session
    expect(phases.revise!.sessionId).toBe("impl-sess")
    // re-review 阶段发送到 reviewer session
    expect(phases.reReview!.sessionId).toBe("rev-sess")
    // post-check 发送到 implementer session
    expect(phases.postCheck!.sessionId).toBe("impl-sess")
  })
})
