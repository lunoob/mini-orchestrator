import { describe, expect, it, vi } from "vitest"

import {
  defaultStatusWaitDeps,
  isAgentCompleteStatus,
  parseAgentStatus,
  waitForAgentStatusEvent,
  waitForAgentStatusWithPolling,
  type StatusWaitDeps,
} from "./status-wait.js"

const agentList = (paneId: string, agentStatus: string) =>
  JSON.stringify({
    id: "1",
    result: {
      agents: [{ pane_id: paneId, agent_status: agentStatus }],
      type: "agent_list",
    },
  })

describe("parseAgentStatus", () => {
  it("returns agent_status for matching pane", () => {
    expect(parseAgentStatus(agentList("p1", "working"), "p1")).toBe("working")
  })

  it("returns undefined when pane is missing", () => {
    expect(parseAgentStatus(agentList("p1", "idle"), "p2")).toBeUndefined()
  })
})

describe("isAgentCompleteStatus", () => {
  it("accepts idle and done", () => {
    expect(isAgentCompleteStatus("idle")).toBe(true)
    expect(isAgentCompleteStatus("done")).toBe(true)
  })

  it("rejects working", () => {
    expect(isAgentCompleteStatus("working")).toBe(false)
  })
})

describe("waitForAgentStatusWithPolling", () => {
  const makeDeps = (overrides: Partial<StatusWaitDeps>): StatusWaitDeps => {
    const base = defaultStatusWaitDeps()
    let now = 0
    return {
      ...base,
      eventChunkMs: 5,
      pollIntervalMs: 2,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      ...overrides,
    }
  }

  it("returns when poll sees target status on first read", async () => {
    const readStatus = vi.fn().mockResolvedValue("idle")
    const tryWait = vi.fn()

    await waitForAgentStatusWithPolling("p1", "idle", 10_000, makeDeps({ readStatus, tryWait }))

    expect(readStatus).toHaveBeenCalledWith("p1")
    expect(tryWait).not.toHaveBeenCalled()
  })

  it("returns when poll sees any complete status", async () => {
    const readStatus = vi.fn().mockResolvedValue("done")
    const tryWait = vi.fn()

    await waitForAgentStatusWithPolling(
      "p1",
      ["idle", "done"],
      10_000,
      makeDeps({ readStatus, tryWait }),
    )

    expect(readStatus).toHaveBeenCalledWith("p1")
    expect(tryWait).not.toHaveBeenCalled()
  })

  it("returns when event wait succeeds before poll matches", async () => {
    let reads = 0
    const readStatus = vi.fn().mockImplementation(async () => {
      reads += 1
      return reads === 1 ? "working" : "idle"
    })
    const tryWait = vi.fn().mockResolvedValue(true)

    await waitForAgentStatusWithPolling("p1", "idle", 10_000, makeDeps({ readStatus, tryWait }))

    expect(tryWait).toHaveBeenCalled()
  })

  it("keeps polling until target status appears", async () => {
    let reads = 0
    const readStatus = vi.fn().mockImplementation(async () => {
      reads += 1
      return reads >= 3 ? "working" : "idle"
    })
    const tryWait = vi.fn().mockResolvedValue(false)

    await waitForAgentStatusWithPolling("p1", "working", 10_000, makeDeps({ readStatus, tryWait }))

    expect(readStatus.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it("throws after timeout", async () => {
    const readStatus = vi.fn().mockResolvedValue("idle")
    const tryWait = vi.fn().mockResolvedValue(false)

    await expect(
      waitForAgentStatusWithPolling("p1", "working", 20, makeDeps({ readStatus, tryWait })),
    ).rejects.toThrow(/Timed out waiting for pane p1/)
  })
})
