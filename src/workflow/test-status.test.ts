import { describe, expect, it } from "vitest"

import {
  IMPLEMENT_RESULT_END,
  IMPLEMENT_RESULT_START,
} from "../lib/prompt-delimiters.js"
import { extractImplementResult, parseImplementStatus, stripStatusLines } from "../lib/utils.js"
import { buildTestStatusPrompt, loadImplementOutputFormat } from "./test-status.js"

describe("testStatus prompt and output parsing", () => {
  it("appends implement-output format with delimiters to the prompt", async () => {
    const outputFormat = await loadImplementOutputFormat()
    const prompt = buildTestStatusPrompt(outputFormat)

    expect(prompt).toContain("查询今天佛山天气")
    expect(prompt).toContain(IMPLEMENT_RESULT_START)
    expect(prompt).toContain(IMPLEMENT_RESULT_END)
    expect(outputFormat).toContain(IMPLEMENT_RESULT_START)
    expect(outputFormat).toContain(IMPLEMENT_RESULT_END)
  })

  it("strips delimiters and parses implement status like workflow", () => {
    const raw = [
      "some agent chatter",
      IMPLEMENT_RESULT_START,
      "佛山今天多云，气温 28°C。",
      "STATUS: IMPLEMENT_DONE",
      IMPLEMENT_RESULT_END,
    ].join("\n")

    const resultBody = extractImplementResult(raw)
    const status = parseImplementStatus(resultBody)
    const printable = stripStatusLines(resultBody)

    expect(resultBody).toContain("佛山今天多云")
    expect(resultBody).not.toContain(IMPLEMENT_RESULT_START)
    expect(resultBody).not.toContain(IMPLEMENT_RESULT_END)
    expect(status).toBe("done")
    expect(printable).toContain("佛山今天多云")
    expect(printable).not.toMatch(/STATUS:/)
  })
})
