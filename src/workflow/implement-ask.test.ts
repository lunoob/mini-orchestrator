import { describe, expect, it, vi } from "vitest"

import {
  ImplementAskAbortError,
  handleImplementAskIfNeeded,
  type ImplementAskDeps,
} from "./implement-ask.js"

const askOutput = `---IMPLEMENT_RESULT_START---
STATUS: IMPLEMENT_ASK
---IMPLEMENT_RESULT_END---`

const doneOutput = `---IMPLEMENT_RESULT_START---
STATUS: IMPLEMENT_DONE
---IMPLEMENT_RESULT_END---`

const createDeps = (overrides: Partial<ImplementAskDeps> = {}): ImplementAskDeps => ({
  log: vi.fn(),
  promptContinue: vi.fn(),
  readOutput: vi.fn(),
  waitAfterContinue: vi.fn(),
  ...overrides,
})

describe("handleImplementAskIfNeeded", () => {
  it("returns original output when status is already done", async () => {
    const deps = createDeps()
    const result = await handleImplementAskIfNeeded("pane-1", doneOutput, "implement", deps)

    expect(result).toBe(doneOutput)
    expect(deps.promptContinue).not.toHaveBeenCalled()
    expect(deps.waitAfterContinue).not.toHaveBeenCalled()
  })

  it("prompts without printing implementer body, then waits and continues on yes + DONE", async () => {
    const log = vi.fn()
    const deps = createDeps({
      log,
      promptContinue: vi.fn().mockResolvedValue(true),
      waitAfterContinue: vi.fn().mockResolvedValue(undefined),
      readOutput: vi.fn().mockResolvedValue(doneOutput),
    })

    const result = await handleImplementAskIfNeeded("pane-1", askOutput, "implement", deps)

    expect(result).toBe(doneOutput)
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("implementer 有问题需要确认"),
    )
    expect(log).toHaveBeenCalledWith(expect.stringContaining("implement"))
    expect(String(log.mock.calls[0]?.[0])).not.toContain("IMPLEMENT_ASK")
    expect(deps.promptContinue).toHaveBeenCalledOnce()
    expect(deps.waitAfterContinue).toHaveBeenCalledWith("pane-1")
    expect(deps.readOutput).toHaveBeenCalledWith("pane-1")
  })

  it("throws ImplementAskAbortError when user answers no", async () => {
    const deps = createDeps({
      promptContinue: vi.fn().mockResolvedValue(false),
    })

    await expect(
      handleImplementAskIfNeeded("pane-1", askOutput, "revise round 2", deps),
    ).rejects.toBeInstanceOf(ImplementAskAbortError)

    expect(deps.waitAfterContinue).not.toHaveBeenCalled()
    expect(deps.readOutput).not.toHaveBeenCalled()
  })

  it("re-prompts when yes still yields IMPLEMENT_ASK", async () => {
    const deps = createDeps({
      promptContinue: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true),
      waitAfterContinue: vi.fn().mockResolvedValue(undefined),
      readOutput: vi.fn().mockResolvedValueOnce(askOutput).mockResolvedValueOnce(doneOutput),
    })

    const result = await handleImplementAskIfNeeded("pane-1", askOutput, "post-check", deps)

    expect(result).toBe(doneOutput)
    expect(deps.promptContinue).toHaveBeenCalledTimes(2)
    expect(deps.waitAfterContinue).toHaveBeenCalledTimes(2)
  })
})
