import { describe, expect, it } from "vitest"

import { createCursorAdapter } from "./cursor.js"

const processLine = createCursorAdapter().processLine

describe("Cursor adapter", () => {
  it("emits working (no text) for assistant message", () => {
    const line = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Working..." }] },
    }
    const result = processLine(line)
    expect(result).not.toBeUndefined()
    expect(result!.type).toBe("working")
    expect(result!.text).toBeUndefined()
  })

  it("emits needs_input for AskQuestion tool", () => {
    const line = {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use", name: "AskQuestion",
          input: { title: "Choose", questions: [{ question: "Which?", header: "Choice", options: [] }] },
        }],
      },
    }
    const result = processLine(line)
    expect(result).not.toBeUndefined()
    expect(result!.type).toBe("needs_input")
    expect(result!.question).toContain("Choose")
  })

  it("emits completed with text for turn_ended success", () => {
    const adapter = createCursorAdapter()
    adapter.processLine({
      type: "assistant", message: { content: [{ type: "text", text: "Result" }] },
    })
    const result = adapter.processLine({ type: "turn_ended", status: "success" })
    expect(result!.type).toBe("completed")
    expect(result!.text).toBe("Result")
  })

  it("emits failed for turn_ended error", () => {
    const result = processLine({ type: "turn_ended", status: "error" })
    expect(result).not.toBeUndefined()
    expect(result!.type).toBe("failed")
  })

  it("ignores non-assistant non-turn_ended lines", () => {
    expect(processLine({ type: "user" })).toBeUndefined()
  })
})
