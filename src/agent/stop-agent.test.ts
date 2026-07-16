import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./subprocess.js", () => ({
  runHerdr: vi.fn(),
  tryRunHerdr: vi.fn(),
}))

import { tryRunHerdr } from "./subprocess.js"
import { isPaneNotFoundError, stopAgent } from "./index.js"

describe("isPaneNotFoundError", () => {
  it("detects pane_not_found JSON from herdr", () => {
    expect(
      isPaneNotFoundError(
        '{"error":{"code":"pane_not_found","message":"pane wJ:p13 not found"},"id":"cli:pane:close"}',
      ),
    ).toBe(true)
  })

  it("returns false for other errors", () => {
    expect(isPaneNotFoundError("permission denied")).toBe(false)
  })
})

describe("stopAgent", () => {
  beforeEach(() => {
    vi.mocked(tryRunHerdr).mockReset()
  })

  it("resolves when pane close succeeds", async () => {
    vi.mocked(tryRunHerdr).mockResolvedValue({ code: 0, stderr: "", stdout: "" })
    await expect(stopAgent("wJ:p1")).resolves.toBeUndefined()
  })

  it("ignores pane_not_found when closing", async () => {
    vi.mocked(tryRunHerdr).mockResolvedValue({
      code: 1,
      stderr: '{"error":{"code":"pane_not_found","message":"pane wJ:p13 not found"},"id":"cli:pane:close"}',
      stdout: "",
    })
    await expect(stopAgent("wJ:p13")).resolves.toBeUndefined()
  })

  it("throws on other close failures", async () => {
    vi.mocked(tryRunHerdr).mockResolvedValue({
      code: 1,
      stderr: "permission denied",
      stdout: "",
    })
    await expect(stopAgent("wJ:p1")).rejects.toThrow(/permission denied/)
  })
})
