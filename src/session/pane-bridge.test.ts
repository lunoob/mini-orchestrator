import { beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("../agent/subprocess.js", () => ({
  runHerdr: vi.fn(),
  tryRunHerdr: vi.fn(),
}))

import { runHerdr, tryRunHerdr } from "../agent/subprocess.js"
import { createPaneBridge } from "./pane-bridge.js"

describe("PaneBridge", () => {
  beforeEach(() => {
    vi.mocked(runHerdr).mockReset()
    vi.mocked(tryRunHerdr).mockReset()
  })

  test("splits a pane and sends exactly one private runner bootstrap", async () => {
    vi.mocked(runHerdr)
      .mockResolvedValueOnce(JSON.stringify({ result: { pane: { pane_id: "pane-1" } } }))
      .mockResolvedValue("")

    const bridge = createPaneBridge()
    const paneId = await bridge.split("/tmp/project")
    await bridge.bootstrap(paneId, "node /tmp/internal-runner.js --config /tmp/runner.json")
    await bridge.bootstrap(paneId, "node /tmp/internal-runner.js --config /tmp/runner.json")

    expect(paneId).toBe("pane-1")
    expect(vi.mocked(runHerdr).mock.calls).toEqual([
      [["pane", "split", "--current", "--direction", "right", "--cwd", "/tmp/project", "--no-focus"]],
      [["pane", "send-text", "pane-1", "node /tmp/internal-runner.js --config /tmp/runner.json"]],
      [["pane", "send-keys", "pane-1", "enter"]],
    ])
  })

  test("closes only the requested pane and treats an already closed pane as success", async () => {
    vi.mocked(tryRunHerdr)
      .mockResolvedValueOnce({ code: 1, stderr: '..."pane_not_found"...', stdout: "" })
      .mockResolvedValueOnce({ code: 0, stderr: "", stdout: "" })

    const bridge = createPaneBridge()
    await expect(bridge.close("pane-1")).resolves.toBeUndefined()
    await expect(bridge.close("pane-2")).resolves.toBeUndefined()

    expect(vi.mocked(tryRunHerdr).mock.calls).toEqual([
      [["pane", "close", "pane-1"]],
      [["pane", "close", "pane-2"]],
    ])
  })

  test("reports a pane disappearing from Herdr", async () => {
    vi.mocked(runHerdr)
      .mockResolvedValueOnce(JSON.stringify({ result: { panes: [{ pane_id: "pane-1" }] } }))
      .mockResolvedValueOnce(JSON.stringify({ result: { panes: [] } }))
    const closed = vi.fn()
    const bridge = createPaneBridge()
    if (!bridge.watch) throw new Error("Expected pane watch support")
    const unwatch = bridge.watch("pane-1", closed, { pollIntervalMs: 1 })

    await expect.poll(() => closed.mock.calls.length, { timeout: 3_000 }).toBe(1)
    unwatch()
    expect(closed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/closed/i) }))
  })
})
