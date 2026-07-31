import { describe, expect, it } from "vitest"

import { isProtocolError, parseOutcome } from "../lib/outcome-parser.js"
import { stripAgentOutcome } from "../lib/utils.js"
import { buildTestStatusPrompt, loadImplementOutputFormat } from "./test-status.js"

/** Helper: unwrap ParseResult */
const unwrap = (result: ReturnType<typeof parseOutcome>) => {
  if (isProtocolError(result)) throw new Error(`Protocol error: ${result.reason}`)
  return result
}

describe("testStatus prompt and output parsing", () => {
  it("appends implement-output format with JSON outcome instructions", async () => {
    const outputFormat = await loadImplementOutputFormat()
    const prompt = buildTestStatusPrompt(outputFormat)

    expect(prompt).toContain("查询今天佛山天气")
    expect(outputFormat).toContain("outcome")
    expect(outputFormat).toContain("completed")
  })

  it("parses implement outcome from JSON output", () => {
    const raw = '{"outcome":"completed","summary":"done"}'

    const r = unwrap(parseOutcome(raw, "implementer"))
    const printable = stripAgentOutcome(raw)

    expect(r.outcome).toBe("completed")
    // P2-5: 没有 report 时用 summary 作为 fallback
    expect(printable).toBe("done")
  })

  it("parses needs_input from JSON output", () => {
    const raw = '{"outcome":"needs_input","summary":"q","request":{"question":"Which?","allowFreeform":true}}'
    const r = unwrap(parseOutcome(raw, "implementer"))
    expect(r.outcome).toBe("needs_input")
    if (r.outcome === "needs_input") {
      expect(r.request.question).toBe("Which?")
    }
  })

  it("extracts JSON from text with other content (trailing JSON)", () => {
    const raw = '佛山今天多云\n{"outcome":"completed","summary":"done"}'
    const r = parseOutcome(raw, "implementer")
    // P1-2: 支持从文本末尾提取 JSON
    expect(isProtocolError(r)).toBe(false)
    const printable = stripAgentOutcome(raw)
    expect(printable).toContain("佛山今天多云")
  })

  it("extracts JSON from multi-line explanation text", () => {
    const raw = `Here's what I did:
1. Created the file
2. Ran tests
3. All tests pass

{"outcome":"completed","summary":"Implementation complete"}`
    const r = parseOutcome(raw, "implementer")
    expect(isProtocolError(r)).toBe(false)
    if (!isProtocolError(r)) {
      expect(r.outcome).toBe("completed")
      expect(r.summary).toBe("Implementation complete")
    }
  })

  it("extracts needs_input JSON from explanatory text", () => {
    const raw = `I need clarification on this:

{"outcome":"needs_input","summary":"Need user input","request":{"question":"Which approach?","options":[{"id":"a","label":"Option A"},{"id":"b","label":"Option B"}],"allowFreeform":false}}`
    const r = parseOutcome(raw, "implementer")
    expect(isProtocolError(r)).toBe(false)
    if (!isProtocolError(r) && r.outcome === "needs_input") {
      expect(r.request.question).toBe("Which approach?")
      expect(r.request.options).toHaveLength(2)
    }
  })
})
