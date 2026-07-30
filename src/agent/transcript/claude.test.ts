import { describe, expect, it } from "vitest"

import { createClaudeAdapter } from "./claude.js"

const processLine = createClaudeAdapter().processLine

describe("Claude adapter", () => {
  it("emits completed with text for end_turn", () => {
    const line = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello, world!" }],
        stop_reason: "end_turn",
      },
    }

    const result = processLine(line)
    expect(result).not.toBeUndefined()
    expect(result!.type).toBe("completed")
    expect(result!.text).toBe("Hello, world!")
  })

  it("emits working (no text) for tool_use stop_reason", () => {
    const line = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: {} }],
        stop_reason: "tool_use",
      },
    }

    const result = processLine(line)
    expect(result).not.toBeUndefined()
    expect(result!.type).toBe("working")
    expect(result!.text).toBeUndefined()
  })

  it("emits needs_input for AskUserQuestion tool", () => {
    const line = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "AskUserQuestion",
            input: {
              questions: [
                { question: "Which approach?", header: "Approach", options: [] },
              ],
            },
          },
        ],
        stop_reason: "tool_use",
      },
    }

    const result = processLine(line)
    expect(result).not.toBeUndefined()
    expect(result!.type).toBe("needs_input")
    expect(result!.question).toContain("Which approach?")
  })

  it("ignores non-assistant lines", () => {
    expect(processLine({ type: "user" })).toBeUndefined()
    expect(processLine({ type: "system" })).toBeUndefined()
  })

  it("ignores assistant without content", () => {
    const line = { type: "assistant", message: {} }
    expect(processLine(line)).toBeUndefined()
  })

  it("end_turn returns last accumulated text", () => {
    const adapter = createClaudeAdapter()
    // simulate tool_use (no text on working)
    adapter.processLine({
      type: "assistant",
      message: { content: [{ type: "text", text: "Part 1." }], stop_reason: "tool_use" },
    })
    // end_turn should return all accumulated text from this turn
    const result = adapter.processLine({
      type: "assistant",
      message: { content: [{ type: "text", text: "Part 2." }], stop_reason: "end_turn" },
    })
    expect(result!.type).toBe("completed")
    expect(result!.text).toBe("Part 2.")
  })
})
