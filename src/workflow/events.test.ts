import { describe, expect, it, vi } from "vitest"

import {
  createWorkflowEventBus,
  type WorkflowEvent,
  type WorkflowSnapshot,
} from "./events.js"

describe("createWorkflowEventBus", () => {
  it("returns initial snapshot with default values", () => {
    const bus = createWorkflowEventBus()
    const snap = bus.getSnapshot()

    expect(snap.issueIndex).toBe(0)
    expect(snap.issueCount).toBe(0)
    expect(snap.issueTitle).toBe("")
    expect(snap.phase).toBe("idle")
    expect(snap.reviewRound).toBe(0)
    expect(snap.maxReviewRounds).toBe(0)
    expect(snap.implementerStatus).toBe("idle")
    expect(snap.reviewerStatus).toBe("idle")
    expect(snap.terminalState).toBeNull()
    expect(snap.needsInput).toBeNull()
    expect(snap.startedAt).toBeLessThanOrEqual(Date.now())
  })

  it("publishes and receives events via subscribe", async () => {
    const bus = createWorkflowEventBus()
    const received: WorkflowEvent[] = []

    bus.subscribe((event) => { received.push(event) })

    bus.publish({ type: "issue_change", issueIndex: 0, issueCount: 3, issueTitle: "First" })

    await new Promise((r) => setTimeout(r, 10))
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe("issue_change")
  })

  it("supports multiple subscribers", async () => {
    const bus = createWorkflowEventBus()
    const a: WorkflowEvent[] = []
    const b: WorkflowEvent[] = []

    bus.subscribe((e) => { a.push(e) })
    bus.subscribe((e) => { b.push(e) })

    bus.publish({ type: "phase_change", phase: "implement" })

    await new Promise((r) => setTimeout(r, 10))
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it("unsubscribe stops receiving events", async () => {
    const bus = createWorkflowEventBus()
    const received: WorkflowEvent[] = []

    const unsub = bus.subscribe((e) => { received.push(e) })
    bus.publish({ type: "phase_change", phase: "implement" })
    await new Promise((r) => setTimeout(r, 10))
    expect(received).toHaveLength(1)

    unsub()
    bus.publish({ type: "phase_change", phase: "review" })
    await new Promise((r) => setTimeout(r, 10))
    expect(received).toHaveLength(1) // no new event
  })

  it("updates snapshot on issue_change", () => {
    const bus = createWorkflowEventBus()

    bus.publish({ type: "issue_change", issueIndex: 2, issueCount: 5, issueTitle: "Auth" })

    const snap = bus.getSnapshot()
    expect(snap.issueIndex).toBe(2)
    expect(snap.issueCount).toBe(5)
    expect(snap.issueTitle).toBe("Auth")
  })

  it("updates snapshot on phase_change", () => {
    const bus = createWorkflowEventBus()

    bus.publish({ type: "phase_change", phase: "implement" })
    expect(bus.getSnapshot().phase).toBe("implement")

    bus.publish({ type: "phase_change", phase: "review" })
    expect(bus.getSnapshot().phase).toBe("review")
  })

  it("updates snapshot on review_round_change", () => {
    const bus = createWorkflowEventBus()

    bus.publish({ type: "review_round_change", round: 3, maxRounds: 8 })

    const snap = bus.getSnapshot()
    expect(snap.reviewRound).toBe(3)
    expect(snap.maxReviewRounds).toBe(8)
  })

  it("updates snapshot on agent_state_change", () => {
    const bus = createWorkflowEventBus()

    bus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })
    expect(bus.getSnapshot().implementerStatus).toBe("working")

    bus.publish({ type: "agent_state_change", agent: "reviewer", status: "completed" })
    expect(bus.getSnapshot().reviewerStatus).toBe("completed")
  })

  it("updates snapshot on needs_input and clears on resume", () => {
    const bus = createWorkflowEventBus()

    bus.publish({
      type: "needs_input",
      agent: "implementer",
      provider: "claude",
      reason: "Which approach?",
    })

    expect(bus.getSnapshot().needsInput).toEqual({
      agent: "implementer",
      provider: "claude",
      reason: "Which approach?",
    })

    bus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })
    expect(bus.getSnapshot().needsInput).toBeNull()
  })

  it("updates snapshot terminalState on complete/fail/pause", () => {
    const bus = createWorkflowEventBus()

    bus.publish({ type: "pause", reason: "needs_input" })
    expect(bus.getSnapshot().terminalState).toBe("paused")

    bus.publish({ type: "complete" })
    expect(bus.getSnapshot().terminalState).toBe("completed")

    const bus2 = createWorkflowEventBus()
    bus2.publish({ type: "fail", reason: "review failed" })
    expect(bus2.getSnapshot().terminalState).toBe("failed")
  })

  it("does not carry Blessed types in events", async () => {
    const bus = createWorkflowEventBus()
    const received: WorkflowEvent[] = []
    bus.subscribe((e) => { received.push(e) })

    bus.publish({ type: "issue_change", issueIndex: 0, issueCount: 1, issueTitle: "T" })
    bus.publish({ type: "phase_change", phase: "implement" })
    bus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })
    bus.publish({ type: "complete" })

    await new Promise((r) => setTimeout(r, 10))
    for (const event of received) {
      const serialized = JSON.stringify(event)
      expect(serialized).not.toContain("blessed")
      expect(serialized).not.toContain("Blessed")
      expect(serialized).not.toContain("Screen")
      expect(serialized).not.toContain("Widget")
    }
  })

  it("does not block agent monitoring when publishing", () => {
    const bus = createWorkflowEventBus()

    // subscriber that takes a long time
    bus.subscribe(() => {
      const start = Date.now()
      while (Date.now() - start < 50) { /* spin */ }
    })

    const start = Date.now()
    bus.publish({ type: "phase_change", phase: "implement" })
    const elapsed = Date.now() - start

    // publish returns immediately; subscriber runs asynchronously via queueMicrotask
    expect(elapsed).toBeLessThan(10)
  })

  it("isolates subscriber exceptions from other subscribers", async () => {
    const bus = createWorkflowEventBus()
    const received: WorkflowEvent[] = []

    bus.subscribe(() => { throw new Error("boom") })
    bus.subscribe((e) => { received.push(e) })

    bus.publish({ type: "phase_change", phase: "implement" })

    // wait for microtask queue to flush
    await new Promise((r) => setTimeout(r, 20))

    // second subscriber still receives the event despite first one throwing
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe("phase_change")
  })

  it("records elapsedMs in snapshot", async () => {
    const bus = createWorkflowEventBus()
    const snap1 = bus.getSnapshot()

    // small delay to ensure elapsed > 0
    await new Promise((r) => setTimeout(r, 10))

    bus.publish({ type: "phase_change", phase: "implement" })
    const snap2 = bus.getSnapshot()

    expect(snap2.elapsedMs).toBeGreaterThanOrEqual(snap1.elapsedMs)
    expect(snap2.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it("preserves event ordering", async () => {
    const bus = createWorkflowEventBus()
    const received: WorkflowEvent[] = []
    bus.subscribe((e) => { received.push(e) })

    bus.publish({ type: "issue_change", issueIndex: 0, issueCount: 1, issueTitle: "T" })
    bus.publish({ type: "phase_change", phase: "implement" })
    bus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })
    bus.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })
    bus.publish({ type: "phase_change", phase: "review" })
    bus.publish({ type: "complete" })

    // queueMicrotask callbacks are queued in order; wait for them to flush
    await new Promise((r) => setTimeout(r, 20))

    expect(received.map((e) => e.type)).toEqual([
      "issue_change",
      "phase_change",
      "agent_state_change",
      "agent_state_change",
      "phase_change",
      "complete",
    ])
  })

  it("reset clears snapshot to initial state", () => {
    const bus = createWorkflowEventBus()

    bus.publish({ type: "issue_change", issueIndex: 2, issueCount: 5, issueTitle: "Auth" })
    bus.publish({ type: "phase_change", phase: "review" })
    bus.publish({ type: "complete" })

    bus.reset()
    const snap = bus.getSnapshot()

    expect(snap.issueIndex).toBe(0)
    expect(snap.issueCount).toBe(0)
    expect(snap.phase).toBe("idle")
    expect(snap.terminalState).toBeNull()
  })
})

