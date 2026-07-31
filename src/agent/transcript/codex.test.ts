import { describe, expect, it } from "vitest"

import { createCodexAdapter } from "./codex.js"

const processLine = createCodexAdapter().processLine

describe("Codex adapter", () => {
  it("emits working (no text) for task_started", () => {
    const line = { event_msg: { payload: { type: "task_started" } } }
    const result = processLine(line)
    expect(result).not.toBeUndefined()
    expect(result!.type).toBe("working")
    expect(result!.text).toBeUndefined()
  })

  it("emits completed with last_agent_message", () => {
    const line = {
      event_msg: {
        payload: { type: "task_complete", last_agent_message: "Done." },
      },
    }
    const result = processLine(line)
    expect(result).not.toBeUndefined()
    expect(result!.type).toBe("completed")
    expect(result!.text).toBe("Done.")
  })

  it("emits completed with cached agent_message fallback", () => {
    const adapter = createCodexAdapter()
    adapter.processLine({
      event_msg: { payload: { type: "agent_message", message: "Final result" } },
    })
    const result = adapter.processLine({
      event_msg: { payload: { type: "task_complete" } },
    })
    expect(result!.type).toBe("completed")
    expect(result!.text).toBe("Final result")
  })

  it("agent_message does not emit text in working events", () => {
    const result = processLine({
      event_msg: { payload: { type: "agent_message", message: "Mid-task" } },
    })
    expect(result!.type).toBe("working")
    expect(result!.text).toBeUndefined()
  })

  it("ignores non-event_msg lines", () => {
    expect(processLine({ type: "other" })).toBeUndefined()
  })

  it("ignores intermediate response_item events", () => {
    const line = { event_msg: { payload: { type: "response_item" } } }
    expect(processLine(line)).toBeUndefined()
  })

  it("emits failed for task_error with error message", () => {
    const line = {
      event_msg: {
        payload: { type: "task_error", error: "Model unavailable" },
      },
    }
    const result = processLine(line)
    expect(result).not.toBeUndefined()
    expect(result!.type).toBe("failed")
    expect(result!.reason).toContain("Model unavailable")
  })

  it("emits failed for task_failed with message", () => {
    const line = {
      event_msg: {
        payload: { type: "task_failed", message: "Task cancelled by user" },
      },
    }
    const result = processLine(line)
    expect(result!.type).toBe("failed")
    expect(result!.reason).toContain("Task cancelled by user")
  })

  it("emits failed for exception payload", () => {
    const line = {
      event_msg: {
        payload: { type: "exception", message: "Unexpected internal error" },
      },
    }
    const result = processLine(line)
    expect(result!.type).toBe("failed")
    expect(result!.reason).toContain("Unexpected internal error")
  })
})
