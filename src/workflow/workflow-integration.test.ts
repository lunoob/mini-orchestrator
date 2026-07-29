import { describe, expect, it, vi, beforeEach } from "vitest"

import type { SessionClient } from "../session/client.js"
import type { SessionItem, SessionRecord, Turn } from "../session/types.js"
import type { WorkflowAgent } from "../session/workflow-agent.js"
import type { WorkflowRuntime } from "./types.js"

// ---- Fake Session Client with tracking ----

let sessionCounter = 0
let turnCounter = 0

type FakeClientExtras = {
  _log: Array<{ content: string; sessionId: string; turnId: string }>
  _sessions: Map<string, SessionRecord>
}

const makeFakeClient = (): SessionClient & FakeClientExtras => {
  const sessions = new Map<string, SessionRecord>()
  const sessionItems = new Map<string, SessionItem[]>()
  const messageLog: Array<{ content: string; sessionId: string; turnId: string }> = []

  const nextTurnId = () => `turn-${++turnCounter}`

  return {
    _log: messageLog,
    _sessions: sessions,

    create: async (input) => {
      const id = `session-${++sessionCounter}`
      const record: SessionRecord = {
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
      }
      sessions.set(id, record)
      sessionItems.set(id, [])
      return record
    },

    get: async (sessionId) => {
      const s = sessions.get(sessionId)
      if (!s) throw new Error(`[Session] Session not found: ${sessionId}`)
      return { ...s }
    },

    getItems: async (sessionId) => [...(sessionItems.get(sessionId) ?? [])],

    getRunnerToken: () => "fake-runner-token",

    postEvent: vi.fn(async () => ({ queued: true })),

    sendMessage: async (sessionId, input) => {
      const turnId = nextTurnId()
      messageLog.push({ sessionId, content: input.content, turnId })
      const session = sessions.get(sessionId)
      if (session) {
        session.turns.push({
          createdAt: new Date().toISOString(),
          id: turnId,
          sessionId,
          status: "running",
        })
        session.activeTurnId = turnId
        session.status = "running"
        session.runnerStatus = "working"
      }
      return { queued: true as const, turnId }
    },

    stream: async function* () {
      yield { sequence: 1, sessionId: "hb", type: "session.heartbeat" }
    },

    waitForTurn: async (sessionId, turnId) => {
      const session = sessions.get(sessionId)
      const turn = session?.turns.find(t => t.id === turnId)
      if (!turn) throw new Error(`[Session] Unknown turn: ${turnId}`)
      turn.status = "completed"
      turn.completedAt = new Date().toISOString()
      session!.activeTurnId = undefined
      session!.status = "ready"
      session!.runnerStatus = "idle"
      return {
        content: "fake-output",
        createdAt: new Date().toISOString(),
        id: `item-${turnId}-asst`,
        role: "assistant",
        turnId,
      } as SessionItem
    },
  }
}

const REVISE_OUTPUT = `---IMPLEMENT_RESULT_START---
STATUS: IMPLEMENT_DONE
修复完成
---IMPLEMENT_RESULT_END---`

const REVIEW_PASS = `---REVIEW_RESULT_START---
STATUS: REVIEW_PASS
审查通过
---REVIEW_RESULT_END---`

const REVIEW_FAIL = `---REVIEW_RESULT_START---
STATUS: REVIEW_FAIL
需要修改
---REVIEW_RESULT_END---`

const IMPLEMENT_DONE = `---IMPLEMENT_RESULT_START---
STATUS: IMPLEMENT_DONE
实现完成
---IMPLEMENT_RESULT_END---`

