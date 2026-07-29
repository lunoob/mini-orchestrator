import { describe, expect, it, vi } from "vitest"

import type { SessionClient } from "@src/session/client"
import type {
  CreateSessionInput,
  SessionItem,
  SessionRecord,
  SessionStreamEvent,
  Turn,
} from "@src/session/types"
import type { WorkflowAgent } from "@src/session/workflow-agent"
import type { WorkflowRuntime } from "@src/workflow/types"
import { startRuntimeAgents, stopRuntimeAgents } from "@src/workflow/agent-runtime"
import { formatAgentOutcome } from "@src/workflow/agent-outcome"

// ---- Fake Session Client ----

let sessionCounter = 0
let turnCounter = 0

type FakeClientResult = {
  _log: Array<{ content: string; sessionId: string; turnId: string }>
  _sessions: Map<string, SessionRecord>
}

const makeFakeSessionClient = (): SessionClient & FakeClientResult => {
  const sessions = new Map<string, SessionRecord>()
  const sessionItems = new Map<string, SessionItem[]>()
  const messageLog: Array<{ content: string; sessionId: string; turnId: string }> = []

  const nextTurnId = () => `turn-${++turnCounter}`

  return {
    _log: messageLog,
    _sessions: sessions,

    create: async (input: Omit<CreateSessionInput, "id">) => {
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

    get: async (sessionId: string) => {
      const s = sessions.get(sessionId)
      if (!s) throw new Error(`[Session] Session not found: ${sessionId}`)
      return { ...s }
    },

    getItems: async (sessionId: string) => [...(sessionItems.get(sessionId) ?? [])],

    getRunnerToken: () => "fake-runner-token",

    postEvent: vi.fn(async () => ({ queued: true })),

    sendMessage: async (sessionId: string, input: { content: string; eventId: string }) => {
      const turnId = nextTurnId()
      messageLog.push({ sessionId, content: input.content, turnId })

      const session = sessions.get(sessionId)
      if (session) {
        const turn: Turn = {
          createdAt: new Date().toISOString(),
          id: turnId,
          sessionId,
          status: "running",
        }
        session.turns.push(turn)
        session.activeTurnId = turnId
        session.status = "running"
        session.runnerStatus = "working"
      }

      const existing = sessionItems.get(sessionId) ?? []
      existing.push({
        content: input.content,
        createdAt: new Date().toISOString(),
        eventId: input.eventId,
        id: `item-${turnId}-user`,
        role: "user",
        turnId,
      })
      sessionItems.set(sessionId, existing)

      return { queued: true as const, turnId }
    },

    stream: async function* (): AsyncIterable<SessionStreamEvent> {
      yield { sequence: 1, sessionId: "heartbeat", type: "session.heartbeat" }
    },

    waitForTurn: async (sessionId: string, turnId: string): Promise<SessionItem> => {
      const session = sessions.get(sessionId)
      const turn = session?.turns.find(t => t.id === turnId)
      if (!turn) throw new Error(`[Session] Unknown turn: ${turnId}`)

      turn.status = "completed"
      turn.completedAt = new Date().toISOString()
      session!.activeTurnId = undefined
      session!.status = "ready"
      session!.runnerStatus = "idle"

      const item: SessionItem = {
        content: "fake-output",
        createdAt: new Date().toISOString(),
        id: `item-${turnId}-assistant`,
        role: "assistant",
        turnId,
      }
      const existing = sessionItems.get(sessionId) ?? []
      existing.push(item)
      sessionItems.set(sessionId, existing)

      return item
    },
  }
}

// ---- Helpers ----

const IMPLEMENT_DONE = formatAgentOutcome({
  outcome: "completed",
  summary: "实现完成",
})

const REVIEW_PASS = formatAgentOutcome({
  outcome: "completed",
  summary: "审查通过",
  review: { verdict: "pass" },
})

const IMPLEMENT_ASK = formatAgentOutcome({
  outcome: "needs_input",
  summary: "需要确认",
  request: {
    question: "请确认实现方案",
    options: [{ id: "yes", label: "是" }, { id: "no", label: "否" }],
    allowFreeform: false,
  },
})

const makeRuntime = (
  client: SessionClient & FakeClientResult,
  overrides: Partial<WorkflowRuntime> = {},
): WorkflowRuntime =>
  ({
    args: {},
    baseSha: undefined,
    config: {
      implementer: { agent: "codex", command: "codex", name: "impl" },
      maxReviewRounds: 4,
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
      implement: "Implement {{specPath}}",
      review: "Review {{specPath}} round {{round}}",
      revise: "Revise {{reviewOutput}}",
      reReview: "Re-review round {{round}}",
      postReviewCheck: "Post-check {{reviewStatus}}",
      controllerImplementer: "Controller {{controllerNotes}}",
      controllerReReview: "Re-review {{controllerNotes}}",
    },
    reviewerSession: undefined,
    sessionBaseUrl: "http://127.0.0.1:1",
    sessionClient: client,
    ...overrides,
  }) as WorkflowRuntime

const makeFakeAgent = (
  client: SessionClient,
  sessionId: string,
  responses: string[],
): WorkflowAgent => {
  let idx = 0
  return {
    sessionId,
    sendTaskAndWait: async (prompt: string) => {
      await client.sendMessage(sessionId, { content: prompt, eventId: `evt-${idx}` })
      const res = responses[idx] ?? responses[responses.length - 1] ?? IMPLEMENT_DONE
      idx += 1
      return res
    },
    stop: vi.fn(async () => undefined),
  }
}

// ---- Tests ----

describe("workflow session integration", () => {
  describe("agent-runtime session lifecycle", () => {
    it("creates implementer and reviewer sessions with distinct session IDs", async () => {
      const client = makeFakeSessionClient()
      const runtime = makeRuntime(client)

      const implAgent = makeFakeAgent(client, "impl-session", [IMPLEMENT_DONE])
      const revAgent = makeFakeAgent(client, "rev-session", [REVIEW_PASS])
      runtime.implementerSession = implAgent
      runtime.reviewerSession = revAgent

      expect(runtime.implementerSession.sessionId).toBe("impl-session")
      expect(runtime.reviewerSession.sessionId).toBe("rev-session")
      expect(runtime.implementerSession.sessionId).not.toBe(runtime.reviewerSession.sessionId)
    })

    it("sends prompts to correct session and each turn gets unique turnId", async () => {
      const client = makeFakeSessionClient()
      const runtime = makeRuntime(client)

      const implAgent = makeFakeAgent(client, "impl-session", [IMPLEMENT_DONE])
      const revAgent = makeFakeAgent(client, "rev-session", [REVIEW_PASS])
      runtime.implementerSession = implAgent
      runtime.reviewerSession = revAgent

      await implAgent.sendTaskAndWait("Implement login")
      await revAgent.sendTaskAndWait("Review login")

      const implMessages = client._log.filter(m => m.sessionId === "impl-session")
      const revMessages = client._log.filter(m => m.sessionId === "rev-session")

      expect(implMessages).toHaveLength(1)
      expect(implMessages[0].content).toBe("Implement login")
      expect(revMessages).toHaveLength(1)
      expect(revMessages[0].content).toBe("Review login")
      // 不同 session 的 turnId 不应相同
      expect(implMessages[0].turnId).not.toBe(revMessages[0].turnId)
    })

    it("assigns unique turnId per sendTaskAndWait call on same session", async () => {
      const client = makeFakeSessionClient()
      const runtime = makeRuntime(client)

      const agent = makeFakeAgent(client, "impl-session", [IMPLEMENT_DONE, IMPLEMENT_DONE, IMPLEMENT_DONE])

      await agent.sendTaskAndWait("prompt 1")
      await agent.sendTaskAndWait("prompt 2")
      await agent.sendTaskAndWait("prompt 3")

      const turns = client._log.filter(m => m.sessionId === "impl-session")
      expect(turns).toHaveLength(3)
      const ids = turns.map(t => t.turnId)
      expect(new Set(ids).size).toBe(3)
    })
  })

  describe("needs_input session flow", () => {
    it("re-prompts same session on needs_input then returns completed on continue", async () => {
      const client = makeFakeSessionClient()

      const agent = makeFakeAgent(client, "impl-session", [IMPLEMENT_ASK, IMPLEMENT_DONE])

      const firstOutput = await agent.sendTaskAndWait("Implement feature")
      const firstOutcome = JSON.parse(firstOutput)
      expect(firstOutcome.outcome).toBe("needs_input")

      const continueOutput = await agent.sendTaskAndWait(JSON.stringify({
        type: "user_decision",
        optionId: "yes",
      }))
      const continueOutcome = JSON.parse(continueOutput)
      expect(continueOutcome.outcome).toBe("completed")

      // 两条消息都在同一个 sessionId
      const sessionMessages = client._log.filter(m => m.sessionId === "impl-session")
      expect(sessionMessages).toHaveLength(2)
    })
  })

  describe("checkpoint buildCheckpointInput", () => {
    it("includes implementer and reviewer session IDs, excludes pane IDs", async () => {
      const client = makeFakeSessionClient()
      const runtime = makeRuntime(client)

      runtime.implementerSession = makeFakeAgent(client, "impl-sess-abc", [])
      runtime.reviewerSession = makeFakeAgent(client, "rev-sess-def", [])

      const { buildCheckpointInput } = await import("@src/workflow/types")
      const input = buildCheckpointInput(
        runtime, "/tmp/config.json", 2,
        "REVIEW_NEEDS_CHECK: test",
        { kind: "needs_check", cannotVerifySummary: "test", hasCannotVerify: true, passed: false },
        false, "/tmp/spec.md", 0,
        [{ title: "Test", specPath: "/tmp/spec.md" }],
      )

      expect(input.implementerSessionId).toBe("impl-sess-abc")
      expect(input.reviewerSessionId).toBe("rev-sess-def")
      expect(input.sessionBaseUrl).toBe("http://127.0.0.1:1")
      // 不暴露 pane id
      expect((input as Record<string, unknown>).implementerPane).toBeUndefined()
      expect((input as Record<string, unknown>).reviewerPane).toBeUndefined()
    })

    it("throws when session IDs are missing", async () => {
      const client = makeFakeSessionClient()
      const runtime = makeRuntime(client)
      // 不设置 implementerSession / reviewerSession

      const { buildCheckpointInput } = await import("@src/workflow/types")
      expect(() =>
        buildCheckpointInput(
          runtime, "/tmp/config.json", 1,
          "REVIEW_NEEDS_CHECK",
          { kind: "needs_check", cannotVerifySummary: null, hasCannotVerify: true, passed: false },
          false, "/tmp/spec.md", 0,
          [{ title: "x", specPath: "/tmp/x.md" }],
        ),
      ).toThrow(/session IDs are not available/)
    })
  })

  describe("stopRuntimeAgents cleanup", () => {
    it("logs warnings for both stop failures yet still resets both references", async () => {
      const logSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
      const client = makeFakeSessionClient()
      const runtime = makeRuntime(client)

      runtime.implementerSession = {
        sessionId: "s1",
        sendTaskAndWait: vi.fn(),
        stop: vi.fn().mockRejectedValue(new Error("impl broken")),
      }
      runtime.reviewerSession = {
        sessionId: "s2",
        sendTaskAndWait: vi.fn(),
        stop: vi.fn().mockRejectedValue(new Error("rev broken")),
      }

      await stopRuntimeAgents(runtime)

      expect(runtime.implementerSession).toBeUndefined()
      expect(runtime.reviewerSession).toBeUndefined()
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("implementer"))
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("reviewer"))

      logSpy.mockRestore()
    })

    it("handles mixed success/failure without losing successful cleanup", async () => {
      const client = makeFakeSessionClient()
      const runtime = makeRuntime(client)

      const implStop = vi.fn().mockResolvedValue(undefined)
      const revStop = vi.fn().mockRejectedValue(new Error("rev broken"))

      runtime.implementerSession = {
        sessionId: "s1",
        sendTaskAndWait: vi.fn(), stop: implStop,
      }
      runtime.reviewerSession = {
        sessionId: "s2",
        sendTaskAndWait: vi.fn(), stop: revStop,
      }

      await stopRuntimeAgents(runtime)

      expect(implStop).toHaveBeenCalledOnce()
      expect(revStop).toHaveBeenCalledOnce()
      expect(runtime.implementerSession).toBeUndefined()
      expect(runtime.reviewerSession).toBeUndefined()
    })

    it("handles undefined sessions without throwing", async () => {
      const client = makeFakeSessionClient()
      const runtime = makeRuntime(client)

      await expect(stopRuntimeAgents(runtime)).resolves.toBeUndefined()
      expect(runtime.implementerSession).toBeUndefined()
      expect(runtime.reviewerSession).toBeUndefined()
    })
  })

  describe("checkpoint version migration", () => {
    it("rejects v2 checkpoint with actionable migration message", async () => {
      const { readNeedsCheckCheckpoint } = await import("@src/review/checkpoint")
      const { mkdtemp, rm, writeFile } = await import("node:fs/promises")
      const os = await import("node:os")
      const path = await import("node:path")

      const dir = await mkdtemp(path.join(os.tmpdir(), "mini-orch-v2-reject-"))
      try {
        const v2 = {
          baseSha: "abc", cannotVerifySummary: null, configPath: "/tmp/wf.json",
          createdAt: new Date().toISOString(), hasGit: true,
          implementerPane: "old-pane-1", maxReviewRounds: 4, projectDir: "/tmp/proj",
          reviewOutput: "NEEDS_CHECK", reviewerPane: "old-pane-2",
          reuseCurrentPane: false, round: 1, version: 2,
          currentIssueIndex: 0, issues: [{ title: "x", specPath: "/tmp/x.md" }],
        }
        const filePath = path.join(dir, "v2.json")
        await writeFile(filePath, JSON.stringify(v2, null, 2), "utf8")

        await expect(readNeedsCheckCheckpoint(filePath)).rejects.toThrow(
          /checkpoint version 2/i,
        )
        await expect(readNeedsCheckCheckpoint(filePath)).rejects.toThrow(
          /Herdr pane IDs/i,
        )
      } finally {
        await rm(dir, { force: true, recursive: true })
      }
    })

    it("reads v3 checkpoint with session IDs correctly", async () => {
      const { writeNeedsCheckCheckpoint, readNeedsCheckCheckpoint, CHECKPOINT_VERSION } =
        await import("@src/review/checkpoint")
      const { mkdtemp, rm } = await import("node:fs/promises")
      const os = await import("node:os")
      const path = await import("node:path")

      const dir = await mkdtemp(path.join(os.tmpdir(), "mini-orch-v3-roundtrip-"))
      try {
        const input = {
          baseSha: "sha123", cannotVerifySummary: "cannot verify auth",
          configPath: "/tmp/wf.json", hasGit: true,
          implementerSessionId: "sess-impl-abc", maxReviewRounds: 3,
          projectDir: "/tmp/proj", reviewOutput: "NEEDS_CHECK output",
          reviewerSessionId: "sess-rev-def", reuseCurrentPane: false,
          round: 2, sessionBaseUrl: "http://127.0.0.1:9999",
          currentIssueIndex: 0,
          issues: [{ title: "Add login", specPath: "/tmp/spec.md" }],
        }
        const fp = await writeNeedsCheckCheckpoint(dir, input)
        const cp = await readNeedsCheckCheckpoint(fp)

        expect(cp.version).toBe(CHECKPOINT_VERSION)
        expect(cp.implementerSessionId).toBe("sess-impl-abc")
        expect(cp.reviewerSessionId).toBe("sess-rev-def")
        expect(cp.sessionBaseUrl).toBe("http://127.0.0.1:9999")
      } finally {
        await rm(dir, { force: true, recursive: true })
      }
    })
  })
})