describe("WorkflowEventBus integration", () => {
  it("publishes events in correct order during a typical workflow", async () => {
    const bus = createWorkflowEventBus()
    const received: WorkflowEvent[] = []
    bus.subscribe((e) => { received.push(e) })

    // 模拟典型工作流事件序列
    bus.publish({ type: "issue_change", issueIndex: 0, issueCount: 3, issueTitle: "Auth" })
    bus.publish({ type: "phase_change", phase: "implement" })
    bus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })
    bus.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })
    bus.publish({ type: "phase_change", phase: "review" })
    bus.publish({ type: "review_round_change", round: 1, maxRounds: 8 })
    bus.publish({ type: "agent_state_change", agent: "reviewer", status: "working" })
    bus.publish({ type: "agent_state_change", agent: "reviewer", status: "completed" })
    bus.publish({ type: "complete" })

    await new Promise((r) => setTimeout(r, 20))

    expect(received.map((e) => e.type)).toEqual([
      "issue_change",
      "phase_change",
      "agent_state_change",
      "agent_state_change",
      "phase_change",
      "review_round_change",
      "agent_state_change",
      "agent_state_change",
      "complete",
    ])

    // 验证快照最终状态
    const snap = bus.getSnapshot()
    expect(snap.issueIndex).toBe(0)
    expect(snap.issueCount).toBe(3)
    expect(snap.issueTitle).toBe("Auth")
    expect(snap.phase).toBe("review")
    expect(snap.reviewRound).toBe(1)
    expect(snap.maxReviewRounds).toBe(8)
    expect(snap.implementerStatus).toBe("completed")
    expect(snap.reviewerStatus).toBe("completed")
    expect(snap.terminalState).toBe("completed")
  })

  it("publishes needs_input event with correct snapshot update", async () => {
    const bus = createWorkflowEventBus()
    const received: WorkflowEvent[] = []
    bus.subscribe((e) => { received.push(e) })

    bus.publish({ type: "issue_change", issueIndex: 1, issueCount: 5, issueTitle: "Dashboard" })
    bus.publish({ type: "phase_change", phase: "implement" })
    bus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })
    // agent_state_change 设置状态，needs_input 设置详情
    bus.publish({ type: "agent_state_change", agent: "implementer", status: "needs_input" })
    bus.publish({
      type: "needs_input",
      agent: "implementer",
      provider: "claude",
      reason: "Which database should I use?",
    })

    await new Promise((r) => setTimeout(r, 20))

    const snap = bus.getSnapshot()
    expect(snap.implementerStatus).toBe("needs_input")
    expect(snap.needsInput).toEqual({
      agent: "implementer",
      provider: "claude",
      reason: "Which database should I use?",
    })

    // 恢复后清除 needsInput
    bus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })
    expect(bus.getSnapshot().needsInput).toBeNull()
    expect(bus.getSnapshot().implementerStatus).toBe("working")
  })

  it("handles review loop with multiple rounds", async () => {
    const bus = createWorkflowEventBus()
    const received: WorkflowEvent[] = []
    bus.subscribe((e) => { received.push(e) })

    // Round 1: review fail
    bus.publish({ type: "phase_change", phase: "review" })
    bus.publish({ type: "review_round_change", round: 1, maxRounds: 8 })
    bus.publish({ type: "agent_state_change", agent: "reviewer", status: "working" })
    bus.publish({ type: "agent_state_change", agent: "reviewer", status: "completed" })
    bus.publish({ type: "phase_change", phase: "revise" })
    bus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })
    bus.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })

    // Round 2: review pass
    bus.publish({ type: "review_round_change", round: 2, maxRounds: 8 })
    bus.publish({ type: "agent_state_change", agent: "reviewer", status: "working" })
    bus.publish({ type: "agent_state_change", agent: "reviewer", status: "completed" })
    bus.publish({ type: "complete" })

    await new Promise((r) => setTimeout(r, 20))

    expect(received.map((e) => e.type)).toEqual([
      "phase_change",
      "review_round_change",
      "agent_state_change",
      "agent_state_change",
      "phase_change",
      "agent_state_change",
      "agent_state_change",
      "review_round_change",
      "agent_state_change",
      "agent_state_change",
      "complete",
    ])

    const snap = bus.getSnapshot()
    expect(snap.reviewRound).toBe(2)
    expect(snap.terminalState).toBe("completed")
  })
})

describe("WorkflowSnapshot", () => {
  it("includes all required fields per spec §11", () => {
    const bus = createWorkflowEventBus()
    const snap = bus.getSnapshot()

    // spec §11 必须包含的字段
    const requiredFields = [
      "issueIndex",
      "issueCount",
      "issueTitle",
      "phase",
      "reviewRound",
      "maxReviewRounds",
      "implementerStatus",
      "reviewerStatus",
      "elapsedMs",
      "needsInput",
      "terminalState",
      "startedAt",
    ]

    for (const field of requiredFields) {
      expect(snap).toHaveProperty(field)
    }
  })
})