const makeBaseRuntime = (client: SessionClient): WorkflowRuntime =>
  ({
    args: {},
    baseSha: undefined,
    config: {
      implementer: { agent: "codex", command: "codex", name: "impl" },
      maxReviewRounds: 3,
      projectDir: "/tmp/project",
      prompts: {},
      reviewer: { agent: "codex", command: "codex", name: "rev" },
      issues: [{ title: "Test", specPath: "/tmp/spec.md" }],
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

describe("workflow review-loop Session integration", () => {
  beforeEach(() => {
    sessionCounter = 0
    turnCounter = 0
  })

  it("sends review prompt to reviewer session and gets pass verdict", async () => {
    // Mock the review-context module to avoid git dependencies
    vi.doMock("./review-context.js", () => ({
      prepareReviewContext: async () => ({
        baseSha: "N/A",
        diffFile: undefined,
        headSha: "N/A",
      }),
      buildDiffFileSection: () => "",
      advanceBaseline: async () => undefined,
      formatBaselineLabel: () => "N/A",
    }))

    // Mock needs-check to auto-approve
    vi.doMock("../review/needs-check.js", () => ({
      resolveNeedsCheckDecision: async () => ({ action: "approve", notes: "" }),
      parseNeedsCheckMode: () => "interactive" as const,
      parseNeedsCheckAction: () => "approve" as const,
      NeedsCheckPauseError: class extends Error {},
      buildNeedsCheckMessage: () => "",
      printNeedsCheckSummary: () => undefined,
    }))

    vi.doMock("./implement-ask.js", () => ({
      handleSessionImplementAskIfNeeded: async (output: string) => output,
      ImplementAskAbortError: class extends Error {},
      defaultImplementAskDeps: () => ({ log: vi.fn(), promptContinue: async () => true }),
    }))

    const { runReviewLoop } = await import("./review-loop.js")
    const client = makeFakeClient()
    const runtime = makeBaseRuntime(client)

    // Fake agents that return controlled outputs
    const implementer: WorkflowAgent = {
      sessionId: "impl-session",
      sendTaskAndWait: vi.fn(async () => IMPLEMENT_DONE),
      stop: vi.fn(),
    }
    const reviewer: WorkflowAgent = {
      sessionId: "rev-session",
      sendTaskAndWait: vi.fn(async () => REVIEW_PASS),
      stop: vi.fn(),
    }
    runtime.implementerSession = implementer
    runtime.reviewerSession = reviewer

    await expect(
      runReviewLoop(runtime, "/tmp/config.json", 1, false, "/tmp/session", "/tmp/spec.md", 0, [
        { title: "Test", specPath: "/tmp/spec.md" },
      ]),
    ).resolves.toBeUndefined()

    // reviewer 收到 review prompt
    expect(reviewer.sendTaskAndWait).toHaveBeenCalledTimes(1)
    const reviewCall = vi.mocked(reviewer.sendTaskAndWait).mock.calls[0][0]
    expect(reviewCall).toContain("Review")
    expect(reviewCall).toContain("round=1")
    expect(reviewCall).toContain("spec=/tmp/spec.md")

    // implementer 收到 post-check prompt
    expect(implementer.sendTaskAndWait).toHaveBeenCalledTimes(1)
    const postCheckCall = vi.mocked(implementer.sendTaskAndWait).mock.calls[0][0]
    expect(postCheckCall).toContain("REVIEW_PASS")
  })

  it("sends revise prompt to implementer on review fail and re-reviews", async () => {
    vi.doMock("./review-context.js", () => ({
      prepareReviewContext: async () => ({ baseSha: "N/A", diffFile: undefined, headSha: "N/A" }),
      buildDiffFileSection: () => "",
      advanceBaseline: async () => undefined,
      formatBaselineLabel: () => "N/A",
    }))
    vi.doMock("../review/needs-check.js", () => ({
      resolveNeedsCheckDecision: async () => ({ action: "approve", notes: "" }),
      parseNeedsCheckMode: () => "interactive" as const,
      parseNeedsCheckAction: () => "approve" as const,
      NeedsCheckPauseError: class extends Error {},
      buildNeedsCheckMessage: () => "",
      printNeedsCheckSummary: () => undefined,
    }))
    vi.doMock("./implement-ask.js", () => ({
      handleSessionImplementAskIfNeeded: async (output: string) => output,
      ImplementAskAbortError: class extends Error {},
      defaultImplementAskDeps: () => ({ log: vi.fn(), promptContinue: async () => true }),
    }))

    const { runReviewLoop } = await import("./review-loop.js")
    const client = makeFakeClient()
    const runtime = makeBaseRuntime(client)

    const implementer: WorkflowAgent = {
      sessionId: "impl-session",
      sendTaskAndWait: vi.fn()
        .mockResolvedValueOnce(REVISE_OUTPUT)   // revise round
        .mockResolvedValueOnce(IMPLEMENT_DONE), // post-review check
      stop: vi.fn(),
    }
    const reviewer: WorkflowAgent = {
      sessionId: "rev-session",
      sendTaskAndWait: vi.fn()
        .mockResolvedValueOnce(REVIEW_FAIL)     // first review → fail
        .mockResolvedValueOnce(REVIEW_PASS),    // re-review → pass
      stop: vi.fn(),
    }
    runtime.implementerSession = implementer
    runtime.reviewerSession = reviewer

    await runReviewLoop(runtime, "/tmp/config.json", 1, false, "/tmp/session", "/tmp/spec.md", 0, [
      { title: "Test", specPath: "/tmp/spec.md" },
    ])

    // 第一次 review 失败
    expect(reviewer.sendTaskAndWait).toHaveBeenCalledTimes(2)
    expect(vi.mocked(reviewer.sendTaskAndWait).mock.calls[0][0]).toContain("Review")

    // implementer 收到 revise 提示（包含 review 输出）
    expect(implementer.sendTaskAndWait).toHaveBeenCalledTimes(2)
    const reviseCall = vi.mocked(implementer.sendTaskAndWait).mock.calls[0][0]
    expect(reviseCall).toContain("Revise")
    expect(reviseCall).toContain("round=1")

    // 第二次 review 通过
    const reReviewCall = vi.mocked(reviewer.sendTaskAndWait).mock.calls[1][0]
    expect(reReviewCall).toContain("Re-review")

    // post-check
    const postCheckCall = vi.mocked(implementer.sendTaskAndWait).mock.calls[1][0]
    expect(postCheckCall).toContain("REVIEW_PASS")
  })

  it("uses distinct turnIds for each session interaction", async () => {
    vi.doMock("./review-context.js", () => ({
      prepareReviewContext: async () => ({ baseSha: "N/A", diffFile: undefined, headSha: "N/A" }),
      buildDiffFileSection: () => "",
      advanceBaseline: async () => undefined,
      formatBaselineLabel: () => "N/A",
    }))
    vi.doMock("../review/needs-check.js", () => ({
      resolveNeedsCheckDecision: async () => ({ action: "approve", notes: "" }),
      parseNeedsCheckMode: () => "interactive" as const,
      parseNeedsCheckAction: () => "approve" as const,
      NeedsCheckPauseError: class extends Error {},
      buildNeedsCheckMessage: () => "",
      printNeedsCheckSummary: () => undefined,
    }))
    vi.doMock("./implement-ask.js", () => ({
      handleSessionImplementAskIfNeeded: async (output: string) => output,
      ImplementAskAbortError: class extends Error {},
      defaultImplementAskDeps: () => ({ log: vi.fn(), promptContinue: async () => true }),
    }))

    const { runReviewLoop } = await import("./review-loop.js")
    const client = makeFakeClient()
    const runtime = makeBaseRuntime(client)

    // 使用真实 client.sendMessage 而非 mock vi.fn，这样 turnId 会被记录
    const implementer: WorkflowAgent = {
      sessionId: "impl-session",
      sendTaskAndWait: async (prompt: string) => {
        await client.sendMessage("impl-session", { content: prompt, eventId: "evt-impl" })
        return REVISE_OUTPUT
      },
      stop: vi.fn(),
    }
    const reviewer: WorkflowAgent = {
      sessionId: "rev-session",
      sendTaskAndWait: async (prompt: string) => {
        await client.sendMessage("rev-session", { content: prompt, eventId: "evt-rev" })
        return REVIEW_FAIL
      },
      stop: vi.fn(),
    }
    runtime.implementerSession = implementer
    runtime.reviewerSession = reviewer

    // maxReviewRounds=1 迫使第一轮失败后直接抛错，避免跑完整个循环
    runtime.config.maxReviewRounds = 1

    await expect(
      runReviewLoop(runtime, "/tmp/config.json", 1, false, "/tmp/session", "/tmp/spec.md", 0, [
        { title: "Test", specPath: "/tmp/spec.md" },
      ]),
    ).rejects.toThrow(/Review failed after 1 rounds/)

    const log = (client as unknown as FakeClientExtras)._log
    const revTurns = log.filter(m => m.sessionId === "rev-session")
    const implTurns = log.filter(m => m.sessionId === "impl-session")

    // 每个 session 的 turnId 应唯一
    expect(revTurns.length).toBeGreaterThanOrEqual(1)
    expect(new Set(revTurns.map(t => t.turnId)).size).toBe(revTurns.length)
    expect(new Set(implTurns.map(t => t.turnId)).size).toBe(implTurns.length)

    // 不同 session 的 turnId 不应相同
    if (revTurns.length > 0 && implTurns.length > 0) {
      expect(revTurns[0].turnId).not.toBe(implTurns[0].turnId)
    }
  })
})

// resume 测试需要 mock startWorkflowAgent 以避免真实 Herdr pane 创建
vi.mock("../session/workflow-agent.js", () => ({
  startWorkflowAgent: vi.fn(async (opts: { role: string }) => ({
    sessionId: `new-${opts.role}-session`,
    sendTaskAndWait: vi.fn(),
    stop: vi.fn(),
  })),
}))

describe("resume session reconnection", () => {
  beforeEach(() => {
    sessionCounter = 0
    turnCounter = 0
    vi.clearAllMocks()
  })

  it("reconnects to alive ready session via startRuntimeAgents", async () => {
    vi.doMock("./agent-runtime.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("./agent-runtime.js")>()
      return { ...original }
    })

    const { startRuntimeAgents, stopRuntimeAgents } = await import("./agent-runtime.js")
    const client = makeFakeClient()
    const runtime = makeBaseRuntime(client)
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    try {
      // 在 fake client 中预创建一个 ready session
      const existingSession = await client.create({
        agent: runtime.config.implementer,
        role: "implementer",
        runDirectory: "/tmp/run",
        workspace: "/tmp/project",
      })
      const s = client._sessions.get(existingSession.id)!
      s.runnerReady = true
      s.status = "ready"

      const existingReview = await client.create({
        agent: runtime.config.reviewer,
        role: "reviewer",
        runDirectory: "/tmp/run",
        workspace: "/tmp/project",
      })
      const r = client._sessions.get(existingReview.id)!
      r.runnerReady = true
      r.status = "ready"

      const checkpointRefs = {
        implementerSessionId: existingSession.id,
        reviewerSessionId: existingReview.id,
      }

      await startRuntimeAgents(runtime, "/tmp/run", checkpointRefs)

      // 应该重连到既有 session（非创建新 session）
      expect(runtime.implementerSession).toBeDefined()
      expect(runtime.reviewerSession).toBeDefined()
      expect(runtime.implementerSession!.sessionId).toBe(existingSession.id)
      expect(runtime.reviewerSession!.sessionId).toBe(existingReview.id)

      const logCalls = logSpy.mock.calls.map(c => String(c[0]))
      expect(logCalls.some(m => m.includes("Reconnecting to existing implementer session"))).toBe(true)
      expect(logCalls.some(m => m.includes("Reconnecting to existing reviewer session"))).toBe(true)
    } finally {
      logSpy.mockRestore()
      await stopRuntimeAgents(runtime)
    }
  })

  it("creates new sessions when checkpoint sessions are in terminal states", async () => {
    const { startRuntimeAgents, stopRuntimeAgents } = await import("./agent-runtime.js")
    const client = makeFakeClient()
    const runtime = makeBaseRuntime(client)
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    try {
      // 预创建 stopping 和 failed 状态的 session（不可重连）
      const stoppingSession = await client.create({
        agent: runtime.config.implementer,
        role: "implementer",
        runDirectory: "/tmp/run",
        workspace: "/tmp/project",
      })
      const s1 = client._sessions.get(stoppingSession.id)!
      s1.runnerReady = true // runnerReady 仍为 true，但 status 为 stopping
      s1.status = "stopping"

      const failedSession = await client.create({
        agent: runtime.config.reviewer,
        role: "reviewer",
        runDirectory: "/tmp/run",
        workspace: "/tmp/project",
      })
      const s2 = client._sessions.get(failedSession.id)!
      s2.runnerReady = false
      s2.status = "failed"

      const checkpointRefs = {
        implementerSessionId: stoppingSession.id,
        reviewerSessionId: failedSession.id,
      }

      await startRuntimeAgents(runtime, "/tmp/run", checkpointRefs)

      // 不应重连到旧 session（terminal 状态）
      expect(runtime.implementerSession!.sessionId).not.toBe(stoppingSession.id)
      expect(runtime.reviewerSession!.sessionId).not.toBe(failedSession.id)

      // 应该创建了新 session
      expect(runtime.implementerSession!.sessionId).toBe("new-implementer-session")
      expect(runtime.reviewerSession!.sessionId).toBe("new-reviewer-session")

      const logCalls = logSpy.mock.calls.map(c => String(c[0]))
      expect(logCalls.some(m => m.includes("cannot reconnect"))).toBe(true)
    } finally {
      logSpy.mockRestore()
      await stopRuntimeAgents(runtime)
    }
  })

  it("reconnects when status is idle", async () => {
    const { startRuntimeAgents, stopRuntimeAgents } = await import("./agent-runtime.js")
    const client = makeFakeClient()
    const runtime = makeBaseRuntime(client)
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    try {
      // idle 状态也应可重连
      const idleSession = await client.create({
        agent: runtime.config.implementer,
        role: "implementer",
        runDirectory: "/tmp/run",
        workspace: "/tmp/project",
      })
      const s = client._sessions.get(idleSession.id)!
      s.runnerReady = true
      s.status = "idle"

      const idleReview = await client.create({
        agent: runtime.config.reviewer,
        role: "reviewer",
        runDirectory: "/tmp/run",
        workspace: "/tmp/project",
      })
      const r = client._sessions.get(idleReview.id)!
      r.runnerReady = true
      r.status = "idle"

      const checkpointRefs = {
        implementerSessionId: idleSession.id,
        reviewerSessionId: idleReview.id,
      }

      await startRuntimeAgents(runtime, "/tmp/run", checkpointRefs)

      expect(runtime.implementerSession!.sessionId).toBe(idleSession.id)
      expect(runtime.reviewerSession!.sessionId).toBe(idleReview.id)
    } finally {
      logSpy.mockRestore()
      await stopRuntimeAgents(runtime)
    }
  })
})
