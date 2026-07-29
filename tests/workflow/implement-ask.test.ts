import { describe, expect, it, vi } from "vitest"

import {
  ImplementAskAbortError,
  handleSessionImplementAskIfNeeded,
  type ImplementAskDeps,
} from "@src/workflow/implement-ask"

const askOutput = `---IMPLEMENT_RESULT_START---
STATUS: IMPLEMENT_ASK
---IMPLEMENT_RESULT_END---`

const doneOutput = `---IMPLEMENT_RESULT_START---
STATUS: IMPLEMENT_DONE
---IMPLEMENT_RESULT_END---`

const createDeps = (overrides: Partial<ImplementAskDeps> = {}): Pick<ImplementAskDeps, "log" | "promptContinue"> => ({
  log: vi.fn(),
  promptContinue: vi.fn(),
  ...overrides,
})

describe("handleSessionImplementAskIfNeeded", () => {
  it("returns original output when status is already done", async () => {
    const deps = createDeps()
    const continueTask = vi.fn<() => Promise<string>>()
    const result = await handleSessionImplementAskIfNeeded(doneOutput, "implement", continueTask, deps)

    expect(result).toBe(doneOutput)
    expect(deps.promptContinue).not.toHaveBeenCalled()
    expect(continueTask).not.toHaveBeenCalled()
  })

  it("prompts without printing implementer body, then continues on yes + DONE", async () => {
    const log = vi.fn()
    const deps = createDeps({
      log,
      promptContinue: vi.fn().mockResolvedValue(true),
    })
    const continueTask = vi.fn<() => Promise<string>>().mockResolvedValue(doneOutput)

    const result = await handleSessionImplementAskIfNeeded(askOutput, "implement", continueTask, deps)

    expect(result).toBe(doneOutput)
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("implementer 有问题需要确认"),
    )
    expect(log).toHaveBeenCalledWith(expect.stringContaining("implement"))
    expect(String(log.mock.calls[0]?.[0])).not.toContain("IMPLEMENT_ASK")
    expect(deps.promptContinue).toHaveBeenCalledOnce()
    expect(continueTask).toHaveBeenCalledOnce()
  })

  it("throws ImplementAskAbortError when user answers no", async () => {
    const deps = createDeps({
      promptContinue: vi.fn().mockResolvedValue(false),
    })
    const continueTask = vi.fn<() => Promise<string>>()

    await expect(
      handleSessionImplementAskIfNeeded(askOutput, "revise round 2", continueTask, deps),
    ).rejects.toBeInstanceOf(ImplementAskAbortError)

    expect(continueTask).not.toHaveBeenCalled()
  })

  it("re-prompts when yes still yields IMPLEMENT_ASK", async () => {
    const deps = createDeps({
      promptContinue: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true),
    })
    const continueTask = vi.fn<() => Promise<string>>()
      .mockResolvedValueOnce(askOutput)
      .mockResolvedValueOnce(doneOutput)

    const result = await handleSessionImplementAskIfNeeded(askOutput, "post-check", continueTask, deps)

    expect(result).toBe(doneOutput)
    expect(deps.promptContinue).toHaveBeenCalledTimes(2)
    expect(continueTask).toHaveBeenCalledTimes(2)
  })
})
