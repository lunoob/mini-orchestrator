import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./subprocess.js", () => ({
  runHerdr: vi.fn(),
  tryRunHerdr: vi.fn(),
}))

import { runHerdr, tryRunHerdr } from "./subprocess.js"
import type { AgentConfig } from "../types.js"
import { startAgentResumed } from "./index.js"

const makeAgent = (): AgentConfig => ({
  agent: "codex",
  name: "codex-implementer",
  command: "codex exec",
  integrationAgent: "codex",
})

const session = { resumeId: "resume-1", jsonl: "/tmp/session-1.jsonl" }

const settle = async <T>(promise: Promise<T>, stepMs: number, maxSteps: number) => {
  let done = false
  promise.then(
    () => { done = true },
    () => { done = true },
  )
  for (let i = 0; i < maxSteps && !done; i += 1) {
    await vi.advanceTimersByTimeAsync(stepMs)
  }
  await promise.catch(() => {})
}

describe("startAgentResumed retry", () => {
  const readyOutput = "Codex resume-1 /tmp/session-1.jsonl"
  const startingOutput = "Codex starting..."

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const mockHerdr = (overrides: {
    readOutputs?: () => string
    takenNames?: () => string[]
  } = {}) => {
    const readOutputs = overrides.readOutputs ?? (() => readyOutput)
    const takenNames = overrides.takenNames ?? (() => [])
    let splitCount = 0
    let lastPaneId = ""
    vi.mocked(runHerdr).mockImplementation(async (args) => {
      const [area, action] = args
      if (area === "pane" && action === "split") {
        lastPaneId = `pane-${++splitCount}`
        return JSON.stringify({ result: { pane: { pane_id: lastPaneId } } })
      }
      if (area === "agent" && action === "start") {
        return JSON.stringify({ result: { agent: { pane_id: lastPaneId } } })
      }
      if (area === "agent" && action === "read") {
        return readOutputs()
      }
      if (area === "agent" && action === "list") {
        return JSON.stringify({ result: { agents: takenNames().map((name) => ({ name })) } })
      }
      throw new Error(`unexpected herdr call: ${args.join(" ")}`)
    })
    vi.mocked(tryRunHerdr).mockResolvedValue({ code: 0, stderr: "", stdout: "" })
  }

  it("returns the pane id when the agent becomes ready on the first attempt", async () => {
    mockHerdr()
    const promise = startAgentResumed("/tmp/project", makeAgent(), session, { retryDelayMs: 0 })
    await settle(promise, 5_000, 10)

    await expect(promise).resolves.toBe("pane-1")
    // pane split + agent start + 1 次 ready read
    expect(runHerdr).toHaveBeenCalledTimes(3)
    expect(tryRunHerdr).not.toHaveBeenCalled()
  })

  it("closes the stale pane and retries until the agent becomes ready", async () => {
    let readCount = 0
    mockHerdr({ readOutputs: () => (readCount++ < 7 ? startingOutput : readyOutput) })
    const promise = startAgentResumed("/tmp/project", makeAgent(), session, { retryDelayMs: 0 })
    // 第一轮 6 次 read 全部不匹配 -> 失败关 pane；第二轮第 1 次 read 匹配
    await settle(promise, 5_000, 20)

    await expect(promise).resolves.toBe("pane-2")
    expect(tryRunHerdr).toHaveBeenCalledTimes(1) // 关闭第一轮的 pane
  })

  it("re-resolves a unique name on every retry attempt", async () => {
    let readCount = 0
    mockHerdr({
      readOutputs: () => (readCount++ < 13 ? startingOutput : readyOutput),
      takenNames: () => ["codex-implementer"],
    })
    const promise = startAgentResumed(
      "/tmp/project", makeAgent(), session,
      { ensureUniqueName: true, retryDelayMs: 0 },
    )
    // 前两轮 6+6 次 read 失败，第三轮第 1 次 read 匹配
    await settle(promise, 5_000, 40)

    await expect(promise).resolves.toBe("pane-3")
    const starts = vi.mocked(runHerdr).mock.calls.filter(([args]) => args[1] === "start")
    expect(starts.map(([args]) => args[2])).toEqual([
      "codex-implementer-1",
      "codex-implementer-1",
      "codex-implementer-1",
    ])
    expect(tryRunHerdr).toHaveBeenCalledTimes(2)
  })

  it("throws the last error when all three attempts fail", async () => {
    mockHerdr({ readOutputs: () => startingOutput })
    const promise = startAgentResumed("/tmp/project", makeAgent(), session, { retryDelayMs: 0 })
    await settle(promise, 5_000, 40)

    await expect(promise).rejects.toThrow(/Agent CLI 启动失败/)
    expect(tryRunHerdr).toHaveBeenCalledTimes(3)
  })
})
