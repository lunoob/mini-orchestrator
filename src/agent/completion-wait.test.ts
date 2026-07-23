import { describe, expect, it, vi } from "vitest"

import { waitForCompletionWithFallback } from "./completion-wait.js"

const doneOutput = (summary: string) => [
  "---IMPLEMENT_RESULT_START---",
  summary,
  "STATUS: IMPLEMENT_DONE",
  "---IMPLEMENT_RESULT_END---",
].join("\n")

describe("waitForCompletionWithFallback", () => {
  it("returns stable output with a legal status after the initial wait times out", async () => {
    const waitForStatus = vi.fn().mockRejectedValue(new Error("timed out"))
    const readOutput = vi.fn().mockResolvedValue(doneOutput("finished"))
    const sleep = vi.fn().mockResolvedValue(undefined)
    const log = vi.fn()

    const result = await waitForCompletionWithFallback("pane-1", {
      log,
      readOutput,
      sleep,
      waitForStatus,
    })

    expect(result).toBe(doneOutput("finished"))
    expect(waitForStatus).toHaveBeenCalledWith(3_600_000)
    expect(readOutput).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(5_000)
    expect(log).toHaveBeenCalledWith(
      "[Agent] Pane pane-1 等待 idle/done 已超时（3600000ms），正在使用输出稳定性兜底检查。",
    )
  })

  it("keeps waiting for ten minutes after a fallback snapshot changes", async () => {
    const waitForStatus = vi.fn()
      .mockRejectedValueOnce(new Error("timed out"))
      .mockResolvedValueOnce(undefined)
    const readOutput = vi.fn()
      .mockResolvedValueOnce(doneOutput("still writing"))
      .mockResolvedValueOnce(doneOutput("finished"))
    const sleep = vi.fn().mockResolvedValue(undefined)

    const result = await waitForCompletionWithFallback("pane-1", {
      log: vi.fn(),
      readOutput,
      sleep,
      waitForStatus,
    })

    expect(result).toBeUndefined()
    expect(waitForStatus).toHaveBeenNthCalledWith(1, 3_600_000)
    expect(waitForStatus).toHaveBeenNthCalledWith(2, 600_000)
  })
})
